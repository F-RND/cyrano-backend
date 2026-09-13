// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "./env.js";
import {
  sanitizeSessionIndex,
  type IndexedSession,
  type SessionIndex,
} from "./inbox-key.js";

/// The account inbox: a standing,
/// session-less channel that lets a connected agent PING the user unprompted —
/// "your cron job finished" — with no session or gateway running. One DO per
/// account (`idFromName(inboxKey)`): the idle client holds a WebSocket open to
/// it, and the agent POSTs pings that fan out to that socket. Pings the client
/// misses (asleep, offline) are queued with a TTL and flushed on reconnect, so
/// a ping fired at 3am still lands at 8am.
///
/// This is the inverse direction of the vocal gateway (agent -> user, not user
/// -> agent) and a NEW privacy posture — a standing egress connection while
/// idle — so the client gates it behind its own explicit opt-in, distinct from
/// per-session relay. The server side is dumb: it stores and forwards short
/// text pings, nothing more; no analysis, no transcript, no audio.
///
/// ORIGIN-PULL (documentation/PLAN-REMOTE.md option D, 2026-08-04)
///
/// The same standing socket is also the rendezvous for reading PAST sessions
/// without storing any of them here. A remote assistant asks for a session; we
/// forward the request down this socket; the device answers it from its own
/// local storage, through its own policy layer; we relay the answer and keep
/// none of it. The only thing at rest is a thin session INDEX (id, title,
/// times, tags) the device publishes so an assistant can choose a session by
/// name while the device is asleep.
///
/// Note what is deliberately NOT reused from the ping path above: its queue.
/// Origin-pull needs the pipe, not the store — a request whose device is
/// unreachable fails immediately and honestly rather than being held for later,
/// because "answer this in six hours" is not a thing an assistant can use, and
/// a queue of transcript requests would be the persistence layer this design
/// exists to avoid.

interface AgentPing {
  id: string;
  text: string;
  /** How the client should surface it. The user picked "always notify"
   * (docs), so today every tier notifies; the field is carried for forward
   * compatibility and per-ping labelling. */
  tier: "critical" | "ambient";
  /** Optional deep link the notification can open (e.g. a run's log page). */
  url?: string;
  /** Server receive time (ms). */
  at: number;
}

/** Hard caps so a chatty or misbehaving agent can't grow DO storage without
 * bound. Text is clamped, the queue is a ring, and anything older than the TTL
 * is dropped on the next push. */
const MAX_TEXT_CHARS = 500;
const MAX_URL_CHARS = 2048;
const MAX_QUEUE = 50;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // a week — long enough for a weekend

// ---- Origin-pull ----

/** How long a forwarded request waits for the device before giving up. Sized
 * well under an MCP client's own tool timeout so the assistant gets our named
 * `device_unreachable` rather than its own generic failure — the difference
 * between "your Mac is asleep" and "the tool broke". */
const ORIGIN_TIMEOUT_MS = 8_000;

/** Concurrent in-flight forwards per account. An abuse cap, not a meter
 * (PLAN-REMOTE.md, "abuse limits independent of entitlement"): the blast
 * radius of one leaked or misbehaving connector token is otherwise N parked
 * 8-second waiters here plus the same N reads fanned at the user's device.
 * Honest MCP clients issue a handful of sequential tool calls; a burst past
 * this cap is not a usage pattern to serve. */
const MAX_PENDING_ORIGIN = 8;

/** How long a stored index survives without the device checking back in, so an
 * abandoned account decays to nothing rather than leaving a list of someone's
 * meetings at rest forever. The count/length clamps live with the sanitizer in
 * ./inbox-key.ts, which is where they can be unit-tested. */
const INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1000; // a month without a check-in

/** Per-socket capability, stored via serializeAttachment so it survives
 * hibernation. A socket that has not advertised `origin` is a ping-only client
 * (an older build, or a device with origin-pull switched off) and must never be
 * handed a request it will not answer. */
interface SocketMeta {
  origin?: boolean;
  device?: string;
}

/** What the device sent back, or why nothing did. */
interface OriginReply {
  status: number;
  body: unknown;
  device?: string;
}

// ---- Free cold relay ----
//
// The origin-push counterpart of origin-pull above, for the device that cannot
// answer a live read: a suspended iPhone. The device answers IN ADVANCE — at
// session end it uploads the same curated payload its /context read would have
// served, and this DO holds it briefly so an assistant can read the session
// once it has gone cold. Everything here is deliberately the opposite of a
// transcript store: opt-in per upload, already curated by the device's own
// policy layer, hard-capped in size and count, and gone within a day.

/** How long after its last transcribed audio a stored session may be served —
 * the free plan's hot window, mirroring `MCPAccessPolicy.hotWindow` on the
 * device. Enforced HERE, not at upload: the phone pushes at session end (the
 * only moment it is reliably awake), so the copy sits unreadable until cold. */
export const SNAPSHOT_COLD_AFTER_MS = 45 * 60 * 1000;
/** The at-rest ceiling. A snapshot that would outlive this is clamped, and a
 * client-declared retention shorter than this wins (`retention_hours`). */
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
/** Per-snapshot payload cap. Refused, not truncated: a silently trimmed
 * session would read as complete to the assistant, which is worse than the
 * client trimming its own tail knowingly before upload. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
/** Per-account count and total-bytes caps; the oldest snapshot is evicted
 * first. Bounds one identity's storage no matter what a script pushes. */
export const MAX_SNAPSHOTS = 20;
export const MAX_SNAPSHOT_TOTAL_BYTES = 2 * 1024 * 1024;

/** The assistant-facing refusal for a stored-but-still-hot session. Same rule
 * the device's own bridge states, phrased for the free plan that this path
 * exists for. */
export const HOT_SNAPSHOT_MESSAGE =
  "This session is still inside the free plan's 45-minute wait after its last transcribed audio. It becomes readable once it cools down; reading a live session is part of Cyrano Pro.";

interface StoredSnapshot {
  id: string;
  /** The serialized session payload, stored as the exact string the caps were
   * measured against. Opaque here: the device built it through its own policy
   * layer (sharing scope, tags, retention, personal-info overlay), and a
   * second policy layer server-side would be one that drifts. */
  body: string;
  row: IndexedSession;
  last_transcribed_at: number;
  stored_at: number;
  expires_at: number;
  bytes: number;
  device?: string;
}

export class AccountInboxDO implements DurableObject {
  /** In-flight origin requests, keyed by request id. In memory on purpose: a
   * pending `fetch` keeps this object active, so the reply lands on the same
   * instance. If the object IS evicted mid-flight the waiter is simply gone and
   * the caller times out — which is the correct outcome, since the device's
   * answer would be arriving for a request nobody is holding open any more. */
  private readonly pendingOrigin = new Map<string, (value: OriginReply) => void>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Client stream: the idle app holds this WebSocket open. Router already
    // authenticated the caller and confirmed this DO is their own inbox.
    if (request.headers.get("upgrade") === "websocket" && url.pathname.endsWith("/stream")) {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      // The backlog is flushed when the client sends `{ ready: 1 }` (see
      // webSocketMessage), not here: sending in the same request that upgrades
      // the socket races the handshake under WS hibernation, and the client
      // controlling the timing is robust to it.
      return new Response(null, { status: 101, webSocket: client });
    }

    // Agent push: enqueue + fan out to any connected client sockets.
    if (request.method === "POST" && url.pathname.endsWith("/push")) {
      return this.handlePush(request);
    }

    // Origin-pull: forward one read to the device and relay its answer.
    if (request.method === "POST" && url.pathname.endsWith("/origin")) {
      return this.handleOrigin(request);
    }

    // The cached session index — device-published rows merged with any stored
    // free-cold snapshots — plus whether the device could answer for real
    // right now. Served even with no device connected — that is the whole point
    // of caching it.
    if (request.method === "GET" && url.pathname.endsWith("/index")) {
      const index = await this.mergedIndex();
      return Response.json({
        index,
        device_online: this.originSockets().length > 0,
      });
    }

    // Free cold relay: accept one finished session's snapshot…
    if (request.method === "POST" && url.pathname.endsWith("/snap")) {
      return this.handleSnapshotPut(request);
    }
    // …and drop one (or all) when the user deletes, hides, or opts out.
    if (request.method === "POST" && url.pathname.endsWith("/snap-delete")) {
      return this.handleSnapshotDelete(request);
    }

    return new Response("not found", { status: 404 });
  }

  /** TTL sweep. Armed on every snapshot write; deletes what has expired and
   * re-arms for the next expiry, so an abandoned account decays to nothing
   * without waiting for a read to notice. */
  async alarm(): Promise<void> {
    await this.liveSnapshots();
  }

  // ---- Origin-pull ----

  /** Sockets whose device advertised that it can answer reads. */
  private originSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const meta = (ws.deserializeAttachment() as SocketMeta | null) ?? {};
      return meta.origin === true;
    });
  }

  /**
   * Forward `{ method, path, query }` to the device and return what it says.
   *
   * The body we relay is whatever the device produced — this object never
   * inspects, reshapes, or stores it. That is not laziness: the device answered
   * through its own MCP router, so the response has already passed the sharing
   * scope, the tag gate, the Pro gate, retention, and the personal-info
   * overlay. Anything done to it here would be a second policy layer, and a
   * second policy layer is one that drifts out of step with the first.
   */
  private async handleOrigin(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      method?: unknown;
      path?: unknown;
      query?: unknown;
      client?: unknown;
    } | null;
    const path = typeof body?.path === "string" ? body.path : "";
    if (!path.startsWith("/")) {
      return Response.json({ error: "bad_path" }, { status: 400 });
    }
    if (this.pendingOrigin.size >= MAX_PENDING_ORIGIN) {
      return Response.json({ error: "too_many_requests" }, { status: 429 });
    }
    const sockets = this.originSockets();
    const socket = sockets[0];
    if (!socket) {
      // No device to ask — but the device may have answered in advance
      // (free cold relay): a stored snapshot serves the read, behind the same
      // hot window the device's own bridge would apply.
      const held = await this.snapshotAnswer(body);
      if (held) return Response.json(held);
      // Not an error — a named, expected state. The caller turns this into
      // `device_unreachable` so the assistant can say "your Mac is offline"
      // instead of reporting a broken tool.
      return Response.json({ device_online: false }, { status: 503 });
    }

    // First origin-capable socket wins. With a Mac and a phone both connected
    // this is arbitrary, which is a known v1 limitation — the reply carries the
    // device name so the answer at least says who spoke.
    const meta = (socket.deserializeAttachment() as SocketMeta | null) ?? {};
    const rid = crypto.randomUUID();

    const reply = await new Promise<OriginReply | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingOrigin.delete(rid);
        resolve(null);
      }, ORIGIN_TIMEOUT_MS);
      this.pendingOrigin.set(rid, (value) => {
        clearTimeout(timer);
        this.pendingOrigin.delete(rid);
        resolve(value);
      });
      try {
        socket.send(
          JSON.stringify({
            type: "origin_request",
            rid,
            method: typeof body?.method === "string" ? body.method : "GET",
            path,
            query: (body?.query ?? {}) as Record<string, string>,
            client: typeof body?.client === "string" ? body.client : null,
            deadline_ms: ORIGIN_TIMEOUT_MS,
          }),
        );
      } catch {
        clearTimeout(timer);
        this.pendingOrigin.delete(rid);
        resolve(null);
      }
    });

    if (!reply) {
      return Response.json({ device_online: true, timed_out: true }, { status: 504 });
    }
    return Response.json({
      status: reply.status,
      body: reply.body,
      device: reply.device ?? meta.device ?? null,
    });
  }

  /** The stored index, dropped if the device has not checked in within the TTL
   * so an abandoned account stops holding a list of someone's meetings. */
  private async liveIndex(): Promise<SessionIndex | null> {
    const index = await this.ctx.storage.get<SessionIndex>("index");
    if (!index) return null;
    if (Date.now() - index.built_at > INDEX_TTL_MS) {
      await this.ctx.storage.delete("index");
      return null;
    }
    return index;
  }

  /** Accept a published index, clamped by the shared sanitizer. Trusted only as
   * metadata: it is never used to authorize a read, since every read is
   * answered by the device itself. */
  private async storeIndex(raw: unknown, device: string | undefined): Promise<void> {
    await this.ctx.storage.put("index", sanitizeSessionIndex(raw, device, Date.now()));
  }

  // ---- Free cold relay (origin-push) ----

  /** Every unexpired snapshot, oldest first — sweeping what has expired and
   * re-arming the alarm for the next expiry as it goes. The one place expiry
   * is decided, so a read, the index, and the alarm can't disagree. */
  private async liveSnapshots(): Promise<StoredSnapshot[]> {
    const now = Date.now();
    const stored = await this.ctx.storage.list<StoredSnapshot>({ prefix: "snap:" });
    const live: StoredSnapshot[] = [];
    let nextExpiry: number | null = null;
    for (const [key, snap] of stored) {
      if (snap.expires_at <= now) {
        await this.ctx.storage.delete(key);
      } else {
        live.push(snap);
        if (nextExpiry === null || snap.expires_at < nextExpiry) nextExpiry = snap.expires_at;
      }
    }
    if (nextExpiry !== null) await this.ctx.storage.setAlarm(nextExpiry);
    live.sort((a, b) => a.stored_at - b.stored_at);
    return live;
  }

  /** The device-published index merged with stored-snapshot rows. Device rows
   * win on an id collision — the device's copy is fresher and fuller, and a
   * live device serves the read anyway. Stored rows follow, newest first,
   * flagged `stored` so the assistant knows a held copy answers for them.
   *
   * A STILL-HOT SNAPSHOT IS NOT LISTED AT ALL. The row is not inert metadata:
   * it carries the session's title and its tags, which is exactly the sort of
   * thing a title names ("Severance discussion with HR"). Gating only the BODY
   * in `snapshotAnswer` and listing the row anyway would have made the hot
   * window a rule about transcripts rather than about sessions, and it would
   * have contradicted what the device tells the user in as many words — "it
   * can read finished sessions once each has cooled down". The row appears the
   * moment the same clock says the body may be served, so nothing is lost, and
   * both halves read `SNAPSHOT_COLD_AFTER_MS` off the same stamp. */
  private async mergedIndex(): Promise<SessionIndex | null> {
    const live = await this.liveIndex();
    const now = Date.now();
    const snaps = (await this.liveSnapshots()).filter(
      (s) => now - s.last_transcribed_at >= SNAPSHOT_COLD_AFTER_MS,
    );
    if (snaps.length === 0) return live;
    const seen = new Set((live?.sessions ?? []).map((s) => s.id));
    const storedRows = snaps
      .filter((s) => !seen.has(s.id))
      .map((s): IndexedSession => ({ ...s.row, stored: true }))
      .sort((a, b) => b.started_at - a.started_at);
    if (storedRows.length === 0) return live;
    return {
      sessions: [...(live?.sessions ?? []), ...storedRows],
      built_at: live?.built_at ?? Math.max(...snaps.map((s) => s.stored_at)),
      ...(live?.device ? { device: live.device } : {}),
      ...(live?.scope ? { scope: live.scope } : {}),
    };
  }

  /** Answer a forwarded read from a stored snapshot, or null when this request
   * isn't one a snapshot can answer. Shapes match what a live device would
   * have sent through the socket, so the caller (and the MCP surface above it)
   * cannot tell the difference — including the refusal: a still-hot session
   * returns the same `{status, body:{error}}` a device's own Pro gate uses. */
  private async snapshotAnswer(
    body: { method?: unknown; path?: unknown; query?: unknown } | null,
  ): Promise<OriginReply | null> {
    const method = typeof body?.method === "string" ? body.method : "GET";
    if (method !== "GET" || body?.path !== "/context") return null;
    const query = (body?.query ?? {}) as Record<string, unknown>;
    const sessionId = typeof query.session === "string" ? query.session : "";
    if (!sessionId) return null;

    const snap = await this.ctx.storage.get<StoredSnapshot>(`snap:${sessionId}`);
    if (!snap) return null;
    const now = Date.now();
    if (snap.expires_at <= now) {
      await this.ctx.storage.delete(`snap:${sessionId}`);
      return null;
    }
    if (now - snap.last_transcribed_at < SNAPSHOT_COLD_AFTER_MS) {
      return {
        status: 403,
        body: { error: HOT_SNAPSHOT_MESSAGE },
        ...(snap.device ? { device: snap.device } : {}),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(snap.body);
    } catch {
      // A copy that no longer parses is a copy that no longer exists.
      await this.ctx.storage.delete(`snap:${sessionId}`);
      return null;
    }
    return { status: 200, body: parsed, ...(snap.device ? { device: snap.device } : {}) };
  }

  /** Accept one finished session's snapshot. The router already scoped the
   * caller to its own inbox and the free-cold plan; this end owns the caps. */
  private async handleSnapshotPut(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      session?: unknown;
      index_row?: unknown;
      last_transcribed_at?: unknown;
      retention_hours?: unknown;
      device?: unknown;
    } | null;

    // The row is the id's source of truth; run it through the same sanitizer a
    // published index gets, so a junk row is dropped here rather than becoming
    // an unfetchable index entry later.
    const sanitized = sanitizeSessionIndex({ sessions: [body?.index_row] }, undefined, Date.now());
    const row = sanitized.sessions[0];
    if (!row) {
      return Response.json({ error: "bad_index_row" }, { status: 400 });
    }
    delete row.running; // a finished session is the only kind that uploads
    if (body?.session === undefined || body.session === null) {
      return Response.json({ error: "missing_session" }, { status: 400 });
    }
    const lastTranscribed =
      typeof body.last_transcribed_at === "number" && Number.isFinite(body.last_transcribed_at)
        ? // Clock skew must not shorten the wait: a stamp from the future is
          // treated as "just now", never as already cold.
          Math.min(body.last_transcribed_at, Date.now())
        : null;
    if (lastTranscribed === null) {
      return Response.json({ error: "missing_last_transcribed_at" }, { status: 400 });
    }
    const now = Date.now();
    // No floor under how far back the stamp may sit, deliberately. A floor was
    // tried and removed; the reasoning, so it isn't re-added:
    //
    // The stamp is the last TRANSCRIBED audio, not session end
    // (FreeColdRelay.swift). A session whose tail was silence is MEANT to
    // arrive already cold, and free-cold.test.ts asserts exactly that with a
    // stamp 46 minutes older than its upload. So a floor below
    // SNAPSHOT_COLD_AFTER_MS breaks a tested contract, and a floor at or above
    // it bounds nothing — there is no value that does both.
    //
    // What that leaves unbounded is a modified client backdating itself to an
    // immediate read. That is a device owner self-downgrading their OWN
    // snapshot: the inbox is self-scoped, so it reaches no one else's data and
    // spends nothing. Not worth breaking the feature to prevent. Server-side
    // session activity would gate it honestly if it ever becomes worth gating.

    const serialized = JSON.stringify(body.session);
    const bytes = new TextEncoder().encode(serialized).length;
    if (bytes > MAX_SNAPSHOT_BYTES) {
      // Refused, not truncated — the client trims its own tail knowingly.
      return Response.json({ error: "too_large", max_bytes: MAX_SNAPSHOT_BYTES }, { status: 413 });
    }

    const retentionMs =
      typeof body.retention_hours === "number" && Number.isFinite(body.retention_hours)
        ? Math.min(Math.max(body.retention_hours, 1), 24) * 60 * 60 * 1000
        : SNAPSHOT_TTL_MS;
    const snap: StoredSnapshot = {
      id: row.id,
      body: serialized,
      row,
      last_transcribed_at: lastTranscribed,
      stored_at: now,
      expires_at: now + Math.min(retentionMs, SNAPSHOT_TTL_MS),
      bytes,
      ...(typeof body.device === "string" && body.device ? { device: body.device.slice(0, 80) } : {}),
    };

    // Enforce count and total-bytes caps, oldest evicted first. A re-upload of
    // the same session replaces its own copy rather than counting twice.
    const existing = (await this.liveSnapshots()).filter((s) => s.id !== snap.id);
    let total = existing.reduce((sum, s) => sum + s.bytes, 0) + snap.bytes;
    let count = existing.length + 1;
    for (const oldest of existing) {
      if (count <= MAX_SNAPSHOTS && total <= MAX_SNAPSHOT_TOTAL_BYTES) break;
      await this.ctx.storage.delete(`snap:${oldest.id}`);
      total -= oldest.bytes;
      count -= 1;
    }

    await this.ctx.storage.put(`snap:${snap.id}`, snap);
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || snap.expires_at < currentAlarm) {
      await this.ctx.storage.setAlarm(snap.expires_at);
    }
    return Response.json({ ok: true, id: snap.id, expires_at: snap.expires_at, stored: count });
  }

  /** Drop one snapshot (`{id}`) or every one (`{all:true}`) — the revocation
   * choke point deletion, tag-hiding, scope-narrowing, and opting out all call
   * through. Deleting what is already gone is success, not an error. */
  private async handleSnapshotDelete(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      id?: unknown;
      all?: unknown;
    } | null;
    if (body?.all === true) {
      const stored = await this.ctx.storage.list<StoredSnapshot>({ prefix: "snap:" });
      for (const key of stored.keys()) await this.ctx.storage.delete(key);
      return Response.json({ ok: true, deleted: stored.size });
    }
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id) return Response.json({ error: "missing_id" }, { status: 400 });
    const key = `snap:${id}`;
    const existed = (await this.ctx.storage.get(key)) !== undefined;
    if (existed) await this.ctx.storage.delete(key);
    return Response.json({ ok: true, deleted: existed ? 1 : 0 });
  }

  private async handlePush(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      text?: unknown;
      tier?: unknown;
      url?: unknown;
      id?: unknown;
    } | null;
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_TEXT_CHARS) : "";
    if (!text) {
      return Response.json({ error: "empty_text" }, { status: 400 });
    }
    const tier = body?.tier === "critical" ? "critical" : "ambient";
    let link: string | undefined;
    if (typeof body?.url === "string" && body.url.length <= MAX_URL_CHARS) {
      try {
        const u = new URL(body.url);
        if (u.protocol === "http:" || u.protocol === "https:") link = body.url;
      } catch {
        // ignore a malformed url — the ping still delivers, just without a link
      }
    }
    // Agent-supplied id is honored for idempotency (a retried push is one ping);
    // otherwise mint one. crypto.randomUUID is available in the Workers runtime.
    // The id becomes a storage key, so hold it to a plain slug rather than
    // whatever an agent felt like sending.
    const id =
      typeof body?.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(body.id)
        ? body.id
        : crypto.randomUUID();

    // Idempotency has to cover DELIVERY, not just storage. Overwriting
    // `ping:<id>` kept the queue at one entry, but the fan-out below still ran
    // on every retry, so an agent that resent a push after a timeout buzzed
    // the user twice for one event. A ping we already hold is a no-op.
    const existing = await this.ctx.storage.get<AgentPing>(`ping:${id}`);
    if (existing) {
      return Response.json({ ok: true, id, delivered: 0, duplicate: true });
    }

    const ping: AgentPing = { id, text, tier, at: Date.now(), ...(link ? { url: link } : {}) };
    await this.enqueue(ping);

    // Fan out to every connected client socket. Hibernation-safe: sockets
    // survive DO eviction and getWebSockets() returns the live set.
    let delivered = 0;
    const frame = JSON.stringify({ type: "agent_ping", ping });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
        delivered++;
      } catch {
        // a dead socket the runtime hasn't reaped yet — the ping stays queued
      }
    }
    return Response.json({ ok: true, id, delivered });
  }

  /** Client messages. The original two: `{ ready: 1 }` on connect asks for the
   * backlog (every ping missed while away, oldest first), and `{ ack: id }`
   * drains a delivered ping so it never re-flushes on the next reconnect.
   *
   * Origin-pull adds `{ ready: 1, origin: 1, device }` to advertise that this
   * device will answer reads, `{ type: "session_index", ... }` to publish the
   * index, and `{ type: "origin_response", rid, status, body }` to answer a
   * forwarded request. */
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    let msg: {
      ack?: unknown;
      ready?: unknown;
      origin?: unknown;
      device?: unknown;
      type?: unknown;
      rid?: unknown;
      status?: unknown;
      body?: unknown;
      sessions?: unknown;
    };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }

    // A device answering a forwarded read. Resolve the waiter and stop — the
    // payload is relayed verbatim and never stored.
    if (msg.type === "origin_response" && typeof msg.rid === "string") {
      const resolve = this.pendingOrigin.get(msg.rid);
      const meta = (ws.deserializeAttachment() as SocketMeta | null) ?? {};
      resolve?.({
        status: typeof msg.status === "number" ? msg.status : 200,
        body: msg.body ?? null,
        ...(meta.device ? { device: meta.device } : {}),
      });
      return;
    }

    if (msg.type === "session_index") {
      const meta = (ws.deserializeAttachment() as SocketMeta | null) ?? {};
      // Only a socket that advertised origin capability may PUBLISH an index:
      // a ping-only client cannot answer the reads the index invites, so
      // letting it overwrite the cached list would show the assistant metadata
      // nobody can back. Retraction (an empty list) stays open to any socket —
      // the client toggles origin off by sending a no-origin ready frame and
      // THEN the clearing frame on the same socket, and dropping data is the
      // safe direction anyway.
      if (Array.isArray(msg.sessions) && msg.sessions.length > 0 && meta.origin !== true) return;
      await this.storeIndex(msg, meta.device);
      return;
    }

    if (msg.ready) {
      // Capability is declared on the same frame that asks for the backlog, so
      // a socket is never briefly "connected but unclassified" — a window in
      // which an origin request would have been dropped for no good reason.
      const existing = (ws.deserializeAttachment() as SocketMeta | null) ?? {};
      ws.serializeAttachment({
        ...existing,
        origin: msg.origin === true || msg.origin === 1,
        ...(typeof msg.device === "string" ? { device: msg.device.slice(0, 80) } : {}),
      } satisfies SocketMeta);

      for (const ping of await this.pendingPings()) {
        try {
          ws.send(JSON.stringify({ type: "agent_ping", ping }));
        } catch {
          break;
        }
      }
    }
    if (typeof msg.ack === "string") {
      await this.ctx.storage.delete(`ping:${msg.ack}`);
    }
  }

  async webSocketClose(): Promise<void> {
    // No per-socket state; the queue persists in storage for the next connect.
    // In-flight origin waiters are deliberately NOT failed here: a device that
    // drops mid-answer is indistinguishable from one that is slow, and the
    // timeout already covers both with the same honest outcome.
  }

  async webSocketError(): Promise<void> {
    // Same as close — nothing to clean up.
  }

  /** Store a ping, dropping anything past the TTL and trimming the oldest if
   * the ring is full, so storage stays bounded regardless of agent volume. */
  private async enqueue(ping: AgentPing): Promise<void> {
    const now = Date.now();
    const existing = await this.ctx.storage.list<AgentPing>({ prefix: "ping:" });
    const live: AgentPing[] = [];
    for (const [key, p] of existing) {
      if (now - p.at > TTL_MS) {
        await this.ctx.storage.delete(key);
      } else {
        live.push(p);
      }
    }
    // Trim oldest if adding this one would exceed the cap.
    live.sort((a, b) => a.at - b.at);
    while (live.length >= MAX_QUEUE) {
      const oldest = live.shift();
      if (oldest) await this.ctx.storage.delete(`ping:${oldest.id}`);
    }
    await this.ctx.storage.put(`ping:${ping.id}`, ping);
  }

  private async pendingPings(): Promise<AgentPing[]> {
    const now = Date.now();
    const stored = await this.ctx.storage.list<AgentPing>({ prefix: "ping:" });
    const live: AgentPing[] = [];
    for (const [key, p] of stored) {
      if (now - p.at > TTL_MS) {
        await this.ctx.storage.delete(key);
      } else {
        live.push(p);
      }
    }
    live.sort((a, b) => a.at - b.at);
    return live;
  }
}

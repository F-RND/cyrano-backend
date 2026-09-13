// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { RegistryDO } from "../src/registry-do.js";
import {
  AccountInboxDO,
  HOT_SNAPSHOT_MESSAGE,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOTS,
  SNAPSHOT_COLD_AFTER_MS,
  SNAPSHOT_TTL_MS,
} from "../src/account-inbox-do.js";
import { FREE_COLD_PLAN, sessionAnalysisAccess } from "../src/entitlement.js";
import type { Env } from "../src/env.js";

// Free cold relay: the enrollment mint, the
// snapshot store's caps and TTL, and the cold gate that keeps the free/Pro
// boundary identical to the device's own bridge. Same in-memory DO harness as
// account-inbox-push.test.ts / appstore-link.test.ts, extended with the alarm
// surface the TTL sweep uses.

class FakeStorage {
  readonly map = new Map<string, unknown>();
  alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.map) {
      if (key.startsWith(prefix)) out.set(key, value as T);
    }
    return out;
  }

  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  // Happy-path transaction, like appstore-link.test.ts: proves key layout,
  // not rollback under failure.
  async transaction<T>(fn: (txn: FakeStorage) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function makeRegistry() {
  const storage = new FakeStorage();
  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  } as unknown as DurableObjectState;
  return { registry: new RegistryDO(ctx, {} as Env), storage };
}

function makeInbox(sockets: unknown[] = []) {
  const storage = new FakeStorage();
  const ctx = { storage, getWebSockets: () => sockets } as unknown as DurableObjectState;
  return { inbox: new AccountInboxDO(ctx, {} as Env), storage };
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const DEVICE = "3A1C2E60-9DAB-4E11-8E5B-000000000001";

function enroll(deviceId: string = DEVICE): Request {
  return post("https://registry/_freecold/enroll", { device_id: deviceId });
}

const COLD_AGO = Date.now() - SNAPSHOT_COLD_AFTER_MS - 60 * 1000;

function snapBody(over: Record<string, unknown> = {}): unknown {
  return {
    session: { transcript: [{ seq: 1, text: "we agreed to ship tuesday" }] },
    index_row: { id: "sess-1", title: "Acme call", started_at: 1_000 },
    last_transcribed_at: COLD_AGO,
    device: "Test Device",
    ...over,
  };
}

function originRead(session: string): Request {
  return post("https://inbox/origin", {
    method: "GET",
    path: "/context",
    query: { session },
  });
}

// ---- Entitlement ----

describe("free-cold plan entitlement", () => {
  it("is relay-only: never spends the operator's LLM key", () => {
    const access = sessionAnalysisAccess({ entitled: true, plan: FREE_COLD_PLAN });
    expect(access.relayOnly).toBe(true);
    expect(access.userEntitled).toBe(false);
  });
});

// ---- Enrollment ----

describe("free-cold enrollment", () => {
  it("mints a free-cold identity for a device", async () => {
    const { registry } = makeRegistry();
    const res = await registry.fetch(enroll());
    const body = (await res.json()) as { valid: boolean; token: string; user_id: string; rotated: boolean };

    expect(res.status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.token.startsWith("cyrano_freecold_")).toBe(true);
    expect(body.rotated).toBe(false);

    const validated = await registry.fetch(post("https://registry/_validate_user", { token: body.token }));
    expect(await validated.json()).toMatchObject({
      valid: true,
      userId: body.user_id,
      plan: FREE_COLD_PLAN,
    });
  });

  it("re-enrolling the same device rotates the token on the SAME identity and kills the old one", async () => {
    const { registry } = makeRegistry();
    const first = (await (await registry.fetch(enroll())).json()) as { token: string; user_id: string };
    const second = (await (await registry.fetch(enroll())).json()) as {
      token: string;
      user_id: string;
      rotated: boolean;
    };

    expect(second.rotated).toBe(true);
    expect(second.user_id).toBe(first.user_id);

    const old = await registry.fetch(post("https://registry/_validate_user", { token: first.token }));
    expect(await old.json()).toMatchObject({ valid: false });
    const fresh = await registry.fetch(post("https://registry/_validate_user", { token: second.token }));
    expect(await fresh.json()).toMatchObject({ valid: true, userId: first.user_id });
  });

  it("refuses a malformed device id", async () => {
    const { registry } = makeRegistry();
    expect((await registry.fetch(enroll("x"))).status).toBe(400);
    expect((await registry.fetch(post("https://registry/_freecold/enroll", {}))).status).toBe(400);
  });

  it("caps FIRST mints per day but never capacity-refuses a rotation", async () => {
    const { registry, storage } = makeRegistry();
    const enrolled = (await (await registry.fetch(enroll())).json()) as { valid: boolean };
    expect(enrolled.valid).toBe(true);

    storage.map.set(`freecold-mints:${new Date().toISOString().slice(0, 10)}`, 2000);
    const newDevice = await registry.fetch(enroll("3A1C2E60-9DAB-4E11-8E5B-000000000002"));
    expect(newDevice.status).toBe(429);

    const rotation = await registry.fetch(enroll());
    expect(rotation.status).toBe(200);
    expect((await rotation.json()) as { rotated: boolean }).toMatchObject({ rotated: true });
  });
});

// ---- Snapshot store + cold gate ----

describe("free-cold snapshots", () => {
  it("serves a stored session once it is cold, shaped like a device answer", async () => {
    const { inbox } = makeInbox();
    const put = await inbox.fetch(post("https://inbox/snap", snapBody()));
    expect(put.status).toBe(200);

    const read = await inbox.fetch(originRead("sess-1"));
    expect(read.status).toBe(200);
    const reply = (await read.json()) as { status: number; body: unknown; device?: string };
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      transcript: [{ seq: 1, text: "we agreed to ship tuesday" }],
    });
    expect(reply.device).toBe("Test Device");
  });

  it("refuses a still-hot session with the free-plan wait, in the device-refusal shape", async () => {
    const { inbox } = makeInbox();
    await inbox.fetch(post("https://inbox/snap", snapBody({ last_transcribed_at: Date.now() })));

    const read = await inbox.fetch(originRead("sess-1"));
    const reply = (await read.json()) as { status: number; body: { error?: string } };
    expect(reply.status).toBe(403);
    expect(reply.body.error).toBe(HOT_SNAPSHOT_MESSAGE);
  });

  it("clamps a future last_transcribed_at to now — clock skew must not shorten the wait", async () => {
    const { inbox } = makeInbox();
    await inbox.fetch(
      post("https://inbox/snap", snapBody({ last_transcribed_at: Date.now() + 10 * 60 * 60 * 1000 })),
    );
    const reply = (await (await inbox.fetch(originRead("sess-1"))).json()) as { status: number };
    expect(reply.status).toBe(403);
  });

  it("404s through to device-offline when nothing is stored for the id", async () => {
    const { inbox } = makeInbox();
    const read = await inbox.fetch(originRead("sess-unknown"));
    expect(read.status).toBe(503);
    expect(await read.json()).toMatchObject({ device_online: false });
  });

  it("refuses an oversized snapshot rather than truncating it", async () => {
    const { inbox } = makeInbox();
    const res = await inbox.fetch(
      post("https://inbox/snap", snapBody({ session: { blob: "x".repeat(MAX_SNAPSHOT_BYTES + 1) } })),
    );
    expect(res.status).toBe(413);
  });

  it("drops a junk index row rather than storing an unfetchable entry", async () => {
    const { inbox } = makeInbox();
    const res = await inbox.fetch(post("https://inbox/snap", snapBody({ index_row: { title: "no id" } })));
    expect(res.status).toBe(400);
  });

  it("evicts the oldest snapshot past the count cap; a re-upload replaces its own copy", async () => {
    const { inbox, storage } = makeInbox();
    for (let i = 0; i < MAX_SNAPSHOTS + 1; i++) {
      await inbox.fetch(
        post(
          "https://inbox/snap",
          snapBody({ index_row: { id: `sess-${i}`, title: `call ${i}`, started_at: i } }),
        ),
      );
    }
    const keys = [...storage.map.keys()].filter((k) => k.startsWith("snap:"));
    expect(keys).toHaveLength(MAX_SNAPSHOTS);
    expect(keys).not.toContain("snap:sess-0"); // the oldest went first

    const again = await inbox.fetch(post("https://inbox/snap", snapBody({ index_row: { id: "sess-5", title: "call 5b", started_at: 5 } })));
    expect((await again.json()) as { stored: number }).toMatchObject({ stored: MAX_SNAPSHOTS });
  });

  it("expires snapshots on the alarm sweep and re-arms for the next expiry", async () => {
    const { inbox, storage } = makeInbox();
    await inbox.fetch(post("https://inbox/snap", snapBody()));
    expect(storage.alarmAt).not.toBeNull();

    // Force the copy past its expiry, then run the sweep.
    const key = "snap:sess-1";
    const snap = storage.map.get(key) as { expires_at: number };
    storage.map.set(key, { ...snap, expires_at: Date.now() - 1 });
    await inbox.alarm();
    expect(storage.map.has(key)).toBe(false);

    // And an expired-but-unswept copy never serves a read.
    storage.map.set(key, { ...snap, expires_at: Date.now() - 1 });
    const read = await inbox.fetch(originRead("sess-1"));
    expect(read.status).toBe(503);
  });

  it("honors a shorter client-declared retention, ceilinged at 24h", async () => {
    const { inbox, storage } = makeInbox();
    const before = Date.now();
    await inbox.fetch(post("https://inbox/snap", snapBody({ retention_hours: 2 })));
    const snap = storage.map.get("snap:sess-1") as { expires_at: number };
    expect(snap.expires_at).toBeGreaterThanOrEqual(before + 2 * 3600 * 1000 - 1000);
    expect(snap.expires_at).toBeLessThanOrEqual(before + 2 * 3600 * 1000 + 60 * 1000);

    await inbox.fetch(post("https://inbox/snap", snapBody({ retention_hours: 500 })));
    const clamped = storage.map.get("snap:sess-1") as { expires_at: number };
    expect(clamped.expires_at).toBeLessThanOrEqual(Date.now() + SNAPSHOT_TTL_MS + 60 * 1000);
  });

  it("deletes one snapshot, or all of them, idempotently", async () => {
    const { inbox, storage } = makeInbox();
    await inbox.fetch(post("https://inbox/snap", snapBody()));
    await inbox.fetch(
      post("https://inbox/snap", snapBody({ index_row: { id: "sess-2", title: "b", started_at: 2 } })),
    );

    const one = await inbox.fetch(post("https://inbox/snap-delete", { id: "sess-1" }));
    expect(await one.json()).toMatchObject({ ok: true, deleted: 1 });
    const again = await inbox.fetch(post("https://inbox/snap-delete", { id: "sess-1" }));
    expect(await again.json()).toMatchObject({ ok: true, deleted: 0 });

    const all = await inbox.fetch(post("https://inbox/snap-delete", { all: true }));
    expect(await all.json()).toMatchObject({ ok: true, deleted: 1 });
    expect([...storage.map.keys()].filter((k) => k.startsWith("snap:"))).toHaveLength(0);
  });

  it("merges stored rows into the index, flagged, with device-published rows winning on collision", async () => {
    const { inbox } = makeInbox();
    // A device published an index containing sess-1; a snapshot also holds
    // sess-1 (device row must win) and sess-9 (stored row must appear).
    await inbox.fetch(post("https://inbox/snap", snapBody()));
    await inbox.fetch(
      post("https://inbox/snap", snapBody({ index_row: { id: "sess-9", title: "phone-only", started_at: 9 } })),
    );
    // Publish through the DO's own storeIndex path shape: simulate by webSocketMessage
    // is socket-bound, so write the index the way storeIndex would.
    await (inbox as unknown as { storeIndex(raw: unknown, device?: string): Promise<void> }).storeIndex(
      { sessions: [{ id: "sess-1", title: "Acme call (device copy)", started_at: 1_000 }] },
      "Test Device",
    );

    const res = await inbox.fetch(new Request("https://inbox/index"));
    const { index } = (await res.json()) as {
      index: { sessions: Array<{ id: string; title: string; stored?: boolean }> };
    };
    const ids = index.sessions.map((s) => s.id);
    expect(ids).toEqual(["sess-1", "sess-9"]);
    expect(index.sessions[0]!.title).toBe("Acme call (device copy)");
    expect(index.sessions[0]!.stored).toBeUndefined();
    expect(index.sessions[1]!.stored).toBe(true);
  });

  it("withholds a still-hot stored row from the index, not just its body", async () => {
    const { inbox } = makeInbox();
    // The row carries the session's TITLE and tags. Listing it while the body
    // is still refused would make the hot window a rule about transcripts
    // rather than about sessions, and the device promises the latter.
    await inbox.fetch(
      post(
        "https://inbox/snap",
        snapBody({ index_row: { id: "sess-hot", title: "Severance terms", started_at: 5 }, last_transcribed_at: Date.now() }),
      ),
    );

    const hot = (await (await inbox.fetch(new Request("https://inbox/index"))).json()) as {
      index: { sessions: Array<{ id: string }> } | null;
    };
    expect(hot.index).toBeNull();

    // The same snapshot, once cold, lists normally — nothing is lost, it waits.
    await inbox.fetch(
      post(
        "https://inbox/snap",
        snapBody({ index_row: { id: "sess-hot", title: "Severance terms", started_at: 5 }, last_transcribed_at: COLD_AGO }),
      ),
    );
    const cold = (await (await inbox.fetch(new Request("https://inbox/index"))).json()) as {
      index: { sessions: Array<{ id: string; stored?: boolean }> };
    };
    expect(cold.index.sessions.map((s) => s.id)).toEqual(["sess-hot"]);
    expect(cold.index.sessions[0]!.stored).toBe(true);
  });
});

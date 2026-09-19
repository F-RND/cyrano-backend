// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "./env.js";
import { fallbackLegFor, transcriptContentLoggingEnabled } from "./env.js";
import { ClientLlmSelectionError, clientSelection, hostedPaidLeg } from "./llm/hosted-config.js";
import { agentLabelFromUrl, identityFromUrl, sessionAccessAllowed, type Identity } from "./auth.js";
import {
  isRetentionTier,
  narrowestRetention,
  relayRetentionAction,
  sessionAnalysisAccess,
} from "./entitlement.js";
import {
  costWeightedUnits,
  isRetryableStatus,
  type LlmConfig,
  type LlmProvider,
  type ServedLeg,
  type ClientLlmProvider,
} from "./llm/client.js";
import {
  createSpendLedger,
  isEmptyDelta,
  shadowSpendSink,
  spendDeltaToWire,
  type SpendLedger,
} from "./llm/spend.js";
import { billingProviderFor, pricingOptionsFromEnv } from "./llm/pricing.js";
import {
  applySessionCost,
  createSessionCostLedger,
  isEmptySessionCostDelta,
  sessionCostRow,
  type SessionCostLedger,
  type SessionCostRow,
  type SessionCostState,
} from "./session-cost.js";
import {
  runCombinedAnalysis,
  toPassFailure,
  type AnalysisResult,
  type PassFailure,
} from "./analysis/passes.js";
import { runCustomCategories, sanitizeDefinitions, type CustomPassResult } from "./analysis/custom.js";
import {
  priceTestEnabled,
  priceTestSampleRate,
  parsePriceTargets,
  runShadowPass,
  mergeAgg,
  buildReport,
  type TargetAgg,
} from "./analysis/price-test.js";
import { deterministicFallback, generateWhisperText } from "./analysis/whisper.js";
import { buildCandidate, tierForCommitment, ttlForTier } from "./analysis/tier.js";
import { windowPassesGate, windowWordCount } from "./analysis/window.js";
import { runCommitments, runAsks, runSuggestions } from "./analysis/passes.js";
import { sanitizeAttachment, toUserContextItem } from "./attachments.js";
import { MAX_WORDS } from "./policy/grammar.js";
import {
  AGENT_NOTE_KINDS,
  MAX_AGENT_NOTE_CHARS,
  MAX_AGENT_NOTES_PER_SESSION,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_HOT_STATE_ITEMS,
  MAX_USER_CONTEXT_PER_TICK,
} from "./types.js";
import {
  parseAgentContextQuery,
  rejectAtExtraction,
  selectTranscript,
  triageAsks,
  TRANSCRIPT_NOTES,
} from "./agent-context.js";
import type {
  AgentContextAttachment,
  AgentDirectMessage,
  AgentNoteInput,
  AgentNoteKind,
  AgentResultsPayload,
  AgentSessionNote,
  AnalysisStatusInfo,
  AskExtraction,
  ClientAgentMessage,
  ClientHelloMessage,
  ClientMessage,
  ClientSessionRetentionMessage,
  ClientWhisperFeedbackMessage,
  ClientWhisperRequestMessage,
  CommitmentExtraction,
  CustomCategoryDefinition,
  DecisionExtraction,
  DetectedCategory,
  HotState,
  NextMoveSuggestion,
  PullAskType,
  RetentionPolicy,
  ServerMessage,
  StoredAttachment,
  SubtextObservation,
  TranscriptSegment,
  UserContextItem,
  WhisperCandidate,
  WhisperFeedbackKind,
} from "./types.js";

const DEFAULT_MAX_DURATION_MS = 30 * 60_000;
const RETENTION_24H_MS = 24 * 60 * 60_000;
/** Session-lifetime cap on `hesitation` subtext PER SPEAKER (keyed by diarized
 * slot when present, else channel). 2026-07-22 QA feedback: a 34-minute meeting
 * accumulated ~50 hesitation entries — "ums and self-corrections are just how
 * humans talk". Two per voice states the pattern; further repeats are noise.
 * Only hesitation is capped: swallowed_disagreement / enthusiasm_mismatch are
 * the rare, valuable reads and stay uncapped (exact-text dedup still applies). */
const MAX_HESITATION_PER_SPEAKER_PER_SESSION = 2;
/** Bound on the remembered subtext texts used for exact-text session dedup. */
const MAX_SUBTEXT_SEEN_TEXTS = 200;
/** Flush a fresh analysis pass after this many newly finalized segments... */
const ANALYSIS_TRIGGER_SEGMENT_COUNT = 4;
/** Consecutive TRANSIENT LLM failures on one window before we stop holding it
 * for retry, advance past it, and surface an error status. Below this, a failed
 * window stays queued so the next trigger re-analyzes it once the model is
 * reachable — the "smart features catch up in a second" behavior. */
const ANALYSIS_MAX_RETRIES = 4;
/** In-memory floor between retries of a held window, so a sustained outage
 * can't turn every silence gap into another failed LLM bill. */
const ANALYSIS_RETRY_BACKOFF_MS = 4000;
/** ...or immediately when the client reports a silence gap, whichever comes first.
 * The DO trusts the client's VAD timing rather than running its own silence
 * timer, since the client already computes this in real time for the policy
 * engine — duplicating it server-side would just risk the two disagreeing. */
const SEGMENT_KEY_WIDTH = 10;
/** Directed user->agent messages kept per session (older ones are pruned). */
const MAX_AGENT_MESSAGES = 20;
/** Longest a `?wait_ms=` long-poll on the agent context endpoint may hold. */
const MAX_CONTEXT_WAIT_MS = 25_000;
/** Agent replies answer an explicit user question — a stale answer is worse
 * than none, so the TTL is short (matches the critical-tier TTL). */
const AGENT_REPLY_TTL_MS = 90_000;

/**
 * The directed questions one agent is being asked. Every agent key for an
 * account polls the same `/agent/latest/context`, so before addressing existed
 * a question reached all of them and the first reply won — with two agents
 * connected, "who am I talking to?" had no answer. A message the user aimed at
 * a key is exposed to that key alone; an unaddressed one (older client, or a
 * user who never picked) still goes to everybody, exactly as before.
 *
 * Pure and exported so the routing rule is pinned by tests rather than
 * inferred from a live DO.
 */
export function messagesForAgent(
  messages: AgentDirectMessage[],
  agentLabel: string | null,
): AgentDirectMessage[] {
  return messages.filter((m) => !m.target || m.target === agentLabel);
}
/**
 * Hard per-session LLM spend ceiling, in cost-weighted input-token-equivalent
 * units (see costWeightedUnits: cache writes 1.25x, cache reads 0.1x, output
 * 5x). 1M units ~= $3 of Sonnet-class input — far above any normal session
 * (a tick costs a few thousand units) but a real cap on a runaway session
 * against a BYOK user's own bill. Hitting it surfaces as analysis_status
 * "budget_exhausted"; whispers degrade to the deterministic fallback.
 */
const SESSION_LLM_BUDGET_UNITS = 1_000_000;

interface SessionMeta {
  session_id: string;
  retention: RetentionPolicy;
  created_at: number;
  last_activity_at: number;
  max_duration_ms: number;
  redacted: boolean;
  ended: boolean;
  /** ms; when `ended` was set (stamped since the per-session cost row
   * existed — it is the row's `ended_at` and the end of its duration).
   * Absent on sessions ended before then. */
  ended_at?: number;
  /** User-defined watch categories, sanitized from `hello`. Optional because
   * metas stored before this feature existed lack the fields. */
  custom_categories?: CustomCategoryDefinition[];
  detect_categories?: boolean;
  /** The tenant that created this session (added 2026-07-13), when it was
   * created under a per-user token rather than the operator's own
   * AUTH_TOKEN. Undefined for every self-host / operator-created session —
   * those stay open to anyone who already cleared the router's identity
   * check, exactly as before tenant users existed. See auth.ts. */
  owner_user_id?: string;
  /** Created under the operator's own AUTH_TOKEN (stamped since 2026-09-14).
   * Closes the session to every tenant identity — without it an operator's
   * live session on a hosted deployment was open to any tenant who learned
   * its id. Absent on sessions stored before the flag existed, which keep
   * the old open-to-any-authenticated-caller behaviour. See auth.ts. */
  operator_owned?: true;
  /** This session runs on a RELAY identity of Cyrano's own deployment, so the
   * post-end retention ceiling applies (PLAN-REMOTE.md option C). Persisted in
   * meta — not only socket runtime — because the end path that most needs it
   * is the max-duration alarm after the app died: the DO wakes from
   * hibernation with no socket message to restore runtime from, and a pinned
   * relayed session would otherwise be kept forever on exactly the crash path.
   * Sticky once true, never unset. */
  hosted_relay?: boolean;
}

interface StoredCandidate {
  candidate: WhisperCandidate;
  outcome: WhisperFeedbackKind | null;
  outcome_at: number | null;
}

/** Per-connection state needed after a hibernating WebSocket wakes this DO.
 * Cloudflare preserves serialized attachments only for the lifetime of the
 * socket, so a BYOK secret survives hibernation without becoming durable
 * session data that remains after disconnect. */
interface SessionSocketAttachment {
  identity?: Identity;
  runtime?: {
    version: 1;
    clientLlmApiKey: string | null;
    clientLlmProvider: ClientLlmProvider | null;
    clientLlmModel: string | null;
    sessionOwnerUserId: string | null;
    userEntitled: boolean;
    /** Optional: attachments persisted before the relay feature lack it —
     * absent reads as false (not a relay session). */
    relayOnly?: boolean;
    /** Optional for the same reason: this deployment is serving a relay
     * identity, which is what the retention ceiling keys on. */
    hostedRelay?: boolean;
    userOverCeiling: boolean;
  };
}

function segKey(seq: number): string {
  return `seg:${seq.toString().padStart(SEGMENT_KEY_WIDTH, "0")}`;
}

function formatCommitment(c: CommitmentExtraction): string {
  return c.inferred_deadline ? `${c.text} (by ${c.inferred_deadline})` : c.text;
}

/**
 * Which connected client filed a note, for the provenance line the app shows on
 * it. Set by the MCP layer from the OAuth connection's own label, so a note
 * reads "ChatGPT" or "Claude" rather than a generic "an agent". Untrusted
 * input, hence the clamp and the character class.
 */
export function agentSourceLabel(request: Request): string {
  const raw = (request.headers.get("x-cyrano-agent-source") ?? "").trim();
  const cleaned = raw.replace(/[^\p{L}\p{N} .:_-]/gu, "").slice(0, 40).trim();
  return cleaned.length > 0 ? cleaned : "Connected assistant";
}

/**
 * Validate + clamp one agent-filed note. Returns null for anything with no text
 * left after trimming — a note is refused rather than stored empty, and the
 * caller reports a count so a refusal is visible instead of silent.
 *
 * Over-length text is CLAMPED here rather than rejected (the local bridge
 * refuses instead) because this path is one leg of a remote round trip: an
 * assistant that gets a 4xx typically retries the same text, and the user's
 * note never lands. The clamp is reported back in `notes` so the caller can see
 * exactly what was stored.
 */
export function sanitizeAgentNote(
  input: AgentNoteInput,
  source: string,
  anchorSeq: number,
): AgentSessionNote | null {
  if (!input || typeof input.text !== "string") return null;
  const text = input.text.trim().slice(0, MAX_AGENT_NOTE_CHARS);
  if (text.length === 0) return null;
  const kind: AgentNoteKind = AGENT_NOTE_KINDS.includes(input.kind as AgentNoteKind)
    ? (input.kind as AgentNoteKind)
    : "note";
  const owner = typeof input.owner === "string" ? input.owner.trim().slice(0, 60) : "";
  // Stored verbatim, never parsed into a schedule: Cyrano does not run
  // reminders, and a date it silently reinterpreted would be worse than the
  // string the user's own assistant wrote.
  const dueAt = typeof input.due_at === "string" ? input.due_at.trim().slice(0, 40) : "";
  return {
    id: crypto.randomUUID(),
    text,
    kind,
    ...(owner ? { owner } : {}),
    ...(dueAt ? { due_at: dueAt } : {}),
    source,
    anchor_seq: anchorSeq,
    at: Date.now(),
  };
}

function formatAsk(a: AskExtraction): string {
  return a.text;
}

function formatSuggestion(s: NextMoveSuggestion): string {
  return s.text;
}

function clipToWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ").replace(/[,;:]$/, "") + ".";
}

function isAuthFailure(f?: PassFailure): boolean {
  return f?.status === 401 || f?.status === 403;
}

/** A failure worth queuing the window to retry — the provider was momentarily
 * unavailable, not refusing us outright. No HTTP status means a network error,
 * timeout, or a malformed/refused body (transient enough; the retry cap bounds
 * the pathological cases). 429/408/5xx are the provider saying "come back."
 * A 400/401/403 is our request being wrong — retrying just loops, so those fall
 * through to the normal (consume + broadcast the error status) path.
 *
 * Delegates to `llm/client.ts` so this rule has ONE home: `callTool` consults
 * the same predicate when it decides which of two failed legs to report, and if
 * the two ever disagreed a fallback failure could quietly drop a window the
 * primary alone would have held. */
export function isRetryableFailure(f?: PassFailure): boolean {
  return f ? isRetryableStatus(f.status) : false;
}

/** The full decision behind any frame that may change a live session's
 * retention (`session.retention`, reconnect hellos): the tier to store, or
 * null when the frame must be ignored. A frame naming a DIFFERENT session is
 * ignored outright — narrowing is a deletion control, and a stale or
 * misrouted frame must not narrow a copy it wasn't aimed at. A matching
 * frame goes through `narrowestRetention`, so it can never widen and junk
 * tiers on either side resolve conservatively. */
export function retentionAfterFrame(
  meta: { session_id: string; retention: RetentionPolicy },
  frame: { session_id: string; retention: RetentionPolicy },
): RetentionPolicy | null {
  if (frame.session_id !== meta.session_id) return null;
  const narrowed = narrowestRetention(meta.retention, frame.retention);
  return narrowed === meta.retention ? null : narrowed;
}

/** Collapses this tick's pass failures into the wire status. Auth failures
 * win (that's the "check your API key" case BYOK exists to surface); a
 * custom-pass-only failure stays "ok" since the main extractions flowed. */
function deriveAnalysisStatus(combined?: PassFailure, custom?: PassFailure): AnalysisStatusInfo {
  if (isAuthFailure(combined) || isAuthFailure(custom)) {
    return {
      state: "auth_error",
      detail:
        "The LLM provider rejected the API key (401/403) — check the API key in Settings, or LLM_API_KEY on the backend.",
    };
  }
  if (combined) {
    return { state: "llm_error", detail: combined.message.slice(0, 300) };
  }
  return { state: "ok" };
}

/**
 * The LlmConfig a live session calls the model with, as a PURE function of
 * (env, the client's BYOK selection, the resolved hosted leg, the meters).
 *
 * WHY THIS IS NOT INLINE IN `llmConfig()`
 * ---------------------------------------
 * BAR invariant I3 ("a client-supplied key is never silently replaced by our
 * key on another provider") is decided here by exactly one argument —
 * `fallbackLegFor(env, { usingClientKey: … })` — and a structural grep over
 * this file can see only that the function was called, never with what. A
 * behavioural test has to be able to build both branches without standing up a
 * Durable Object, so the branch lives in a pure exported function and
 * `llmConfig()` is the thin adapter that supplies `this`. The mirror image of
 * `resolveAnalysisLlmConfig` / `resolveStatelessLlmConfig` in
 * llm/hosted-config.ts, which do the same job for the stateless routes.
 *
 * A client-supplied key always wins over the operator's env.LLM_API_KEY — that
 * is what lets a shared backend bill each person's own account. BYOK carries
 * its own provider/model; the hosted path is whatever `hostedLeg()` resolved
 * (native Anthropic by default, or a configured paid provider for owned
 * sessions).
 */
export function sessionLlmConfig(
  env: Env,
  // Nullable, not just optional: the DO stores these as `string | null` after a
  // hibernation wake, and `?? ` must treat "restored as null" exactly like
  // "never set" or a woken BYOK session would silently become a hosted one.
  client: { apiKey?: string | null; provider?: ClientLlmProvider | null; model?: string | null },
  hosted: { provider: LlmProvider; baseUrl: string; apiKey: string; model: string },
  meters: {
    addUnits: (units: number) => void;
    /** Real-$ accrual, per provider+model. Never a bare micro-dollar sink: the
     * meter has to know WHICH leg produced each figure and on what basis. */
    spend: SpendLedger;
    noteLeg: (leg: ServedLeg) => void;
  },
): LlmConfig {
  if (client.apiKey) {
    return {
      ...clientSelection(env, client.provider, client.model, hosted.model),
      apiKey: client.apiKey,
      logContent: transcriptContentLoggingEnabled(env),
      // Asked explicitly, and always undefined: a BYOK call must never be
      // failed over onto our key at a provider the user did not choose
      // (BAR invariant I3). Stated as a call rather than an omission so the
      // rule is visible at the site, not inferred from a missing line.
      fallback: fallbackLegFor(env, { usingClientKey: true }),
      // BYOK spends the user's own key, so only the per-session unit budget
      // accrues — never OUR real-$ meter. `recordByok` has no usage and no rate
      // parameter, so there is no way for this branch to produce a cost; what it
      // records is that the calls HAPPENED, which is what stops a BYOK subject
      // from being indistinguishable from an idle one (defect D5).
      onUsage: (usage, _leg, call) => {
        meters.addUnits(costWeightedUnits(usage));
        meters.spend.recordByok(call);
      },
    };
  }
  return {
    ...hosted,
    logContent: transcriptContentLoggingEnabled(env),
    // Our key: eligible for the never-default fallback leg. Inert unless
    // FALLBACK_* is configured.
    fallback: fallbackLegFor(env, { usingClientKey: false }),
    onLeg: (leg) => meters.noteLeg(leg),
    onUsage: (usage, leg, call) => {
      meters.addUnits(costWeightedUnits(usage));
      // Real-$ accrual for the per-user meter — this call billed OUR key (the
      // paid hosted path). Priced at the provider AND model that ACTUALLY ran,
      // which on a failed-over call is the fallback's account and rate card,
      // not hosted's (BAR I5). The ledger resolves the account from the leg's
      // base URL, so our OpenAI key and an OpenRouter key are not conflated
      // just because they share the `openrouter` wire tag (defect D1). `call`
      // names the pass, for the per-session breakdown the ledger's observer
      // keeps (session-cost.ts).
      meters.spend.recordServed(usage, leg, call);
    },
  };
}

export class SessionDO implements DurableObject {
  /** Parked `?wait_ms=` context long-polls, resolved when a new directed
   * agent message arrives. In-memory only: if the DO restarts, the poll
   * just returns on its timeout and the agent re-polls — no state lost. */
  private contextWaiters: Array<() => void> = [];

  /** Server clock of the last agent /context poll, so an attach ack can hint
   * whether an agent is actually listening. In-memory only, same rationale
   * as contextWaiters: a DO restart just downgrades one ack's hint. */
  private lastContextPollAt: number | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const identity = identityFromUrl(url);

    // Ownership gate, shared by every path below (WS upgrade included): a
    // session created under a tenant token is only reachable by that same
    // tenant or the operator. A session with no owner (self-host /
    // operator-created) stays open to anyone who already cleared the
    // router's resolveIdentity, exactly as before tenant users existed.
    const meta = await this.getMeta();
    if (meta && !sessionAccessAllowed(identity, meta.owner_user_id, meta.operator_owned === true)) {
      return new Response("forbidden", { status: 403 });
    }

    // Path-check the upgrade too: the router allowlists what an agent key
    // may reach, but defense in depth — an upgrade header on /context must
    // not hand out a live client socket.
    if (request.headers.get("upgrade") === "websocket" && url.pathname.endsWith("/ws")) {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      // Stash identity on the socket (survives hibernation): fetch() sees
      // the resolved identity, but webSocketMessage only gets `ws` + the
      // raw frame, with no way back to this request's query string — this
      // is how a brand-new session's first `hello` learns who to stamp as
      // owner (see handleHello).
      server.serializeAttachment({ identity } satisfies SessionSocketAttachment);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET" && url.pathname.endsWith("/review")) {
      return this.handleReview();
    }
    // What this session has cost so far (or cost in total, once ended), by
    // model and by pass, with the transcript size to divide it by. Operator-
    // only at the router (index.ts), like GET /costs; the ownership gate above
    // applies as well.
    if (request.method === "GET" && url.pathname.endsWith("/cost")) {
      return this.handleSessionCost();
    }
    if (request.method === "POST" && url.pathname.endsWith("/redact")) {
      return this.handleRedact();
    }
    // Opt-in context attachments (clipboard / window-snapshot text, agent
    // images). REST rather than a WS frame: the deliberate user action wants
    // a synchronous ack, an old backend answers 404 instead of silently
    // dropping an unknown frame type, and an agent-destined image would flirt
    // with the 1 MiB WS message cap. Unreachable by agent keys — the worker
    // router allowlists those to GET /context and POST /results only.
    if (request.method === "POST" && url.pathname.endsWith("/attach")) {
      return this.handleAttach(request);
    }
    if (request.method === "GET" && url.pathname.endsWith("/context")) {
      return this.handleAgentContext(url);
    }
    if (request.method === "POST" && url.pathname.endsWith("/results")) {
      return this.handleAgentResults(request);
    }
    if (request.method === "DELETE") {
      return this.handlePurge();
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // Accept binary frames as UTF-8 JSON rather than dropping them: clients
    // built before the text-frame fix send `.data(...)` frames, and silently
    // ignoring those means hello is never acked and nothing is ever stored.
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    let message: ClientMessage;
    try {
      message = JSON.parse(text) as ClientMessage;
    } catch {
      this.send(ws, { type: "error", code: "bad_json", message: "Message was not valid JSON." });
      return;
    }
    // Hibernation reconstructs the DO and clears every class property while
    // leaving the socket connected. Restore the LLM/billing policy before any
    // non-hello frame can trigger analysis. Attachments created by an older
    // deployment lack `runtime`; reconnect once so the client sends a fresh,
    // authoritative hello instead of silently falling back to the wrong key.
    if (message.type !== "hello" && !this.restoreSocketRuntime(ws)) {
      this.send(ws, {
        type: "error",
        code: "reconnect_required",
        message: "Session state was refreshed; reconnecting preserves your LLM and subscription settings.",
      });
      ws.close(1012, "Reconnect required after server update");
      return;
    }
    try {
      await this.handleMessage(ws, message);
    } catch (err) {
      this.send(ws, { type: "error", code: "internal_error", message: String(err) });
    }
  }

  async webSocketClose(): Promise<void> {
    // No per-socket state to clean up — broadcasts use ctx.getWebSockets().
  }

  async webSocketError(): Promise<void> {
    // Same as close, for our purposes.
  }

  async alarm(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;

    const purpose = (await this.ctx.storage.get<string>("alarm:purpose")) ?? "retention";
    if (purpose === "max_duration" && !meta.ended) {
      // The session hit its duration cap without a session.end arriving
      // (app killed, network down at end). End it server-side and apply
      // the retention the user chose. Previously this single alarm purged
      // everything short of pinned — destroying a live "keep for 24h"
      // conversation at the ~30-minute mark.
      await this.endSessionInternal(meta);
      return;
    }

    // The relay ceiling purges unconditionally — including a PINNED session.
    // Pinning is a statement about the user's own archive, which lives on their
    // device and is untouched by this; it was never a statement about how long
    // a relayed copy may sit on our server (PLAN-REMOTE.md option C).
    if (purpose === "relay_ttl") {
      await this.purgeTranscript();
      await this.ctx.storage.delete("alarm:purpose");
      return;
    }

    if (meta.retention === "pinned") return;
    await this.purgeTranscript();
    await this.ctx.storage.delete("alarm:purpose");
  }

  // ---- message dispatch ----

  private async handleMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    // Nothing may append to an ended session: for ephemeral retention the
    // purge has already run, and anything stored now would sit there with
    // no alarm left to ever remove it — silently breaking the retention
    // promise. (`hello` is exempted so it can answer with its own error.)
    if (message.type !== "hello" && message.type !== "session.end") {
      const meta = await this.getMeta();
      if (meta?.ended) {
        this.send(ws, { type: "error", code: "session_ended", message: "Session has ended; start a new session." });
        return;
      }
    }
    switch (message.type) {
      case "hello":
        await this.handleHello(ws, message);
        return;
      case "transcript":
        await this.handleTranscript(message.segment);
        return;
      case "vad.state":
        if (message.state === "silence") await this.maybeRunAnalysis();
        return;
      case "whisper.request":
        await this.handleWhisperRequest(ws, message);
        return;
      case "whisper.feedback":
        await this.handleWhisperFeedback(message);
        return;
      case "session.end":
        await this.handleSessionEnd();
        return;
      case "session.extend":
        await this.handleSessionExtend();
        return;
      case "session.retention":
        await this.handleSessionRetention(message);
        return;
      case "agent.message":
        await this.handleAgentMessage(message);
        return;
    }
  }

  /**
   * Push the max-duration safety-net alarm out by another full window. Only
   * touches the live-session cap (not a retention purge), and only while the
   * session is live — a no-op otherwise, so a stray extend can't resurrect a
   * purge alarm or an ended session.
   */
  private async handleSessionExtend(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta || meta.ended) return;
    const purpose = (await this.ctx.storage.get<string>("alarm:purpose")) ?? "";
    if (purpose !== "max_duration") return;
    meta.last_activity_at = Date.now();
    await this.ctx.storage.put("meta", meta);
    await this.ctx.storage.setAlarm(Date.now() + meta.max_duration_ms);
  }

  /**
   * Mid-session retention change — a session tag resolved the live session to
   * a different tier than the hello declared. Narrowing-only via
   * `narrowestRetention`: the device deleting its copy mid-call ("tag it
   * `media`") must reach this copy too, but nothing may widen it back — the
   * ended-session purge paths (`endSessionInternal`, the max-duration alarm)
   * all read `meta.retention`, so a widen here would quietly turn a
   * keep-nothing session into a kept one. The frame must also name THIS
   * session: narrowing is a deletion control, and a stale or misrouted
   * frame must not narrow a copy it wasn't aimed at.
   */
  private async handleSessionRetention(message: ClientSessionRetentionMessage): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;
    const narrowed = retentionAfterFrame(meta, message);
    if (narrowed === null) return;
    meta.retention = narrowed;
    await this.ctx.storage.put("meta", meta);
  }

  /** Store a directed user->agent message and wake any parked context long-polls. */
  private async handleAgentMessage(message: ClientAgentMessage): Promise<void> {
    const entry: AgentDirectMessage = {
      id: message.id,
      text: message.text,
      at: message.at,
      answered: false,
      asked_at_ms: Date.now(),
      // Who the user aimed this at. Absent = anyone, which is what every
      // directed question was before the app could tell agents apart.
      ...(message.target ? { target: message.target } : {}),
    };
    await this.ctx.storage.put(`agentmsg:${message.id}`, entry);

    // Prune beyond the cap, oldest first.
    const all = await this.listAgentMessages();
    if (all.length > MAX_AGENT_MESSAGES) {
      for (const old of all.slice(0, all.length - MAX_AGENT_MESSAGES)) {
        await this.ctx.storage.delete(`agentmsg:${old.id}`);
      }
    }

    const waiters = this.contextWaiters;
    this.contextWaiters = [];
    for (const wake of waiters) wake();
  }

  private async handleHello(ws: WebSocket, message: ClientHelloMessage): Promise<void> {
    const now = Date.now();
    let meta = await this.getMeta();
    if (meta?.ended) {
      this.send(ws, { type: "error", code: "session_ended", message: "Session has ended; start a new session." });
      return;
    }

    // Client-supplied LLM configuration, held in memory only (see llmConfig)
    // and re-sent authoritatively on every hello. Treat omission as clearing:
    // otherwise removing a key in Settings and reconnecting would leave the
    // old credential active in this still-warm Durable Object.
    this.clientLlmApiKey = message.llm_api_key ?? null;
    this.clientLlmProvider = message.llm_provider ?? null;
    this.clientLlmModel = message.llm_model ?? null;

    if (!meta) {
      // Only a brand-new session's identity matters here — a reconnect to
      // an existing session already had its owner fixed at creation, and
      // the fetch()-level gate above already vetoed a mismatched identity
      // before this handler ever ran.
      const attachment = ws.deserializeAttachment() as { identity?: Identity } | null;
      const identity = attachment?.identity;
      meta = {
        session_id: message.session_id,
        // Unknown tier → keep nothing. The wire type is a fiction; an
        // unvalidated string stored here would read as "neither ephemeral nor
        // 24h" in every purge path and fall through to keep-forever.
        retention: isRetentionTier(message.retention) ? message.retention : "ephemeral",
        created_at: now,
        last_activity_at: now,
        max_duration_ms: message.max_duration_ms ?? DEFAULT_MAX_DURATION_MS,
        redacted: false,
        ended: false,
        custom_categories: sanitizeDefinitions(message.custom_categories),
        detect_categories: message.detect_categories === true,
        ...(identity?.kind === "user" ? { owner_user_id: identity.userId } : {}),
        ...(identity?.kind === "operator" ? { operator_owned: true as const } : {}),
      };
      await this.ctx.storage.put("meta", meta);
      await this.ctx.storage.put("alarm:purpose", "max_duration");
      await this.ctx.storage.setAlarm(now + meta.max_duration_ms);
    } else {
      meta.last_activity_at = now;
      // Reconnect hellos re-send the active category set, so a definition
      // edited mid-session takes effect on the next reconnect.
      if (message.custom_categories !== undefined) {
        meta.custom_categories = sanitizeDefinitions(message.custom_categories);
      }
      if (message.detect_categories !== undefined) {
        meta.detect_categories = message.detect_categories === true;
      }
      // Retention may NARROW on a reconnect hello — the fallback for a
      // `session.retention` frame that raced a dying socket (a tag applied
      // mid-call while offline). Never widens, and a hello naming a
      // different session doesn't touch it: see retentionAfterFrame.
      const narrowed = retentionAfterFrame(meta, message);
      if (narrowed !== null) meta.retention = narrowed;
      await this.ctx.storage.put("meta", meta);
    }

    // Cache the owner so the sync llmConfig()/metering path can tell a hosted
    // (owned) session from an operator/self-host one without an async read —
    // decides HOSTED_PAID_MODEL vs env.LLM_MODEL. Re-set on every hello, so it
    // survives a DO eviction (the client re-hellos before any new analysis).
    this.sessionOwnerUserId = meta.owner_user_id ?? null;

    // Persist the socket runtime NOW, before the registry subrequests below.
    // Those are DO-to-DO fetches, not storage ops, so the input gate doesn't
    // hold and the hibernation runtime can deliver the next (buffered, non-
    // hello) frame while this hello is still awaiting them. That frame would
    // hit the `reconnect_required` guard — no runtime attachment yet — and the
    // DO would close the socket (1012) in a tight reconnect loop. It bites the
    // owned+hosted path hardest: its extra cold `_entitlement` subrequest widens
    // the await window (BYOK/self-host skip it, which is why they never flap).
    // userEntitled defaults true here; the persist after the entitlement fetch
    // records the authoritative value.
    this.persistSocketRuntime(ws);

    // Claim "latest active session" so an external agent can poll a single
    // stable /agent/latest/... URL instead of being reconfigured every
    // session — scoped per-tenant when this session has an owner (see
    // RegistryDO.setActive), unscoped otherwise (unchanged from before
    // tenant users existed).
    const registry = this.env.REGISTRY_DO.get(this.env.REGISTRY_DO.idFromName("registry"));
    await registry
      .fetch("https://registry/_active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: message.session_id, owner_user_id: meta.owner_user_id }),
      })
      .catch(() => {});

    // Subscription entitlement (paid hosted tier): a lapsed sub degrades the
    // hosted smart layer to on-device. Only gated when this session runs on OUR
    // key (hosted) for an owning tenant — BYOK and self-host are never gated.
    // A `pro-relay` identity resolves to
    // userEntitled=false + relayOnly=true here: the session transits for the
    // agent loop, but analysis is deliberately the device's job — this is the
    // guard that keeps a relay session from spending the operator's LLM key.
    this.userEntitled = true;
    this.relayOnly = false;
    this.hostedRelay = false;
    // The client says this session is relay-only (a Pro device relaying through
    // a backend so agents can read along, analysis already done locally). Honor
    // it, but STILL ask the registry when there is an owner to ask about: the
    // client's flag settles analysis, and only the plan can settle whether this
    // is OUR deployment — which is what the retention ceiling keys on. Skipping
    // the lookup here (the first cut) left every hosted relay session looking
    // self-hosted, so the ceiling never applied to the sessions it exists for.
    if (message.relay_only === true) {
      this.userEntitled = false;
      this.relayOnly = true;
    }
    if (meta.owner_user_id && !this.clientLlmApiKey) {
      const ent = (await registry
        .fetch(`https://registry/_entitlement?user_id=${encodeURIComponent(meta.owner_user_id)}`)
        .then((r) => r.json())
        .catch(() => null)) as { entitled?: boolean; plan?: string | null } | null;
      const access = sessionAnalysisAccess(ent ?? { entitled: true });
      // The client's assertion only ever narrows: a plan that would allow
      // analysis cannot re-grant it over a client that asked for relay-only.
      this.userEntitled = this.relayOnly ? false : access.userEntitled;
      this.relayOnly = this.relayOnly || access.relayOnly;
      // The two flags fail in opposite directions on a lookup failure.
      // Analysis fails OPEN (a registry blip must not degrade a paying user's
      // session — the default above). Retention fails CLOSED: a tenant-owned
      // session whose own client asserted relay-only is treated as OUR relay,
      // so the ceiling still applies even if this was the only hello that ever
      // ran (first hello → registry blip → pin or max-duration end would
      // otherwise keep the server copy forever). A real reply that says the
      // plan is not a relay still wins — only the failure path assumes.
      this.hostedRelay = ent === null ? this.relayOnly : access.hostedRelay;
    }
    // The retention ceiling's flag goes into META, not only socket runtime:
    // the max-duration alarm ends sessions with no socket to restore runtime
    // from (app killed → DO hibernates → alarm wake), and that path must not
    // lose the ceiling. Sticky — a reconnect that failed the registry fetch
    // must not quietly turn a relayed session back into a keep-forever one.
    if (this.hostedRelay && meta.hosted_relay !== true) {
      meta.hosted_relay = true;
      await this.ctx.storage.put("meta", meta);
    }

    // Re-persist to record the authoritative userEntitled resolved above (the
    // early persist before the fetches defaulted it true to close the race).
    this.persistSocketRuntime(ws);

    // The ack's cursor is the real replay signal: the client compares it
    // with its own max sent seq and re-sends anything the server never
    // stored. (The old behavior here — one EMPTY analysis.result stub per
    // stored segment — replayed nothing the client was missing and could
    // flood a reconnect with hundreds of no-op messages.)
    const cursor = await this.lastStoredSeq();
    this.send(ws, { type: "hello.ack", session_id: message.session_id, server_seq_cursor: cursor });
  }

  private async handleTranscript(segment: TranscriptSegment): Promise<void> {
    await this.ctx.storage.put(segKey(segment.seq), segment);
    const meta = await this.getMeta();
    if (meta) {
      meta.last_activity_at = Date.now();
      await this.ctx.storage.put("meta", meta);
    }
    if (!segment.final) return;

    const pending = ((await this.ctx.storage.get<number>("analysis:pending_count")) ?? 0) + 1;
    await this.ctx.storage.put("analysis:pending_count", pending);
    if (pending >= ANALYSIS_TRIGGER_SEGMENT_COUNT) {
      await this.maybeRunAnalysis();
    }
  }

  /**
   * In-memory single-flight for the analysis pipeline. The DO's input gate
   * opens during the (non-storage) LLM fetch, so a `vad.state: silence`
   * arriving mid-run used to start a second overlapping run — both based
   * on the same pre-fetch hot state, last writer silently discarding the
   * other's commitments/asks, plus a duplicated LLM bill. In-memory is
   * fine here: hibernation losing the flag merely reverts one message to
   * the pre-fix behavior.
   */
  private analysisRun: Promise<void> | null = null;
  private analysisRerunRequested = false;
  /** Set by a forced (session-end) caller; consumed by the run loop so
   * exactly one forced pass happens even when a normal run is in flight. */
  private analysisForcePending = false;
  /** Earliest wall-clock a held-for-retry window may re-run. Set when a
   * transient LLM failure leaves a window queued; a forced (session-end) pass
   * ignores it. In-memory — a hibernation wake merely retries a touch early. */
  private analysisRetryNotBefore = 0;

  private async maybeRunAnalysis(force = false): Promise<void> {
    if (force) this.analysisForcePending = true;
    if (this.analysisRun) {
      this.analysisRerunRequested = true;
      // The end-flush must not race past a live tick: await the whole run —
      // its loop picks up the pending force before settling.
      if (force) await this.analysisRun;
      return;
    }
    this.analysisRun = (async () => {
      try {
        do {
          this.analysisRerunRequested = false;
          const runForce = this.analysisForcePending;
          this.analysisForcePending = false;
          await this.runAnalysisPass(runForce);
        } while (this.analysisRerunRequested || this.analysisForcePending);
      } finally {
        this.analysisRun = null;
      }
    })();
    await this.analysisRun;
  }

  private async runAnalysisPass(force = false): Promise<void> {
    const pending = (await this.ctx.storage.get<number>("analysis:pending_count")) ?? 0;
    if (pending === 0 && !force) return;
    // A window held after a transient LLM failure stays queued; honor its
    // backoff so a talkative user during an outage doesn't re-fire a failing
    // pass every silence gap. The session-end flush (force) ignores it.
    if (!force && Date.now() < this.analysisRetryNotBefore) return;

    const cursor = (await this.ctx.storage.get<number>("analysis:cursor")) ?? 0;
    const window = await this.segmentsSince(cursor);
    if (window.length === 0) return;

    // Word gate: don't spend LLM calls on a filler turn. Returning WITHOUT
    // zeroing pending_count or advancing the cursor keeps the window
    // accumulating — these segments are analyzed by the next tick that
    // clears the threshold, not dropped (see analysis/window.ts). The
    // forced end-of-session pass bypasses the threshold (≥1-word floor):
    // a short session's closing tail would otherwise never analyze.
    if (!windowPassesGate(windowWordCount(window), { endFlush: force })) return;

    const newCursor = window[window.length - 1]!.seq;
    // Advancing the cursor is how a window is CONSUMED — the "analyzed up to
    // here" watermark. Deferred until the pass's outcome is known: a window
    // consumed BEFORE the LLM call (as this code used to do) is lost forever
    // when that call fails transiently — the exact reason smart columns sat
    // empty at call start until "Test connection" warmed the model.
    const consumeWindow = async () => {
      await this.ctx.storage.put("analysis:pending_count", 0);
      await this.ctx.storage.put("analysis:cursor", newCursor);
      await this.ctx.storage.delete("analysis:retry_count");
    };

    const meta = await this.getMeta();
    if (!meta) return;

    // Terminal states (no key / not entitled / budget spent) genuinely consume
    // the window: they won't fix themselves mid-session, so holding it for
    // retry would just re-broadcast the same status every silence gap.
    if (!this.hasUsableLlmKey()) {
      await consumeWindow();
      this.broadcastStatusOnlyResult(meta.session_id, this.noLlmKeyStatus(), newCursor);
      return;
    }
    // Same terminal shape for a client key the server cannot honour (an
    // OpenAI-compatible key with no model): it needs a new hello, not a retry.
    const selectionError = this.clientSelectionError();
    if (selectionError) {
      await consumeWindow();
      this.broadcastStatusOnlyResult(meta.session_id, selectionError, newCursor);
      return;
    }

    // Entitlement gate (paid hosted tier): a lapsed subscription stops hosted
    // analysis and tells the client to renew or bring their own key. On-device
    // transcription is unaffected. Not reachable for BYOK/self-host sessions
    // (userEntitled stays true). A relay session lands here on purpose — its
    // analysis runs on the device — so it gets relay_only, not renewal copy.
    if (!this.userEntitled) {
      await consumeWindow();
      this.broadcastStatusOnlyResult(
        meta.session_id,
        this.relayOnly ? this.relayOnlyStatus() : this.subscriptionInactiveStatus(),
        newCursor,
      );
      return;
    }

    // Budget gate: past the ceiling, no more analysis spend this session. The
    // window is consumed (not held) so the trigger doesn't re-fire per silence
    // gap; the status broadcast tells the client why the columns stopped.
    if (await this.llmBudgetExhausted()) {
      await consumeWindow();
      this.broadcastStatusOnlyResult(meta.session_id, this.budgetExhaustedStatus(), newCursor);
      return;
    }

    const hotState = await this.getHotState();
    const config = this.llmConfig();
    const knownDetectedNames = (await this.listDetectedCategories()).map((d) => d.name);
    // Deliberately attached user context (newest few) rides into every pass
    // this tick. Kept attachments inform every subsequent tick too; ephemeral
    // ones are deleted right after the tick that consumed them.
    const tickAttachments = (await this.listAttachments())
      .filter((a) => a.destination === "analysis")
      .slice(-MAX_USER_CONTEXT_PER_TICK);
    const userContext = tickAttachments.map(toUserContextItem);
    // The four built-in extractions are ONE batched call; the custom pass is
    // one more, concurrent (a no-op with zero definitions and detection off —
    // no LLM call at all). Either failing degrades to empty rather than
    // failing the tick, but the failure is captured so the broadcast can
    // carry a machine-readable status instead of quietly empty columns.
    let customFailure: PassFailure | undefined;
    const knownCommitments = hotState?.last_commitment ? [hotState.last_commitment.text] : [];
    const knownOpenAsks = (hotState?.open_asks ?? []).map((a) => a.text);
    const [combined, custom] = await Promise.all([
      runCombinedAnalysis(config, window, knownCommitments, knownOpenAsks, userContext),
      runCustomCategories(
        config,
        window,
        meta.custom_categories ?? [],
        meta.detect_categories === true,
        knownDetectedNames,
        userContext,
      ).catch((err): CustomPassResult => {
        console.error(`analysis pass "custom_categories" failed:`, err);
        customFailure = toPassFailure(err);
        return { items: [], detected: [] };
      }),
    ]);
    await this.flushLlmSpend();

    // A transiently failed pass (cold model, 429, timeout) means these segments
    // reached us but the model never spoke to them. Rather than consume the
    // window and lose them, hold it: leave the cursor and pending_count intact
    // so the next trigger — the next silence gap, the next batch of segments,
    // or the session-end flush at the latest — re-analyzes it once the model is
    // back. Bounded by ANALYSIS_MAX_RETRIES so a sustained outage can't grow an
    // unbounded window or retry forever. We stay SILENT while holding: no empty
    // broadcast that would look like an authoritative "nothing found."
    // `force` is the session-end flush — the last pass this session will ever
    // run, so there's no future trigger to hold for. Take its best-effort
    // result (and status) rather than holding a window nothing will revisit.
    if (!force && (isRetryableFailure(combined.failure) || isRetryableFailure(customFailure))) {
      const retries = ((await this.ctx.storage.get<number>("analysis:retry_count")) ?? 0) + 1;
      if (retries <= ANALYSIS_MAX_RETRIES) {
        await this.ctx.storage.put("analysis:retry_count", retries);
        this.analysisRetryNotBefore = Date.now() + ANALYSIS_RETRY_BACKOFF_MS;
        // Ephemeral attachments are NOT consumed here — they must ride into the
        // retry that finally lands, not vanish with a failed attempt.
        return;
      }
      // Repeated transient failures: give up on this window, advance past it,
      // and let the status below tell the client analysis is degraded.
    }

    await consumeWindow();
    const status = deriveAnalysisStatus(combined.failure, customFailure);
    // Tick diagnostics (originally a 2026-07-16 trial debug line): is a tick
    // producing commitments live, or only in the session-end flush (force)?
    // Counts only by default — commitment owners are speaker names, which is
    // transcript-derived content and so rides behind TRANSCRIPT_CONTENT_LOGGING
    // like every other content log.
    console.log(
      `ANALYSIS_TICK force=${force} commitments=${combined.result.commitments.length} ` +
        (transcriptContentLoggingEnabled(this.env)
          ? `owners=[${combined.result.commitments.map((c) => c.owner).join(",")}] `
          : "") +
        `asks=${combined.result.asks.length} failed=${combined.failure !== undefined}`,
    );
    await this.applyAnalysisResult(meta, combined.result, newCursor, custom, status, window);

    // Shadow price-testing: the live result is already applied above; now
    // measure what every configured provider would have cost on this same
    // window. Measurement-only, our keys, best-effort — never blocks or fails
    // the tick. Skipped for BYOK sessions inside the gate.
    await this.maybeRunPriceTest(meta, window, knownCommitments, knownOpenAsks, userContext);

    // Ephemeral attachments are single-use: consumed by this tick, gone now —
    // regardless of the session's retention tier.
    for (const a of tickAttachments) {
      if (!a.keep) await this.deleteAttachment(a.id);
    }
  }

  /** Fan this window out to every PRICE_TEST_TARGETS provider (our keys) and
   * fold the per-target cost/conformance deltas into the session accumulator.
   * Gated OFF by default; never runs on BYOK sessions (their key/bill) and
   * never lets a shadow failure disturb the live tick. */
  private async maybeRunPriceTest(
    meta: SessionMeta,
    window: TranscriptSegment[],
    knownCommitments: string[],
    knownOpenAsks: string[],
    userContext: UserContextItem[],
  ): Promise<void> {
    // Each skip is logged (once per session, via a storage flag) so a silent
    // watcher always has a visible reason — the #1 debugging confusion is a
    // price-test that's enabled but never runs. `PRICE_TEST_SKIP` lines share
    // the marker prefix so `wrangler tail | grep PRICE_TEST` catches them too.
    if (!priceTestEnabled(this.env)) return; // flag off — expected, no log
    if (this.clientLlmApiKey) {
      await this.notePriceTestSkipOnce(meta, "session is BYOK (client key) — price-test runs only on hosted/our-key sessions");
      return;
    }
    const targets = parsePriceTargets(this.env);
    if (targets.length === 0) {
      await this.notePriceTestSkipOnce(meta, "PRICE_TEST_TARGETS is empty or all entries were malformed");
      return;
    }
    if (Math.random() >= priceTestSampleRate(this.env)) return; // sampled out — expected
    try {
      const deltas = await runShadowPass(
        this.env,
        targets,
        async (shadowConfig) => {
          const outcome = await runCombinedAnalysis(
            shadowConfig,
            window,
            knownCommitments,
            knownOpenAsks,
            userContext,
          );
          return {
            ok: outcome.failure === undefined,
            // Sample output is transcript-derived content. Keep it out of both
            // the persisted price-test report and Worker logs unless a disposable
            // test deployment opted in explicitly.
            ...(transcriptContentLoggingEnabled(this.env) ? { sample: outcome.result } : {}),
          };
        },
        () => Date.now(),
        // Attribute what this fan-out costs US to the session's owner. The
        // subject is right here in `meta.owner_user_id` — it was simply never
        // billed, so a price-test cohort's true cost read ~6x low. Shadow spend
        // is recorded on the meter and kept OUT of `delta.micros`, so it can
        // never push a user into budget_exhausted for work they did not ask
        // for. No new identifier, no client change (BAR I7).
        //
        // `shadowSpendSink` and not an inline arrow ON PURPOSE: this argument
        // is the whole of D7's fix, and as an anonymous closure it was
        // unassertable — swapping it for `undefined` or `() => {}` left all
        // 553 tests green. Named, the census in test/cost-reconciliation.test.ts
        // pins it here. Do not inline it back.
        shadowSpendSink(this.ledger()),
      );
      if (deltas.length === 0) {
        await this.notePriceTestSkipOnce(meta, "no target produced a shadow result — check each target's key secret (keyEnv)");
        return;
      }
      const agg = (await this.ctx.storage.get<Record<string, TargetAgg>>("pricetest:agg")) ?? {};
      mergeAgg(agg, deltas);
      await this.ctx.storage.put("pricetest:agg", agg);
    } catch (err) {
      // A price-test failure is never allowed to affect the session.
      console.error("price-test shadow pass failed:", err);
    }
    // Outside the catch above: whatever the shadow pass managed to spend before
    // it failed is still our money and still belongs on the subject's meter. The
    // tick's own flush already ran (before applyAnalysisResult), so without this
    // the shadow legs would sit in the ledger until the next tick — or be lost
    // to a hibernation, which is the "lose at most one tick" tolerance applied
    // to spend that is real.
    //
    // In a catch of its OWN, though. `flushLlmSpend` awaits `getMeta()` outside
    // its internal guard, so a storage hiccup there throws — and this function's
    // whole contract, stated at its doc comment and relied on by the caller, is
    // that a shadow-pass problem never disturbs the live tick. Unguarded, a
    // failed metering read here would propagate past `maybeRunPriceTest` and
    // skip the caller's ephemeral-attachment cleanup, which is exactly the
    // "measurement damaged the product" failure the gate exists to prevent.
    try {
      await this.flushLlmSpend();
    } catch (err) {
      console.error("price-test shadow spend flush failed:", err);
    }
  }

  /** Log a price-test skip reason at most once per session, so a run that
   * produces no report still explains itself in the tail without spamming a
   * line every analysis tick. */
  private async notePriceTestSkipOnce(meta: SessionMeta, reason: string): Promise<void> {
    if (await this.ctx.storage.get<boolean>("pricetest:skip_logged")) return;
    await this.ctx.storage.put("pricetest:skip_logged", true);
    console.log(`PRICE_TEST_SKIP session=${meta.session_id} reason="${reason}"`);
  }

  /** Emit the per-target price-test report at session end: a structured log
   * line (for `wrangler tail`/Logpush) plus a persisted snapshot under
   * `pricetest:report` for later retrieval. No-op when nothing was sampled. */
  private async emitPriceTestReport(meta: SessionMeta): Promise<void> {
    const agg = await this.ctx.storage.get<Record<string, TargetAgg>>("pricetest:agg");
    if (!agg || Object.keys(agg).length === 0) return;
    const report = buildReport(meta.session_id, agg);
    // Single-line structured JSON so a log pipeline can parse it directly.
    console.log(`PRICE_TEST_REPORT ${JSON.stringify(report)}`);
    await this.ctx.storage.put("pricetest:report", report);
  }

  /**
   * Collapse a tick's subtext against the whole session so far: drop exact
   * re-reads of an earlier tick's text, and cap `hesitation` per speaker
   * (diarized slot when the source line has one, else channel; a seq that
   * isn't in this window — e.g. an agent push — shares one fallback bucket).
   * State persists in DO storage so it survives hibernation like everything
   * else the analysis pipeline remembers.
   */
  private async collapseSessionSubtext(
    items: SubtextObservation[],
    window: TranscriptSegment[],
  ): Promise<SubtextObservation[]> {
    if (items.length === 0) return items;
    const speakerKeyBySeq = new Map(
      window.map((s) => [
        s.seq,
        s.speaker_slot !== undefined ? `slot:${s.speaker_slot}` : s.speaker,
      ]),
    );
    const state = (await this.ctx.storage.get<{
      hesitation: Record<string, number>;
      seen: string[];
    }>("subtext:noise")) ?? { hesitation: {}, seen: [] };
    const seen = new Set(state.seen);
    const kept: SubtextObservation[] = [];
    for (const item of items) {
      const textKey = item.text.trim().toLowerCase();
      if (seen.has(textKey)) continue;
      if (item.label === "hesitation") {
        const speakerKey = speakerKeyBySeq.get(item.source_seq) ?? "unattributed";
        const count = state.hesitation[speakerKey] ?? 0;
        if (count >= MAX_HESITATION_PER_SPEAKER_PER_SESSION) continue;
        state.hesitation[speakerKey] = count + 1;
      }
      seen.add(textKey);
      kept.push(item);
    }
    if (kept.length > 0) {
      state.seen = [...seen].slice(-MAX_SUBTEXT_SEEN_TEXTS);
      await this.ctx.storage.put("subtext:noise", state);
    }
    return kept;
  }

  /** Drop decisions already broadcast earlier this session (by normalized
   * text), so a settled outcome the model re-surfaces in a later window doesn't
   * duplicate in the review — the decisions analogue of the open-asks dedup. */
  private async dedupeSessionDecisions(items: DecisionExtraction[]): Promise<DecisionExtraction[]> {
    if (items.length === 0) return items;
    const seen = new Set((await this.ctx.storage.get<string[]>("decisions:seen")) ?? []);
    const kept: DecisionExtraction[] = [];
    for (const d of items) {
      const key = d.text.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(d);
    }
    if (kept.length > 0) {
      await this.ctx.storage.put("decisions:seen", [...seen].slice(-MAX_SUBTEXT_SEEN_TEXTS));
    }
    return kept;
  }

  private async applyAnalysisResult(
    meta: SessionMeta,
    result: AnalysisResult,
    triggeredBySeq: number,
    custom: CustomPassResult = { items: [], detected: [] },
    status: AnalysisStatusInfo = { state: "ok" },
    window: TranscriptSegment[] = [],
  ): Promise<void> {
    const now = Date.now();
    // Session-level subtext noise control (2026-07-22 QA feedback): the client
    // UNIONS every tick's broadcast, so per-tick caps alone still compound to
    // dozens of entries over a long meeting. Collapse repeats here, before
    // candidates/broadcast, so every downstream surface sees the curated set.
    const subtext = await this.collapseSessionSubtext(result.subtext, window);
    // Decisions accumulate the same way (client unions per-tick broadcasts), so
    // a decision restated in a later window must not double up in the review.
    const decisions = await this.dedupeSessionDecisions(result.decisions);
    // Re-read at merge time, not before the LLM await: anything that
    // updated hot state while the model was thinking (an agent push, a
    // prior run finishing) must not be overwritten from a stale base.
    const priorHotState = await this.getHotState();
    const hotState: HotState = priorHotState ?? {
      session_id: meta.session_id,
      last_commitment: null,
      open_asks: [],
      latest_suggestion: null,
      updated_at_seq: 0,
    };

    const newCandidates: WhisperCandidate[] = [];

    for (const commitment of result.commitments) {
      const tier = tierForCommitment(commitment, hotState);
      // `last_commitment` is surfaced to the agent as *your* last commitment
      // and drives the double-booking check, so only the user's own
      // commitments advance it — a counterpart's promise must not masquerade
      // as the user's. Both owners still whisper (a distinct candidate kind so
      // a USER and counterpart commitment on the same line never collide).
      if (commitment.owner === "USER") {
        hotState.last_commitment = commitment;
      }
      // Keep the recent set alongside `last_commitment`, both owners: an agent
      // asked "what did we agree about X" can then answer from what relates to
      // X, or say nothing does — instead of returning whatever happened to be
      // last (2026-07-28 integration review).
      hotState.recent_commitments = [...(hotState.recent_commitments ?? []), commitment]
        .slice(-MAX_HOT_STATE_ITEMS);
      newCandidates.push(
        buildCandidate({
          sessionId: meta.session_id,
          now,
          text: commitment.text,
          tier,
          source: "commitments",
          sourceSeq: commitment.source_seq,
          kind: commitment.owner === "USER" ? "commitment" : "commitment-other",
        }),
      );
    }

    for (const ask of result.asks) {
      // Discourse fragments the model lifted as questions ("Right?", "What the
      // fuck?") carry no information for any surface — they were the bulk of
      // one meeting's open-ask list. Dropped before storage rather than
      // filtered per-consumer; anything with actual content still flows,
      // triaged (not discarded) on the way to an agent.
      if (rejectAtExtraction(ask)) continue;
      if (!hotState.open_asks.some((a) => a.text === ask.text)) {
        hotState.open_asks.push(ask);
      }
      newCandidates.push(
        buildCandidate({
          sessionId: meta.session_id,
          now,
          text: ask.text,
          tier: "actionable",
          source: "asks",
          sourceSeq: ask.source_seq,
          kind: "ask",
        }),
      );
    }

    for (const item of subtext) {
      newCandidates.push(
        buildCandidate({
          sessionId: meta.session_id,
          now,
          text: item.text,
          tier: "ambient",
          source: "subtext",
          sourceSeq: item.source_seq,
          kind: "subtext",
          speculation: true,
        }),
      );
    }

    for (const suggestion of result.suggestions) {
      hotState.latest_suggestion = suggestion;
      newCandidates.push(
        buildCandidate({
          sessionId: meta.session_id,
          now,
          text: suggestion.text,
          tier: "ambient",
          source: "suggestions",
          sourceSeq: suggestion.source_seq,
          kind: "suggestion",
        }),
      );
    }

    // Custom items whisper at the tier the user chose for that category
    // (ambient when the definition is gone — e.g. edited away mid-session).
    const tierByCategoryId = new Map((meta.custom_categories ?? []).map((d) => [d.id, d.tier]));
    for (const item of custom.items) {
      newCandidates.push(
        buildCandidate({
          sessionId: meta.session_id,
          now,
          text: item.text,
          tier: tierByCategoryId.get(item.category_id) ?? "ambient",
          source: "custom",
          sourceSeq: item.source_seq,
          kind: `custom-${item.category_id}`,
          speculation: item.speculation,
        }),
      );
    }

    // Detected categories dedupe through storage so each suggested name is
    // broadcast at most once per session, surviving DO restarts.
    const freshDetected: DetectedCategory[] = [];
    for (const detected of custom.detected) {
      const key = `detectedcat:${detected.name.trim().toLowerCase()}`;
      if (await this.ctx.storage.get(key)) continue;
      await this.ctx.storage.put(key, detected);
      freshDetected.push(detected);
    }

    // Decisions were broadcast-only: nothing held them, so an agent polling
    // /context could never see what the conversation had settled. They persist
    // here in the same deduped form the client receives.
    if (decisions.length > 0) {
      hotState.decisions = [...(hotState.decisions ?? []), ...decisions].slice(-MAX_HOT_STATE_ITEMS);
    }

    hotState.updated_at_seq = triggeredBySeq;
    await this.ctx.storage.put("hotstate", hotState);
    for (const candidate of newCandidates) {
      await this.storeCandidate(candidate);
    }

    this.lastBroadcastAnalysisState = status.state;
    this.broadcast({
      type: "analysis.result",
      session_id: meta.session_id,
      commitments: result.commitments,
      asks: result.asks,
      subtext,
      suggestions: result.suggestions,
      decisions,
      custom_items: custom.items,
      detected_categories: freshDetected,
      analysis_status: status,
      triggered_by_seq: triggeredBySeq,
    });
    for (const candidate of newCandidates) {
      this.broadcast({ type: "whisper.candidate", candidate });
    }
  }

  private async handleWhisperRequest(ws: WebSocket, message: ClientWhisperRequestMessage): Promise<void> {
    const hotState = await this.getHotState();
    const fact = this.factForAsk(hotState, message.ask);
    const config = this.llmConfig();
    // Past the session's LLM budget, pulls still answer from hot state — the
    // facts are already extracted — but the rewrite degrades to the same
    // deterministic clipper the LLM-error path uses, and the no-hot-state
    // fallback pass (a fresh LLM call) is skipped entirely.
    // A lapsed subscription degrades pulls to the deterministic clipper too (no
    // hosted LLM spend), the same as hitting the per-session budget.
    const budgetExhausted = !this.userEntitled || (await this.llmBudgetExhausted());

    if (fact) {
      const text = budgetExhausted
        ? deterministicFallback(fact.text, "pull")
        : (await generateWhisperText(config, fact.text, "pull")).text;
      await this.flushLlmSpend();
      const candidate = buildCandidate({
        sessionId: message.session_id,
        now: Date.now(),
        text,
        tier: fact.tier,
        source: "pull",
        sourceSeq: fact.sourceSeq,
        kind: `pull-${message.ask}`,
      });
      await this.storeCandidate(candidate);
      this.send(ws, {
        type: "whisper.answer",
        session_id: message.session_id,
        ask: message.ask,
        candidate,
        answered_from: "hot_state",
      });
      return;
    }

    if (budgetExhausted) {
      // No hot-state fact and no budget left to run the fallback pass —
      // answer honestly rather than spending past the ceiling.
      this.send(ws, {
        type: "whisper.answer",
        session_id: message.session_id,
        ask: message.ask,
        candidate: null,
        answered_from: "hot_state",
      });
      return;
    }

    // Hot state has nothing for this ask: signal "still working" (client
    // plays a brief chime for a null-candidate llm-sourced answer) then fall
    // back to a narrow, single-purpose pass instead of the full analysis set.
    this.send(ws, {
      type: "whisper.answer",
      session_id: message.session_id,
      ask: message.ask,
      candidate: null,
      answered_from: "llm",
    });

    const window = await this.segmentsSince(0);
    const recentWindow = window.slice(-12);
    const fallbackText = await this.runFallbackAsk(config, message.ask, recentWindow);
    if (!fallbackText) {
      await this.flushLlmSpend();
      this.send(ws, {
        type: "whisper.answer",
        session_id: message.session_id,
        ask: message.ask,
        candidate: null,
        answered_from: "llm",
      });
      return;
    }

    const { text } = await generateWhisperText(config, fallbackText, "pull");
    await this.flushLlmSpend();
    const candidate = buildCandidate({
      sessionId: message.session_id,
      now: Date.now(),
      text,
      tier: "actionable",
      source: "pull",
      sourceSeq: recentWindow[recentWindow.length - 1]?.seq ?? 0,
      kind: `pull-${message.ask}`,
    });
    await this.storeCandidate(candidate);
    this.send(ws, {
      type: "whisper.answer",
      session_id: message.session_id,
      ask: message.ask,
      candidate,
      answered_from: "llm",
    });
  }

  private factForAsk(
    hotState: HotState | null,
    ask: PullAskType,
  ): { text: string; tier: "critical" | "actionable" | "ambient"; sourceSeq: number } | null {
    if (!hotState) return null;
    if (ask === "last_commitment" && hotState.last_commitment) {
      return {
        text: formatCommitment(hotState.last_commitment),
        tier: "actionable",
        sourceSeq: hotState.last_commitment.source_seq,
      };
    }
    if (ask === "open_ask" && hotState.open_asks.length > 0) {
      const first = hotState.open_asks[0]!;
      return { text: formatAsk(first), tier: "actionable", sourceSeq: first.source_seq };
    }
    if (ask === "next_move" && hotState.latest_suggestion) {
      return {
        text: formatSuggestion(hotState.latest_suggestion),
        tier: "ambient",
        sourceSeq: hotState.latest_suggestion.source_seq,
      };
    }
    return null;
  }

  private async runFallbackAsk(
    config: LlmConfig,
    ask: PullAskType,
    window: TranscriptSegment[],
  ): Promise<string | null> {
    if (window.length === 0) return null;
    // Same user context the periodic ticks see — a pull is a read, though,
    // so it never consumes an ephemeral attachment.
    const userContext = (await this.listAttachments())
      .filter((a) => a.destination === "analysis")
      .slice(-MAX_USER_CONTEXT_PER_TICK)
      .map(toUserContextItem);
    if (ask === "last_commitment") {
      const results = await runCommitments(config, window, [], userContext);
      return results[0] ? formatCommitment(results[0]) : null;
    }
    if (ask === "open_ask") {
      const results = await runAsks(config, window, [], userContext);
      return results[0] ? formatAsk(results[0]) : null;
    }
    const results = await runSuggestions(config, window, [], [], userContext);
    return results[0] ? formatSuggestion(results[0]) : null;
  }

  private async handleWhisperFeedback(message: ClientWhisperFeedbackMessage): Promise<void> {
    const key = `candidate:${message.candidate_id}`;
    const stored = await this.ctx.storage.get<StoredCandidate>(key);
    if (!stored) return;
    stored.outcome = message.feedback;
    stored.outcome_at = message.at;
    await this.ctx.storage.put(key, stored);
  }

  private async handleSessionEnd(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta || meta.ended) return;
    // Final flush over the unanalyzed tail, BEFORE endSessionInternal (an
    // ephemeral session's purge runs in there). Short sessions — a dictation
    // burst — end below the 4-segment trigger and the word gate; without
    // this pass their extractions silently never happen. Budget and no-key
    // gates stay in force inside the pass.
    try {
      await this.maybeRunAnalysis(true);
    } catch (err) {
      console.error("session.end analysis flush failed:", err);
    }
    // Deterministic end marker: the client holds its socket open briefly
    // after session.end awaiting the flush's results; this releases that
    // linger immediately even when the flush had nothing to say (empty tail,
    // deduped status). analysis_status is deliberately omitted so an
    // error status already showing on the client can't be clobbered by "ok".
    this.broadcast({
      type: "analysis.result",
      session_id: meta.session_id,
      commitments: [],
      asks: [],
      subtext: [],
      suggestions: [],
      decisions: [],
      custom_items: [],
      detected_categories: [],
      triggered_by_seq: await this.lastStoredSeq(),
    });
    await this.endSessionInternal(meta);
  }

  /** Shared by the client's session.end and the max-duration alarm. */
  private async endSessionInternal(meta: SessionMeta): Promise<void> {
    meta.ended = true;
    meta.ended_at = Date.now();
    await this.ctx.storage.put("meta", meta);

    // Emit the accumulated price-test report (if any) here rather than in the
    // client-end path, so a max-duration alarm end reports too. Best-effort:
    // reporting must never block the session from ending. Runs before an
    // ephemeral purge below wipes storage.
    try {
      await this.emitPriceTestReport(meta);
    } catch (err) {
      console.error("price-test report failed:", err);
    }

    // The per-session cost line, on the same terms: every end path, before the
    // purge (the transcript size is read here and is gone after), never
    // allowed to stop the session from ending.
    try {
      await this.emitSessionCostReport(meta);
    } catch (err) {
      console.error("session cost report failed:", err);
    }

    // "Keep with session" is the only way an attachment outlives the session.
    // Everything else — unconsumed analysis context, agent items never picked
    // up — dies here even in 24h/pinned sessions: discard-after-use is the
    // attachment promise, independent of the transcript's retention tier.
    for (const a of await this.listAttachments()) {
      if (!a.keep) await this.deleteAttachment(a.id);
    }

    // A relayed session on OUR deployment never outlives the ceiling, whatever
    // retention the device chose (PLAN-REMOTE.md option C). The clamp only ever
    // shortens: ephemeral still purges now.
    const action = relayRetentionAction({
      retention: meta.retention,
      // Meta first: on the max-duration alarm path after hibernation there was
      // no socket message to restore `this.hostedRelay` from, and the instance
      // field sits at its false default.
      hostedRelay: meta.hosted_relay === true || this.hostedRelay,
      retain24hMs: RETENTION_24H_MS,
    });
    switch (action.kind) {
      case "purge_now":
        await this.purgeTranscript();
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.delete("alarm:purpose");
        break;
      case "purge_after":
        // The ceiling gets its own alarm purpose because `alarm()` exempts
        // `pinned` from the ordinary retention purge — correct for a pinned
        // session the user keeps, and exactly wrong for a pinned session whose
        // server copy we promised would be gone within the hour. Sharing the
        // "retention" purpose would have set an alarm that fires and keeps it.
        await this.ctx.storage.put("alarm:purpose", action.ceiling ? "relay_ttl" : "retention");
        await this.ctx.storage.setAlarm(Date.now() + action.afterMs);
        break;
      case "keep":
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.delete("alarm:purpose");
        break;
    }
  }

  // ---- REST handlers ----

  private async handleReview(): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return new Response("not found", { status: 404 });

    const segments = await this.segmentsSince(0);
    const hotState = await this.getHotState();
    const candidateEntries = await this.ctx.storage.list<StoredCandidate>({ prefix: "candidate:" });

    return Response.json({
      session: meta,
      segments,
      hot_state: hotState,
      candidates: [...candidateEntries.values()],
      detected_categories: await this.listDetectedCategories(),
      // Only kept attachments belong in the record; ephemeral ones are
      // in-flight working context, not session content.
      attachments: (await this.listAttachments()).filter((a) => a.keep),
    });
  }

  private async handleRedact(): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return new Response("not found", { status: 404 });

    const segments = await this.segmentsSince(0);
    for (const segment of segments) {
      // SYSTEM (captured meeting/video audio) is third-party speech too, and at
      // least as sensitive as an in-room OTHER — redact both.
      if (segment.speaker === "OTHER" || segment.speaker === "SYSTEM") {
        segment.text = "[redacted]";
        await this.ctx.storage.put(segKey(segment.seq), segment);
      }
    }

    // Redaction must cover DERIVED content too: ask and subtext candidates
    // quote the OTHER party's words, and hot-state open_asks are OTHER's
    // requests near-verbatim — leaving them readable via /review and
    // /context defeated the one-tap promise the consent screen makes.
    // Custom-category candidates can quote anyone (the user's definition
    // decides what gets watched), so they redact too rather than guessing.
    const candidateEntries = await this.ctx.storage.list<StoredCandidate>({ prefix: "candidate:" });
    for (const [key, entry] of candidateEntries) {
      if (
        entry.candidate.source === "asks" ||
        entry.candidate.source === "subtext" ||
        entry.candidate.source === "custom"
      ) {
        entry.candidate.text = "[redacted]";
        await this.ctx.storage.put(key, entry);
      }
    }

    // Attachment text can quote third parties too — a window snapshot of a
    // Slack thread OCRs someone else's words verbatim — so it redacts along
    // with everything derived. (The app/window title stays: it names the
    // user's own tool, not third-party speech.)
    for (const a of await this.listAttachments()) {
      a.text = "[redacted]";
      await this.ctx.storage.put(`attach:${a.id}`, a);
    }

    // Detected-category evidence is a verbatim transcript quote — redact it
    // (the name/description are the model's abstraction, safe to keep).
    const detectedEntries = await this.ctx.storage.list<DetectedCategory>({ prefix: "detectedcat:" });
    for (const [key, entry] of detectedEntries) {
      if (entry.evidence) {
        entry.evidence = "[redacted]";
        await this.ctx.storage.put(key, entry);
      }
    }
    const hotState = await this.getHotState();
    if (hotState) {
      // Commitments and decisions quote the room the same way asks do — a
      // counterpart's promise is their words. Redaction has to reach the
      // retained sets too, or the newly-persisted lists become the leak the
      // open_asks clear above exists to close.
      const hadDerived = hotState.open_asks.length > 0 ||
        (hotState.recent_commitments?.length ?? 0) > 0 ||
        (hotState.decisions?.length ?? 0) > 0 ||
        hotState.last_commitment !== null;
      if (hadDerived) {
        hotState.open_asks = [];
        hotState.recent_commitments = [];
        hotState.decisions = [];
        hotState.last_commitment = null;
        await this.ctx.storage.put("hotstate", hotState);
      }
    }

    // Agent-filed notes are written ABOUT the conversation and routinely quote
    // it. They go entirely rather than to "[redacted]": unlike a transcript
    // segment, an empty note has no structural role to preserve.
    for (const note of await this.listAgentNotes()) {
      await this.ctx.storage.delete(`agentnote:${note.id}`);
    }
    await this.ctx.storage.delete("agentnotes:count");

    meta.redacted = true;
    await this.ctx.storage.put("meta", meta);
    return Response.json({ redacted: true });
  }

  /**
   * Opt-in context attachment (clipboard text / on-device OCR of a window
   * snapshot, plus an optional agent-destined image). Stored under
   * `attach:<id>` with any image body split into `attachimg:<id>` so
   * prefix-listing attachments during analysis ticks never loads megabyte
   * values. The sanitizer strips images from analysis-destined attachments,
   * so "analysis never sees pixels" is enforced by shape here, not client
   * good manners.
   */
  private async handleAttach(request: Request): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return new Response("not found", { status: 404 });
    if (meta.ended) {
      // Same rule as handleAgentResults: data landing after the session
      // ended would outlive every purge alarm.
      return Response.json({ error: "session_ended" }, { status: 409 });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const result = sanitizeAttachment(raw);
    if (!result.ok) {
      const status = result.error === "attachment_too_large" ? 413 : 400;
      return Response.json({ error: result.error }, { status });
    }
    const { attachment, imageBase64 } = result;

    const existing = await this.listAttachments();
    if (
      existing.length >= MAX_ATTACHMENTS_PER_SESSION &&
      !existing.some((a) => a.id === attachment.id)
    ) {
      return Response.json({ error: "too_many_attachments" }, { status: 429 });
    }

    await this.ctx.storage.put(`attach:${attachment.id}`, attachment);
    if (imageBase64) {
      await this.ctx.storage.put(`attachimg:${attachment.id}`, imageBase64);
    }
    meta.last_activity_at = Date.now();
    await this.ctx.storage.put("meta", meta);

    if (attachment.destination === "analysis") {
      // The user just deliberately handed over context — run a tick now
      // rather than waiting out the segment counter. Not awaited: the ack
      // means "stored", and the chooser shouldn't hang on an LLM round
      // trip. maybeRunAnalysis is single-flight and no-ops on an empty
      // window, in which case the attachment simply waits, unconsumed, for
      // the next tick — it enriches forward, never re-analyzes backward.
      this.maybeRunAnalysis().catch((err) => {
        console.error("attach-triggered analysis failed:", err);
      });
    } else {
      // Wake parked context long-polls exactly like a directed agent message.
      const waiters = this.contextWaiters;
      this.contextWaiters = [];
      for (const wake of waiters) wake();
    }

    return Response.json({
      accepted: true,
      id: attachment.id,
      destination: attachment.destination,
      agent_seen_recently:
        this.lastContextPollAt !== null && Date.now() - this.lastContextPollAt < 60_000,
    });
  }

  /**
   * Agent-facing pull endpoint. A Hermes claw (or any external agent) has no
   * way to receive a push — its gateway is outbound-only (Slack socket-mode,
   * no inbound port) — so it polls this instead. Trimmed to a recent window
   * rather than the full transcript `handleReview` returns, since this is
   * meant to be polled repeatedly.
   */
  private async handleAgentContext(url: URL): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return new Response("not found", { status: 404 });
    this.lastContextPollAt = Date.now();
    // Which agent is asking. Several can hold keys to the same account and all
    // of them poll this one endpoint, so a question the user aimed at one is
    // shown only to that one (see messagesForAgent).
    const agentLabel = agentLabelFromUrl(url);

    // `?wait_ms=` turns the poll into a long-poll: if the user hasn't
    // addressed the agent (message or attachment), hold the request until
    // they do (or the wait expires) instead of making the agent hammer the
    // endpoint to get a conversational round-trip latency.
    const waitMs = Math.min(Number(url.searchParams.get("wait_ms")) || 0, MAX_CONTEXT_WAIT_MS);
    let agentMessages = messagesForAgent(await this.listAgentMessages(), agentLabel);
    let attachments = await this.listAttachments();
    const hasUndelivered = (list: StoredAttachment[]) =>
      list.some((a) => a.destination === "agent" && !a.delivered_to_agent);
    if (waitMs > 0 && !agentMessages.some((m) => !m.answered) && !hasUndelivered(attachments)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        this.contextWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      agentMessages = messagesForAgent(await this.listAgentMessages(), agentLabel);
      attachments = await this.listAttachments();
    }

    const allSegments = await this.segmentsSince(0);
    const hotState = await this.getHotState();
    // Which slice of the transcript this caller asked for. Default is the same
    // 40-segment tail this endpoint always returned; `since_seq`, `around_seq`,
    // `until_seq`, `limit` and `search` let an agent go get the part of the
    // conversation the extracted state is POINTING AT, which is the whole
    // difference between citing evidence and guessing at it.
    const selection = selectTranscript(allSegments, parseAgentContextQuery(url.searchParams));
    const askTriage = triageAsks(hotState?.open_asks ?? []);

    // First time the agent sees an unanswered question, stamp the pickup —
    // asked→pickup is the agent's poll gap, the half of reply latency its
    // polling cadence controls. Ids and deltas only; never message text.
    const exposedMessages = agentMessages.slice(-10);
    const pickedUpAt = Date.now();
    for (const m of exposedMessages) {
      if (m.answered || m.picked_up_at_ms !== undefined) continue;
      m.picked_up_at_ms = pickedUpAt;
      await this.ctx.storage.put(`agentmsg:${m.id}`, m);
      if (m.asked_at_ms !== undefined) {
        console.log(`agent pickup id=${m.id} pickup_delta_ms=${pickedUpAt - m.asked_at_ms}`);
      }
    }

    // Agent-destined attachments. The image (if any) rides along exactly
    // once — on the first poll that delivers the attachment — then is
    // deleted: delivery-only, never retained server-side. Ephemeral
    // (keep=false) attachments are deleted whole on that first delivery;
    // kept ones stay listed, text-only, for the rest of the session.
    const exposedAttachments: AgentContextAttachment[] = [];
    for (const a of attachments) {
      if (a.destination !== "agent") continue;
      const item: AgentContextAttachment = {
        id: a.id,
        source: a.source,
        ...(a.app_name ? { app_name: a.app_name } : {}),
        ...(a.window_title ? { window_title: a.window_title } : {}),
        ...(a.file_name ? { file_name: a.file_name } : {}),
        text: a.text,
        at: a.at,
      };
      if (!a.delivered_to_agent) {
        if (a.has_image) {
          const image = await this.ctx.storage.get<string>(`attachimg:${a.id}`);
          if (image) item.image_base64 = image;
          await this.ctx.storage.delete(`attachimg:${a.id}`);
        }
        if (a.keep) {
          a.delivered_to_agent = true;
          a.has_image = false;
          await this.ctx.storage.put(`attach:${a.id}`, a);
        } else {
          await this.ctx.storage.delete(`attach:${a.id}`);
        }
      }
      exposedAttachments.push(item);
    }

    return Response.json({
      session_id: meta.session_id,
      retention: meta.retention,
      ended: meta.ended,
      recent_segments: selection.segments,
      // Where the returned window sits in the whole session, so a consumer can
      // tell "this is everything" from "this is the last two minutes" instead
      // of assuming the former. has_more_before/after are the pagination hooks.
      transcript_range: selection.range,
      // Non-contiguous spans matching `?search=` — anywhere in the session, not
      // just the tail.
      ...(selection.spans.length > 0 ? { matched_spans: selection.spans } : {}),
      transcript_notes: TRANSCRIPT_NOTES,
      hot_state: hotState,
      // How far behind the transcript the extracted state is. Analysis runs on
      // a window that closes on silence, so hot state is ALWAYS a little stale;
      // saying by how much beats a consumer silently treating it as current.
      hot_state_lag_seq: hotState
        ? Math.max(0, selection.range.latest_seq - hotState.updated_at_seq)
        : null,
      // `hot_state.open_asks` is append-only and accumulates rhetorical
      // fragments, near-duplicates and low-confidence debris over a long
      // session. Same items, sorted: act on `actionable`, and use `filtered`
      // (each with its reason) only if you need to explain an omission.
      open_asks_actionable: askTriage.actionable,
      open_asks_filtered: askTriage.filtered.map(({ ask, reason }) => ({ ...ask, reason })),
      session_notes: await this.listAgentNotes(),
      // Directed questions from the user (the vocal gateway). Answer any
      // with answered:false via POST .../results {"replies":[...]}.
      agent_messages: exposedMessages,
      // Context the user explicitly sent to the agent (clipboard / window
      // snapshots). image_base64 appears at most once per attachment.
      attachments: exposedAttachments,
    });
  }

  /**
   * Agent-facing push endpoint. Accepts either (or both): raw extractions
   * shaped like the four analysis passes (tiered/TTL'd the same way an
   * internal pass would be, via `applyAnalysisResult`), or fully-formed
   * whisper candidates the agent already decided the tier/TTL for. Either
   * way, results flow into the exact same store-candidate + broadcast path
   * as internally-generated ones — the client can't tell the difference
   * between "our LLM call found this" and "the agent posted this".
   */
  private async handleAgentResults(request: Request): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return new Response("not found", { status: 404 });
    if (meta.ended) {
      // Same retention rule the WS path enforces: data pushed after the
      // session ended would outlive every purge alarm.
      return Response.json({ error: "session_ended" }, { status: 409 });
    }

    let payload: AgentResultsPayload;
    try {
      payload = (await request.json()) as AgentResultsPayload;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const triggeredBySeq = await this.lastStoredSeq();

    const hasExtractions =
      (payload.commitments?.length ?? 0) > 0 ||
      (payload.asks?.length ?? 0) > 0 ||
      (payload.subtext?.length ?? 0) > 0 ||
      (payload.suggestions?.length ?? 0) > 0 ||
      (payload.decisions?.length ?? 0) > 0;

    if (hasExtractions) {
      await this.applyAnalysisResult(
        meta,
        {
          commitments: payload.commitments ?? [],
          asks: payload.asks ?? [],
          subtext: payload.subtext ?? [],
          suggestions: payload.suggestions ?? [],
          decisions: payload.decisions ?? [],
        },
        triggeredBySeq,
      );
    }

    let candidatesStored = 0;
    for (const input of payload.whisper_candidates ?? []) {
      const candidate: WhisperCandidate = {
        id: crypto.randomUUID(),
        session_id: meta.session_id,
        text: input.text,
        tier: input.tier,
        source: "agent",
        created_at: Date.now(),
        ttl_ms: input.ttl_ms ?? ttlForTier(input.tier),
        speculation: input.speculation ?? false,
      };
      await this.storeCandidate(candidate);
      this.broadcast({ type: "whisper.candidate", candidate });
      candidatesStored++;
    }

    // Replies to directed agent messages: spoken immediately client-side
    // (the user explicitly asked), so they get their own message type
    // rather than the tier-queued whisper.candidate path. Word-clipped to
    // pull-mode length but NOT full whisper grammar — that grammar bans
    // question-shaped lead-ins, which would mangle legitimate answers.
    let repliesDelivered = 0;
    const replyingAgent = agentLabelFromUrl(new URL(request.url));
    for (const reply of payload.replies ?? []) {
      const key = `agentmsg:${reply.reply_to}`;
      const msg = await this.ctx.storage.get<AgentDirectMessage>(key);
      if (!msg || msg.answered) continue;
      // An addressed question is answerable only by its addressee — the same
      // rule the context poll applies on the way out, enforced on the way back
      // so the address is a fact and not a hint.
      if (msg.target && msg.target !== replyingAgent) continue;
      msg.answered = true;
      await this.ctx.storage.put(key, msg);

      const repliedAt = Date.now();
      const totalMs = msg.asked_at_ms !== undefined ? repliedAt - msg.asked_at_ms : undefined;
      // total = poll gap + agent thinking; the pickup log line above carries
      // the poll-gap half, so llm_delta is the agent's own LLM time.
      const llmMs = msg.picked_up_at_ms !== undefined ? repliedAt - msg.picked_up_at_ms : undefined;
      console.log(
        `agent reply id=${reply.reply_to} llm_delta_ms=${llmMs ?? "n/a"} total_delta_ms=${totalMs ?? "n/a"}`,
      );

      const candidate: WhisperCandidate = {
        id: crypto.randomUUID(),
        session_id: meta.session_id,
        text: clipToWords(reply.text, MAX_WORDS.pull),
        tier: "actionable",
        source: "agent",
        created_at: repliedAt,
        ttl_ms: AGENT_REPLY_TTL_MS,
        speculation: false,
      };
      await this.storeCandidate(candidate);
      this.broadcast({
        type: "agent.reply",
        session_id: meta.session_id,
        reply_to: reply.reply_to,
        candidate,
        latency_ms: totalMs,
      });
      repliesDelivered++;
    }

    // Notes a connected assistant filed into the session record. Unlike a
    // reply, nothing here is spoken: it lands in the app's Notes section beside
    // the ones the user typed, tagged with the client that wrote it.
    const notesFiled: AgentSessionNote[] = [];
    const anchorSeq = triggeredBySeq;
    const source = agentSourceLabel(request);
    let noteCount = (await this.ctx.storage.get<number>("agentnotes:count")) ?? 0;
    for (const input of payload.notes ?? []) {
      if (noteCount >= MAX_AGENT_NOTES_PER_SESSION) break;
      const note = sanitizeAgentNote(input, source, anchorSeq);
      if (!note) continue;
      await this.ctx.storage.put(`agentnote:${note.id}`, note);
      noteCount++;
      notesFiled.push(note);
      this.broadcast({ type: "agent.note", session_id: meta.session_id, note });
    }
    if (notesFiled.length > 0) {
      await this.ctx.storage.put("agentnotes:count", noteCount);
    }

    return Response.json({
      accepted: true,
      candidates_stored: candidatesStored,
      replies_delivered: repliesDelivered,
      notes_filed: notesFiled.length,
      // Ids back, so a caller that files two notes can tell the user which
      // landed rather than reporting a bare count.
      ...(notesFiled.length > 0 ? { notes: notesFiled } : {}),
      // A note the app never receives is a note the user will never see. The
      // socket count is the honest signal for "did this reach the device".
      connected_clients: this.ctx.getWebSockets().length,
    });
  }

  private async handlePurge(): Promise<Response> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return Response.json({ purged: true });
  }

  // ---- storage helpers ----

  private async getMeta(): Promise<SessionMeta | null> {
    return (await this.ctx.storage.get<SessionMeta>("meta")) ?? null;
  }

  private async getHotState(): Promise<HotState | null> {
    return (await this.ctx.storage.get<HotState>("hotstate")) ?? null;
  }

  private async storeCandidate(candidate: WhisperCandidate): Promise<void> {
    const entry: StoredCandidate = { candidate, outcome: null, outcome_at: null };
    await this.ctx.storage.put(`candidate:${candidate.id}`, entry);
  }

  private async listAgentMessages(): Promise<AgentDirectMessage[]> {
    const map = await this.ctx.storage.list<AgentDirectMessage>({ prefix: "agentmsg:" });
    return [...map.values()].sort((a, b) => a.at - b.at);
  }

  /** Oldest-first. Notes an assistant filed this session, echoed back in the
   * context payload so a reconnecting agent can see what it (or another
   * connected client) already wrote instead of filing it twice. */
  private async listAgentNotes(): Promise<AgentSessionNote[]> {
    const map = await this.ctx.storage.list<AgentSessionNote>({ prefix: "agentnote:" });
    return [...map.values()].sort((a, b) => a.at - b.at);
  }

  /** Oldest-first. (The "attach:" prefix cannot match "attachimg:" keys —
   * the colon excludes them.) */
  private async listAttachments(): Promise<StoredAttachment[]> {
    const map = await this.ctx.storage.list<StoredAttachment>({ prefix: "attach:" });
    return [...map.values()].sort((a, b) => a.at - b.at);
  }

  private async deleteAttachment(id: string): Promise<void> {
    await this.ctx.storage.delete(`attach:${id}`);
    await this.ctx.storage.delete(`attachimg:${id}`);
  }

  private async listDetectedCategories(): Promise<DetectedCategory[]> {
    const map = await this.ctx.storage.list<DetectedCategory>({ prefix: "detectedcat:" });
    return [...map.values()].sort((a, b) => a.source_seq - b.source_seq);
  }

  private async segmentsSince(seq: number): Promise<TranscriptSegment[]> {
    const map = await this.ctx.storage.list<TranscriptSegment>({
      prefix: "seg:",
      start: segKey(seq + 1),
    });
    return [...map.values()];
  }

  private async lastStoredSeq(): Promise<number> {
    const map = await this.ctx.storage.list<TranscriptSegment>({ prefix: "seg:", reverse: true, limit: 1 });
    const [only] = [...map.values()];
    return only?.seq ?? 0;
  }

  private async purgeTranscript(): Promise<void> {
    const map = await this.ctx.storage.list({ prefix: "seg:" });
    for (const key of map.keys()) {
      await this.ctx.storage.delete(key);
    }
    const candidates = await this.ctx.storage.list({ prefix: "candidate:" });
    for (const key of candidates.keys()) {
      await this.ctx.storage.delete(key);
    }
    const agentMessages = await this.ctx.storage.list({ prefix: "agentmsg:" });
    for (const key of agentMessages.keys()) {
      await this.ctx.storage.delete(key);
    }
    const detected = await this.ctx.storage.list({ prefix: "detectedcat:" });
    for (const key of detected.keys()) {
      await this.ctx.storage.delete(key);
    }
    // "attach" (no colon) covers both attach: records and attachimg: bodies.
    const attachments = await this.ctx.storage.list({ prefix: "attach" });
    for (const key of attachments.keys()) {
      await this.ctx.storage.delete(key);
    }
    // Notes an assistant filed are session content and expire with it. (The
    // device keeps its own copy under the retention the user chose there —
    // this purge is the server-side half.)
    const agentNotes = await this.ctx.storage.list({ prefix: "agentnote:" });
    for (const key of agentNotes.keys()) {
      await this.ctx.storage.delete(key);
    }
    await this.ctx.storage.delete("agentnotes:count");
    await this.ctx.storage.delete("hotstate");
    await this.ctx.storage.delete("analysis:cursor");
    await this.ctx.storage.delete("analysis:pending_count");
    await this.ctx.storage.delete("analysis:retry_count");
    await this.ctx.storage.delete("llm:spend_units");
  }

  // ---- LLM config + per-session budget ----

  /** Cost-weighted units accrued by in-flight calls, not yet persisted.
   * In-memory is fine: hibernation mid-tick loses at most one tick's spend
   * from the meter, never bills anything extra. */
  private unflushedSpendUnits = 0;

  /**
   * Real-dollar spend accrued this session on OUR key (env.LLM_API_KEY), not
   * yet reported to the per-user meter, broken down by the provider+model that
   * served each call — plus a count of calls that ran on a client key, which
   * cost us nothing but are not nothing (defect D5).
   *
   * Built lazily rather than as a field initializer because it needs `this.env`
   * (for the operator-configured rates) and TypeScript runs field initializers
   * before constructor parameter properties are assigned. In-memory, same
   * tolerance as the unit budget: hibernation mid-tick loses at most one tick's
   * spend from the meter, and never bills anything extra.
   */
  private spendLedger: SpendLedger | null = null;

  private ledger(): SpendLedger {
    // The session-cost ledger rides along as the spend ledger's observer, so
    // every block the per-user meter prices — served, BYOK, shadow — reaches
    // the per-session breakdown from the same PricedUsage, and no call site
    // has to remember two ledgers (session-cost.ts).
    return (this.spendLedger ??= createSpendLedger(pricingOptionsFromEnv(this.env), this.sessionCost()));
  }

  /**
   * Per-session cost breakdown by (provider, model, pass) — what an operator
   * reads to compare candidate models on cost per minute. In-memory between
   * flushes; `flushLlmSpend` folds each drained delta into the persisted
   * `cost:session` record, so like the other meters it loses at most one
   * tick's worth to a hibernation and never double-counts.
   */
  private sessionCostLedger: SessionCostLedger | null = null;

  private sessionCost(): SessionCostLedger {
    return (this.sessionCostLedger ??= createSessionCostLedger());
  }

  private async getSessionCostState(): Promise<SessionCostState | undefined> {
    return this.ctx.storage.get<SessionCostState>("cost:session");
  }

  /**
   * The session's cost row as of `now`: the persisted record plus whatever the
   * in-memory ledger holds that has not been flushed yet, so a live read is not
   * one tick behind. Transcript size is counted from stored segments (gone
   * after an ephemeral purge — which is why the end-of-session report reads it
   * BEFORE the purge and persists the finished row).
   */
  private async buildSessionCostRow(meta: SessionMeta, now: number): Promise<SessionCostRow> {
    const stored = await this.getSessionCostState();
    const state = applySessionCost(stored, this.sessionCost().peek());
    const segments = await this.segmentsSince(0);
    const hosted = hostedPaidLeg(this.env, Boolean(meta.owner_user_id));
    return sessionCostRow(state, {
      sessionId: meta.session_id,
      ownerUserId: meta.owner_user_id ?? null,
      createdAt: meta.created_at,
      endedAt: meta.ended ? (meta.ended_at ?? meta.last_activity_at) : null,
      now,
      transcriptSegments: segments.length,
      transcriptWords: windowWordCount(segments),
      // The model the hosted leg resolves to for THIS session (HOSTED_PAID_MODEL
      // when owned, LLM_MODEL otherwise) — read off the meta rather than the
      // socket runtime so an ended or hibernated session answers the same.
      configured: { provider: billingProviderFor(hosted), model: hosted.model },
    });
  }

  private async handleSessionCost(): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return new Response("not found", { status: 404 });
    // An ended session answers from the row it filed at end time, which
    // already includes the transcript size the purge may since have removed.
    const filed = meta.ended ? await this.ctx.storage.get<SessionCostRow>("cost:report") : undefined;
    return Response.json(filed ?? (await this.buildSessionCostRow(meta, Date.now())));
  }

  /**
   * At session end: flush what is still in memory, build the finished row,
   * log it as ONE structured line (`SESSION_COST {...}` — grep it out of
   * `wrangler tail` / Logpush), keep it under `cost:report` for
   * `GET /session/:id/cost`, and hand it to the registry so
   * `GET /costs/sessions` can list recent sessions side by side. Each step is
   * best-effort and none of them may stop the session from ending.
   */
  private async emitSessionCostReport(meta: SessionMeta): Promise<void> {
    await this.flushLlmSpend();
    const row = await this.buildSessionCostRow(meta, meta.ended_at ?? Date.now());
    // Single-line structured JSON so a log pipeline can parse it directly.
    // Contains no transcript content — sizes, ids, models and money only.
    console.log(`SESSION_COST ${JSON.stringify(row)}`);
    await this.ctx.storage.put("cost:report", row);
    try {
      const registry = this.env.REGISTRY_DO.get(this.env.REGISTRY_DO.idFromName("registry"));
      await registry.fetch("https://registry/_session_cost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row),
      });
    } catch (err) {
      console.error("session cost report: registry post failed:", err);
    }
  }

  /** Cached anti-abuse verdict from the per-user meter's last /_usage reply.
   * When set, the smart layer degrades exactly like a per-session budget
   * exhaustion (reuses the budget_exhausted status/gate). */
  private userOverCeiling = false;

  /** Whether the owning tenant is entitled to hosted analysis (fetched at
   * hello for owned, hosted-key sessions). A lapsed subscription degrades the
   * smart layer to on-device — see entitlement.ts.
   * Defaults true: BYOK, self-host, and operator sessions are never gated. */
  private userEntitled = true;

  /** True when this session's owner is a `pro-relay` identity: analysis is
   * DELIBERATELY local (userEntitled is forced false), so the blocked-analysis
   * status must read `relay_only`, not `subscription_inactive` — a relay user
   * never lapsed, and "Renew" would be wrong copy. See PLAN-PRO-LIVE-RELAY.md. */
  private relayOnly = false;

  /** This deployment is serving a RELAY identity (the plan said so), as opposed
   * to a self-hoster whose client merely asserted relay-only for its own
   * Worker. Drives the post-end retention ceiling — see `relayRetentionAction`. */
  private hostedRelay = false;

  /** Last analysis_status.state broadcast, so a budget-exhausted session
   * doesn't re-broadcast the same status on every silence gap. */
  private lastBroadcastAnalysisState: AnalysisStatusInfo["state"] | null = null;

  /** The user's own Anthropic key, from `hello.llm_api_key` — held in memory
   * and the connection's hibernation attachment, never general DO storage.
   * The attachment is discarded when the socket closes. */
  private clientLlmApiKey: string | null = null;

  /** BYOK provider + model for the client key (from hello.llm_provider /
   * llm_model). Only meaningful when clientLlmApiKey is set; the hosted path
   * runs whatever hostedLeg() resolves (LLM_PROVIDER, or the paid tier's
   * provider). In-memory, re-sent each hello. */
  private clientLlmProvider: ClientLlmProvider | null = null;
  private clientLlmModel: string | null = null;

  /** Cached `owner_user_id` of this session, set at hello. Present ⇒ this is a
   * hosted-tier session billed to OUR key, so it runs on HOSTED_PAID_MODEL
   * (Haiku 4.5 — ~3× cheaper, what makes the subscription viable) rather than
   * env.LLM_MODEL. null for operator/self-host sessions, which keep LLM_MODEL.
   * Restored with clientLlmApiKey from the connection attachment after a
   * hibernation wake. */
  private sessionOwnerUserId: string | null = null;

  private restoreSocketRuntime(ws: WebSocket): boolean {
    const attachment = ws.deserializeAttachment() as SessionSocketAttachment | null;
    const runtime = attachment?.runtime;
    if (runtime?.version !== 1) return false;
    this.clientLlmApiKey = runtime.clientLlmApiKey;
    this.clientLlmProvider = runtime.clientLlmProvider;
    this.clientLlmModel = runtime.clientLlmModel;
    this.sessionOwnerUserId = runtime.sessionOwnerUserId;
    this.userEntitled = runtime.userEntitled;
    this.relayOnly = runtime.relayOnly === true;
    this.hostedRelay = runtime.hostedRelay === true;
    this.userOverCeiling = runtime.userOverCeiling;
    return true;
  }

  private persistSocketRuntime(ws: WebSocket): void {
    const attachment = (ws.deserializeAttachment() as SessionSocketAttachment | null) ?? {};
    ws.serializeAttachment({
      ...attachment,
      runtime: {
        version: 1,
        clientLlmApiKey: this.clientLlmApiKey,
        clientLlmProvider: this.clientLlmProvider,
        clientLlmModel: this.clientLlmModel,
        sessionOwnerUserId: this.sessionOwnerUserId,
        userEntitled: this.userEntitled,
        relayOnly: this.relayOnly,
        hostedRelay: this.hostedRelay,
        userOverCeiling: this.userOverCeiling,
      },
    } satisfies SessionSocketAttachment);
  }

  private persistCeilingToConnectedSockets(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SessionSocketAttachment | null;
      if (attachment?.runtime?.version !== 1) continue;
      ws.serializeAttachment({
        ...attachment,
        runtime: { ...attachment.runtime, userOverCeiling: this.userOverCeiling },
      } satisfies SessionSocketAttachment);
    }
  }

  private hasUsableLlmKey(): boolean {
    return Boolean(this.clientLlmApiKey || this.env.LLM_API_KEY);
  }

  /** The model the HOSTED path runs on (i.e. when no client BYOK key is set).
   * Owned sessions → HOSTED_PAID_MODEL when configured; everyone else →
   * env.LLM_MODEL. The per-user meter prices by whatever this returns, so a
   * paid session is billed at the paid model's rate, not Sonnet's. */
  private hostedModel(): string {
    return this.sessionOwnerUserId && this.env.HOSTED_PAID_MODEL
      ? this.env.HOSTED_PAID_MODEL
      : this.env.LLM_MODEL;
  }

  /** Provider/endpoint/key for the HOSTED path (our key, no BYOK). Owned paid
   * sessions may run on the paid tier — e.g. GPT-5.6 Luna via the
   * OpenAI-compatible endpoint — when HOSTED_PAID_* says so; everyone else
   * runs the primary leg (LLM_PROVIDER at LLM_BASE_URL/LLM_API_KEY). Both
   * resolved by llm/hosted-config.ts hostedPaidLeg so the HTTP routes agree.
   * Model comes from hostedModel(), so metering and the actual call agree. */
  private hostedLeg(): { provider: LlmProvider; baseUrl: string; apiKey: string; model: string } {
    return { ...hostedPaidLeg(this.env, Boolean(this.sessionOwnerUserId)), model: this.hostedModel() };
  }

  /** The status for a BYOK selection `sessionLlmConfig` would refuse, or null
   * when the selection is usable. Checked before analysis so the refusal is a
   * status on the wire rather than an exception inside the analysis tick. */
  private clientSelectionError(): AnalysisStatusInfo | null {
    if (!this.clientLlmApiKey) return null;
    try {
      clientSelection(this.env, this.clientLlmProvider, this.clientLlmModel, this.hostedModel());
      return null;
    } catch (e) {
      if (e instanceof ClientLlmSelectionError) return { state: "llm_error", detail: e.message };
      throw e;
    }
  }

  private noLlmKeyStatus(): AnalysisStatusInfo {
    return {
      state: "no_llm_key",
      detail: "No LLM API key is configured for this session — enter one in Settings, or set LLM_API_KEY on the backend.",
    };
  }

  private subscriptionInactiveStatus(): AnalysisStatusInfo {
    return {
      state: "subscription_inactive",
      detail:
        "Your Cyrano subscription is inactive. Renew to restore the hosted copilot, or add your own API key in Settings for unlimited use. On-device transcription keeps working.",
    };
  }

  private relayOnlyStatus(): AnalysisStatusInfo {
    return {
      state: "relay_only",
      detail:
        "This session is relayed for live agent access; analysis runs on this device, not the server.",
    };
  }

  private llmConfig(): LlmConfig {
    return sessionLlmConfig(
      this.env,
      {
        apiKey: this.clientLlmApiKey,
        provider: this.clientLlmProvider,
        model: this.clientLlmModel,
      },
      this.hostedLeg(),
      {
        addUnits: (units) => {
          this.unflushedSpendUnits += units;
        },
        spend: this.ledger(),
        noteLeg: (leg) => this.noteServedLeg(leg),
      },
    );
  }

  /** Whether this session has already logged that the fallback leg served it.
   * One line per session, not per call: a primary that is out of credit fails
   * over on every single tick, and a log line per tick is noise, not signal. */
  private loggedFallbackServed = false;

  /** Records which leg actually served a hosted call. In-memory and lossy by
   * design (a hibernation wake resets it) — this is an operator breadcrumb, not
   * an accounting record; the accounting record is the per-leg `onUsage` above. */
  private noteServedLeg(leg: { provider: string; model: string; fallback: boolean }): void {
    if (!leg.fallback || this.loggedFallbackServed) return;
    this.loggedFallbackServed = true;
    console.warn(`session LLM served by FALLBACK leg ${leg.provider}/${leg.model}`);
  }

  private async llmSpendUsed(): Promise<number> {
    return (await this.ctx.storage.get<number>("llm:spend_units")) ?? 0;
  }

  private async llmBudgetExhausted(): Promise<boolean> {
    // Per-user anti-abuse ceiling degrades the same way as the per-session
    // budget, so the existing budget_exhausted status/gate covers both.
    if (this.userOverCeiling) return true;
    return (await this.llmSpendUsed()) >= SESSION_LLM_BUDGET_UNITS;
  }

  private async flushLlmSpend(): Promise<void> {
    // Snapshot and clear both accumulators before the first await. Usage from
    // an LLM call that completes while this flush is suspended then lands in
    // a fresh batch instead of being erased by a post-await reset. `take()` is
    // the ledger's version of that reset and is synchronous for the same
    // reason.
    const spendUnits = Math.round(this.unflushedSpendUnits);
    this.unflushedSpendUnits = 0;
    const delta = this.ledger().take();
    const costDelta = this.sessionCost().take();
    if (spendUnits <= 0 && isEmptyDelta(delta) && isEmptySessionCostDelta(costDelta)) return;

    // Per-session breakdown, folded into the persisted record. Same
    // tolerance as everything else here: a storage failure drops this
    // delta and never fails the pass that produced it.
    if (!isEmptySessionCostDelta(costDelta)) {
      try {
        await this.ctx.storage.transaction(async (txn) => {
          const prev = await txn.get<SessionCostState>("cost:session");
          await txn.put("cost:session", applySessionCost(prev, costDelta));
        });
      } catch (err) {
        console.error("failed to persist session cost", err);
      }
    }

    if (spendUnits > 0) {
      try {
        const total = await this.ctx.storage.transaction(async (txn) => {
          const current = (await txn.get<number>("llm:spend_units")) ?? 0;
          const next = current + spendUnits;
          await txn.put("llm:spend_units", next);
          return next;
        });
        if (total >= SESSION_LLM_BUDGET_UNITS) {
          console.log(`session LLM budget exhausted: ${total}/${SESSION_LLM_BUDGET_UNITS} units`);
        }
      } catch (err) {
        // Budget bookkeeping is best-effort. A transient storage failure must
        // not discard an analysis result the model already produced.
        console.error("failed to flush session LLM spend units", err);
      }
    }

    // Report OUR real-$ spend to the per-user, per-period meter (paid hosted
    // tier), with the provider+model breakdown that
    // explains it. Only reachable when this session has an owning tenant —
    // operator/self-host sessions never touch a per-user meter.
    //
    // A BYOK session now reaches this too, with a delta of ZERO micros and a
    // non-zero call count, so a subject who brings their own key is
    // distinguishable from one who is simply cheap (defect D5).
    //
    // Metering must never break a session, so any failure just drops this delta
    // (same "lose at most one tick" tolerance as the unit budget).
    if (!isEmptyDelta(delta)) {
      const meta = await this.getMeta();
      if (meta?.owner_user_id) {
        try {
          const registry = this.env.REGISTRY_DO.get(this.env.REGISTRY_DO.idFromName("registry"));
          const res = await registry.fetch("https://registry/_usage", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ user_id: meta.owner_user_id, ...spendDeltaToWire(delta) }),
          });
          const body = (await res.json().catch(() => ({}))) as { over_ceiling?: boolean };
          // Only a delta that spent OUR money may move the anti-abuse verdict.
          // A BYOK-only report must not: the ceiling exists to bound OUR bill,
          // and letting a BYOK session adopt the flag would degrade a session
          // that is costing us nothing to `budget_exhausted` — the same class of
          // wrong-cutoff this whole stage exists to prevent.
          if (delta.micros > 0) {
            this.userOverCeiling = body.over_ceiling === true;
            this.persistCeilingToConnectedSockets();
          }
        } catch {
          // drop the delta; never fail the session on a metering hiccup
        }
      }
    }
  }

  private budgetExhaustedStatus(): AnalysisStatusInfo {
    return {
      state: "budget_exhausted",
      detail: "This session hit its LLM spending ceiling; analysis is paused until the next session.",
    };
  }

  /** An analysis.result carrying only a status (empty extraction arrays),
   * deduped by state so a stuck session doesn't spam one per silence gap. */
  private broadcastStatusOnlyResult(
    sessionId: string,
    status: AnalysisStatusInfo,
    triggeredBySeq: number,
  ): void {
    if (this.lastBroadcastAnalysisState === status.state) return;
    this.lastBroadcastAnalysisState = status.state;
    this.broadcast({
      type: "analysis.result",
      session_id: sessionId,
      commitments: [],
      asks: [],
      subtext: [],
      suggestions: [],
      decisions: [],
      custom_items: [],
      detected_categories: [],
      analysis_status: status,
      triggered_by_seq: triggeredBySeq,
    });
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // socket already closed; nothing to do
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, message);
    }
  }
}

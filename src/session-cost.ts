// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Per-SESSION LLM cost — "what did this session cost, on which model, for
// which passes, per minute of conversation". The number you need when picking
// a hosted model on cost and margin.
//
// WHY A SECOND LEDGER NEXT TO usage.ts
// ------------------------------------
// The per-user meter (usage.ts) answers "what is this SUBJECT costing us this
// period" and is drained to the registry every tick. It keys on provider+model
// and deliberately not on the session or the pass: a subject's 30-day record
// is bounded at MAX_USAGE_LEGS buckets, and a per-session x per-pass breakdown
// would multiply that. It also only exists for OWNED sessions — an operator's
// own test session never touches a per-user meter at all, which is exactly the
// session you run when trying a candidate model.
//
// This file keeps a per-session record WITH the session: every priced usage
// block, keyed by (provider, model, pass), accumulated in memory between
// flushes, persisted in the Session DO, readable while the session is live
// (`GET /session/:id/cost`), logged as one `SESSION_COST {...}` line at session
// end, and reported to the registry so `GET /costs/sessions` lists recent
// sessions side by side with a per-model rollup.
//
// WHAT IS AND IS NOT HERE (BAR I7, same rules as costs.ts)
// --------------------------------------------------------
// Nothing new is collected from any client. A row carries the session id, the
// owner's user id (already on the session meta and already exposed by
// /session/:id/review), timing, transcript SIZE (segment and word counts —
// never text), and money. No device, no email, no content. `SessionCostRow`
// is a CLOSED shape; test/session-cost.test.ts pins its keys.
//
// ONE PRICE ARITHMETIC. This ledger never prices anything itself: it is an
// observer of the spend ledger (llm/spend.ts SpendObserver) and receives the
// same PricedUsage the per-user meter folds in, so the two views of a session
// cannot disagree by a micro-dollar. An unknown model arrives here already
// marked `estimated` (llm/pricing.ts, I4): the row lists it under
// `unpriced_models`, keeps its micro-dollars out of `priced_micros`, and
// carries them in `estimated_micros` — never $0, never a quiet bill.

import type { LlmCallInfo } from "./llm/client.js";
import { worseBasis, type PriceBasis, type PricedUsage } from "./llm/pricing.js";
import type { SpendObserver } from "./llm/spend.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Cap on charged (provider, model, pass) buckets one session stores. A session
 * touches a handful of passes (analysis, custom categories, whisper, the three
 * pull fallbacks) on one or two models (primary, maybe fallback), so this is
 * far above any real session — it exists so a proxy that rotates model ids
 * cannot grow the record without bound. Past it, the cheapest tail folds into
 * one {@link OVERFLOW_BUCKET} bucket, nothing is dropped, and the totals still
 * reconcile (the same rule as usage.ts MAX_USAGE_LEGS).
 */
export const MAX_SESSION_COST_BUCKETS = 48;
/** Separate, smaller cap for shadow (price-test) buckets, one per target. */
export const MAX_SESSION_COST_SHADOW_BUCKETS = 16;
export const OVERFLOW_BUCKET = "(other)";
/** Longest pass name stored. Tool names are short identifiers; a proxy that
 * echoes something enormous does not get to store it. */
const MAX_PASS_NAME = 64;
/** The pass recorded for a usage block whose call info was missing (an older
 * caller of `recordServed` that passed none). */
export const UNKNOWN_PASS = "(unknown)";

// ---------------------------------------------------------------------------
// Ledger — in-memory delta between flushes
// ---------------------------------------------------------------------------

/** One (provider, model, pass) bucket of a session's spend. */
export interface SessionCostBucket {
  /** Billing provider (llm/pricing.ts BillingProvider), or {@link OVERFLOW_BUCKET}. */
  provider: string;
  model: string;
  /** The forced tool that produced the block (LlmCallInfo.tool), or {@link OVERFLOW_BUCKET}. */
  pass: string;
  calls: number;
  /** All prompt-side tokens: fresh input + cache writes + cache reads. */
  inputTokens: number;
  outputTokens: number;
  micros: number;
  basis: PriceBasis;
  /** Price-test fan-out on our keys (usage.ts UsageLeg.shadow). Set only when
   * true, so a charged bucket carries no such key. */
  shadow?: true;
}

export interface SessionCostDelta {
  buckets: SessionCostBucket[];
  /** Calls served on a client-supplied key: zero of our dollars, still a fact. */
  byokCalls: number;
}

/** What the Session DO persists under `cost:session`. */
export interface SessionCostState {
  buckets: SessionCostBucket[];
  byokCalls: number;
}

export interface SessionCostLedger extends SpendObserver {
  /** Drain: everything accumulated since the last take, then empty. */
  take(): SessionCostDelta;
  /** Read without draining — for the live `/cost` read and for tests. */
  peek(): SessionCostDelta;
}

function bucketKey(provider: string, model: string, pass: string, shadow: boolean): string {
  return `${shadow ? "s" : "c"}|${provider}|${model}|${pass}`;
}

function passName(call: LlmCallInfo | undefined): string {
  const raw = call?.tool;
  return typeof raw === "string" && raw.length > 0 ? raw.slice(0, MAX_PASS_NAME) : UNKNOWN_PASS;
}

/**
 * The in-memory accumulator the Session DO hands to `createSpendLedger` as its
 * observer. `take()` drains, for the same reason the spend ledger's does: the
 * DO snapshots both before its first `await` so a block priced during the
 * flush lands in the next batch rather than being erased by a reset.
 */
export function createSessionCostLedger(): SessionCostLedger {
  const buckets = new Map<string, SessionCostBucket>();
  let byokCalls = 0;

  const add = (priced: PricedUsage, pass: string, shadow: boolean): void => {
    const key = bucketKey(priced.provider, priced.model, pass, shadow);
    const prev = buckets.get(key);
    if (prev) {
      prev.calls += 1;
      prev.inputTokens += priced.inputTokens;
      prev.outputTokens += priced.outputTokens;
      prev.micros += priced.micros;
      prev.basis = worseBasis(prev.basis, priced.basis);
      return;
    }
    buckets.set(key, {
      provider: priced.provider,
      model: priced.model,
      pass,
      calls: 1,
      inputTokens: priced.inputTokens,
      outputTokens: priced.outputTokens,
      micros: priced.micros,
      basis: priced.basis,
      ...(shadow ? { shadow: true as const } : {}),
    });
  };

  const snapshot = (): SessionCostDelta => ({
    buckets: [...buckets.values()].map((b) => ({ ...b })),
    byokCalls,
  });

  return {
    onServed(priced, call) {
      add(priced, passName(call), false);
    },
    onByok() {
      byokCalls += 1;
    },
    onShadow(priced) {
      // The shadow pass re-runs the combined analysis window on each target;
      // its call info never reaches the sink, and the pass is by construction
      // the analysis pass. Named as such rather than "(unknown)".
      add(priced, "extract_analysis", true);
    },
    take() {
      const out = snapshot();
      buckets.clear();
      byokCalls = 0;
      return out;
    },
    peek: snapshot,
  };
}

export function isEmptySessionCostDelta(d: SessionCostDelta): boolean {
  return d.buckets.length === 0 && d.byokCalls <= 0;
}

// ---------------------------------------------------------------------------
// Persisted state — merge and bound
// ---------------------------------------------------------------------------

function clampInt(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
  return v > 0 ? v : 0;
}

function isShadow(b: SessionCostBucket): boolean {
  return b.shadow === true;
}

function isOverflow(b: SessionCostBucket): boolean {
  return b.provider === OVERFLOW_BUCKET && b.model === OVERFLOW_BUCKET && b.pass === OVERFLOW_BUCKET;
}

function fold(into: SessionCostBucket, from: SessionCostBucket): SessionCostBucket {
  return {
    provider: into.provider,
    model: into.model,
    pass: into.pass,
    calls: into.calls + from.calls,
    inputTokens: into.inputTokens + from.inputTokens,
    outputTokens: into.outputTokens + from.outputTokens,
    micros: into.micros + from.micros,
    basis: worseBasis(into.basis, from.basis),
    ...(into.shadow ? { shadow: true as const } : {}),
  };
}

/** Bound one class (charged or shadow) to `cap`, folding the cheap tail into
 * one overflow bucket of that class. Classes never fold into each other. */
function boundClass(all: SessionCostBucket[], cap: number, shadow: boolean): SessionCostBucket[] {
  if (all.length <= cap) return all;
  const named = all.filter((b) => !isOverflow(b));
  const existingOverflow = all.filter(isOverflow);
  const kept = named.slice(0, cap - 1);
  const tail = [...named.slice(cap - 1), ...existingOverflow];
  let overflow: SessionCostBucket = {
    provider: OVERFLOW_BUCKET,
    model: OVERFLOW_BUCKET,
    pass: OVERFLOW_BUCKET,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    micros: 0,
    basis: "exact",
    ...(shadow ? { shadow: true as const } : {}),
  };
  for (const b of tail) overflow = fold(overflow, b);
  return [...kept, overflow];
}

/** Coerce a stored or in-memory bucket into a safe one. Mirrors usage.ts
 * normalizeUsageDelta: a basis we do not recognise reads `estimated`. */
function normalizeBucket(raw: Partial<SessionCostBucket> | null | undefined): SessionCostBucket {
  return {
    provider: String(raw?.provider ?? "unknown").slice(0, 64),
    model: String(raw?.model ?? "unknown").slice(0, 128),
    pass: String(raw?.pass ?? UNKNOWN_PASS).slice(0, MAX_PASS_NAME),
    calls: clampInt(raw?.calls),
    inputTokens: clampInt(raw?.inputTokens),
    outputTokens: clampInt(raw?.outputTokens),
    micros: clampInt(raw?.micros),
    basis: raw?.basis === "exact" || raw?.basis === "configured" ? raw.basis : "estimated",
    ...(raw?.shadow === true ? { shadow: true as const } : {}),
  };
}

function mergeBuckets(prev: SessionCostBucket[], next: SessionCostBucket[]): SessionCostBucket[] {
  const byKey = new Map<string, SessionCostBucket>();
  for (const raw of [...prev, ...next]) {
    const b = normalizeBucket(raw);
    const key = bucketKey(b.provider, b.model, b.pass, isShadow(b));
    const existing = byKey.get(key);
    byKey.set(key, existing ? fold(existing, b) : b);
  }
  // Highest spend first, deterministic tie-break: two identical inputs always
  // produce a byte-identical stored record.
  const all = [...byKey.values()].sort(
    (a, b) =>
      b.micros - a.micros ||
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model) ||
      a.pass.localeCompare(b.pass),
  );
  return [
    ...boundClass(all.filter((b) => !isShadow(b)), MAX_SESSION_COST_BUCKETS, false),
    ...boundClass(all.filter(isShadow), MAX_SESSION_COST_SHADOW_BUCKETS, true),
  ];
}

/** Fold a drained delta into the persisted state. Pure; returns the state to
 * store. `prev` undefined is a session that has spent nothing yet. */
export function applySessionCost(
  prev: SessionCostState | undefined,
  delta: SessionCostDelta,
): SessionCostState {
  return {
    buckets: mergeBuckets(prev?.buckets ?? [], delta.buckets),
    byokCalls: clampInt(prev?.byokCalls) + clampInt(delta.byokCalls),
  };
}

// ---------------------------------------------------------------------------
// The row — one session, wire shape
// ---------------------------------------------------------------------------

/** One provider+model rollup of a session's spend (snake_case, wire). */
export interface SessionCostLegRow {
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  micros: number;
  basis: PriceBasis;
}

/** One pass rollup of a session's spend. */
export interface SessionCostPassRow {
  pass: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  micros: number;
  basis: PriceBasis;
}

/**
 * One session's cost line. A CLOSED shape (test/session-cost.test.ts pins the
 * keys): nothing about a person beyond what /session/:id/review already
 * returns, and nothing about the conversation beyond its size.
 */
export interface SessionCostRow {
  session_id: string;
  /** The owning tenant, or null for an operator / self-host session. */
  owner_user_id: string | null;
  started_at: string;
  /** ISO 8601 when the session has ended; null while live. */
  ended_at: string | null;
  /** `ended_at - started_at` for an ended session; `now - started_at` live. */
  duration_ms: number;
  /** Transcript SIZE only — never its text. */
  transcript_segments: number;
  transcript_words: number;
  /** What the hosted leg resolved to for this session (HOSTED_PAID_MODEL for
   * an owned session, LLM_MODEL otherwise) — the model under test. The
   * `models` list says what ACTUALLY ran, which differs on a failover. */
  configured_provider: string;
  configured_model: string;
  // --- charged spend: our key, not shadow ---
  calls: number;
  input_tokens: number;
  output_tokens: number;
  /** Integer micro-dollars; `usd` is the same number for reading. */
  micros: number;
  usd: number;
  /** `usd / (duration_ms / 60000)`, or null when the session has no duration. */
  usd_per_minute: number | null;
  /** `usd / (transcript_words / 1000)`, or null when nothing was transcribed. */
  usd_per_1k_words: number | null;
  /** Least-trustworthy basis across the charged buckets; null when no call
   * was made on our key. */
  basis: PriceBasis | null;
  /** Micro-dollars priced from a listed rate (`exact` or `configured`). */
  priced_micros: number;
  /** Micro-dollars priced at the defensive estimate because the model has no
   * listed rate. NOT a bill; see `unpriced_models`. */
  estimated_micros: number;
  /** `provider/model` ids that ran with no listed rate. Non-empty means the
   * cost figures for this session are partly a guess; add the model to
   * llm/pricing.ts to make them real. */
  unpriced_models: string[];
  models: SessionCostLegRow[];
  passes: SessionCostPassRow[];
  // --- the rest ---
  byok_calls: number;
  shadow_micros: number;
  shadow_models: SessionCostLegRow[];
}

/** Everything the row needs from the session that the ledger does not know. */
export interface SessionCostContext {
  sessionId: string;
  ownerUserId: string | null;
  createdAt: number;
  endedAt: number | null;
  now: number;
  transcriptSegments: number;
  transcriptWords: number;
  configured: { provider: string; model: string };
}

const MICROS_PER_USD = 1_000_000;

function usdOf(micros: number): number {
  return Math.round(micros) / MICROS_PER_USD;
}

/** USD per unit, to 6 places, or null when there are no units to divide by.
 * `micros / units` is micro-dollars per unit; rounding it to an integer and
 * dividing by 1e6 is "USD to six decimal places" in one step. */
function usdPer(micros: number, units: number): number | null {
  if (!(units > 0)) return null;
  return Math.round(micros / units) / MICROS_PER_USD;
}

function rollupBy<K extends string>(
  buckets: SessionCostBucket[],
  keyOf: (b: SessionCostBucket) => K,
): Map<K, { calls: number; inputTokens: number; outputTokens: number; micros: number; basis: PriceBasis }> {
  const out = new Map<K, { calls: number; inputTokens: number; outputTokens: number; micros: number; basis: PriceBasis }>();
  for (const b of buckets) {
    const key = keyOf(b);
    const cur = out.get(key);
    if (cur) {
      cur.calls += b.calls;
      cur.inputTokens += b.inputTokens;
      cur.outputTokens += b.outputTokens;
      cur.micros += b.micros;
      cur.basis = worseBasis(cur.basis, b.basis);
    } else {
      out.set(key, {
        calls: b.calls,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        micros: b.micros,
        basis: b.basis,
      });
    }
  }
  return out;
}

function legRows(buckets: SessionCostBucket[]): SessionCostLegRow[] {
  const byModel = rollupBy(buckets, (b) => `${b.provider} ${b.model}`);
  return [...byModel.entries()]
    .map(([key, v]) => {
      const [provider, model] = key.split(" ") as [string, string];
      return {
        provider,
        model,
        calls: v.calls,
        input_tokens: v.inputTokens,
        output_tokens: v.outputTokens,
        micros: v.micros,
        basis: v.basis,
      };
    })
    .sort((a, b) => b.micros - a.micros || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function passRows(buckets: SessionCostBucket[]): SessionCostPassRow[] {
  const byPass = rollupBy(buckets, (b) => b.pass);
  return [...byPass.entries()]
    .map(([pass, v]) => ({
      pass,
      calls: v.calls,
      input_tokens: v.inputTokens,
      output_tokens: v.outputTokens,
      micros: v.micros,
      basis: v.basis,
    }))
    .sort((a, b) => b.micros - a.micros || a.pass.localeCompare(b.pass));
}

/** One session -> one row. Pure; every figure comes from `state` and `ctx`. */
export function sessionCostRow(state: SessionCostState | undefined, ctx: SessionCostContext): SessionCostRow {
  const buckets = (state?.buckets ?? []).map(normalizeBucket);
  const charged = buckets.filter((b) => !isShadow(b));
  const shadow = buckets.filter(isShadow);

  const calls = charged.reduce((s, b) => s + b.calls, 0);
  const micros = charged.reduce((s, b) => s + b.micros, 0);
  const estimatedMicros = charged.filter((b) => b.basis === "estimated").reduce((s, b) => s + b.micros, 0);
  const basis = charged.length > 0 ? charged.map((b) => b.basis).reduce(worseBasis) : null;
  const unpriced = [...new Set(charged.filter((b) => b.basis === "estimated").map((b) => `${b.provider}/${b.model}`))].sort();

  const endedAt = ctx.endedAt;
  const durationMs = Math.max(0, (endedAt ?? ctx.now) - ctx.createdAt);
  const words = clampInt(ctx.transcriptWords);

  return {
    session_id: ctx.sessionId,
    owner_user_id: ctx.ownerUserId,
    started_at: new Date(ctx.createdAt).toISOString(),
    ended_at: endedAt === null ? null : new Date(endedAt).toISOString(),
    duration_ms: durationMs,
    transcript_segments: clampInt(ctx.transcriptSegments),
    transcript_words: words,
    configured_provider: ctx.configured.provider,
    configured_model: ctx.configured.model,
    calls,
    input_tokens: charged.reduce((s, b) => s + b.inputTokens, 0),
    output_tokens: charged.reduce((s, b) => s + b.outputTokens, 0),
    micros,
    usd: usdOf(micros),
    usd_per_minute: usdPer(micros, durationMs / 60_000),
    usd_per_1k_words: usdPer(micros, words / 1000),
    basis,
    priced_micros: micros - estimatedMicros,
    estimated_micros: estimatedMicros,
    unpriced_models: unpriced,
    models: legRows(charged),
    passes: passRows(charged),
    byok_calls: clampInt(state?.byokCalls),
    shadow_micros: shadow.reduce((s, b) => s + b.micros, 0),
    shadow_models: legRows(shadow),
  };
}

// ---------------------------------------------------------------------------
// Wire: a row posted by a Session DO to the registry, re-validated on receipt
// ---------------------------------------------------------------------------

/** Longest session id / user id the registry will store on a cost row. */
const MAX_ID = 128;

function optionalString(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function legRowFromWire(raw: unknown): SessionCostLegRow {
  const l = (raw ?? {}) as Record<string, unknown>;
  return {
    provider: String(l.provider ?? "unknown").slice(0, 64),
    model: String(l.model ?? "unknown").slice(0, 128),
    calls: clampInt(l.calls),
    input_tokens: clampInt(l.input_tokens),
    output_tokens: clampInt(l.output_tokens),
    micros: clampInt(l.micros),
    basis: l.basis === "exact" || l.basis === "configured" ? l.basis : "estimated",
  };
}

function passRowFromWire(raw: unknown): SessionCostPassRow {
  const l = (raw ?? {}) as Record<string, unknown>;
  return {
    pass: String(l.pass ?? UNKNOWN_PASS).slice(0, MAX_PASS_NAME),
    calls: clampInt(l.calls),
    input_tokens: clampInt(l.input_tokens),
    output_tokens: clampInt(l.output_tokens),
    micros: clampInt(l.micros),
    basis: l.basis === "exact" || l.basis === "configured" ? l.basis : "estimated",
  };
}

/**
 * Decode a row off the registry's internal `_session_cost` POST. The route is
 * DO-to-DO, but a body is a body: every field is rebuilt with its type and
 * bound, array lengths are capped at the bucket caps, and the derived money
 * columns (`usd`, `usd_per_minute`, `usd_per_1k_words`, `priced_micros`) are
 * RECOMPUTED from the integers so a row cannot claim a rate its own breakdown
 * does not support. Returns null without a usable `session_id` or
 * `started_at` — there is nothing to file it under.
 */
export function sessionCostRowFromWire(raw: unknown): SessionCostRow | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const sessionId = optionalString(r.session_id, MAX_ID);
  const startedAt = isoOrNull(r.started_at);
  if (!sessionId || !startedAt) return null;
  const endedAt = isoOrNull(r.ended_at);
  const micros = clampInt(r.micros);
  const estimated = Math.min(micros, clampInt(r.estimated_micros));
  const durationMs = clampInt(r.duration_ms);
  const words = clampInt(r.transcript_words);
  const models = (Array.isArray(r.models) ? r.models : []).slice(0, MAX_SESSION_COST_BUCKETS).map(legRowFromWire);
  const passes = (Array.isArray(r.passes) ? r.passes : []).slice(0, MAX_SESSION_COST_BUCKETS).map(passRowFromWire);
  const shadowModels = (Array.isArray(r.shadow_models) ? r.shadow_models : [])
    .slice(0, MAX_SESSION_COST_SHADOW_BUCKETS)
    .map(legRowFromWire);
  const unpriced = (Array.isArray(r.unpriced_models) ? r.unpriced_models : [])
    .filter((m): m is string => typeof m === "string")
    .slice(0, MAX_SESSION_COST_BUCKETS)
    .map((m) => m.slice(0, 200));
  const basis =
    r.basis === "exact" || r.basis === "configured" || r.basis === "estimated" ? r.basis : models.length > 0 ? "estimated" : null;
  return {
    session_id: sessionId,
    owner_user_id: optionalString(r.owner_user_id, MAX_ID),
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    transcript_segments: clampInt(r.transcript_segments),
    transcript_words: words,
    configured_provider: String(r.configured_provider ?? "unknown").slice(0, 64),
    configured_model: String(r.configured_model ?? "unknown").slice(0, 128),
    calls: clampInt(r.calls),
    input_tokens: clampInt(r.input_tokens),
    output_tokens: clampInt(r.output_tokens),
    micros,
    usd: usdOf(micros),
    usd_per_minute: usdPer(micros, durationMs / 60_000),
    usd_per_1k_words: usdPer(micros, words / 1000),
    basis,
    priced_micros: micros - estimated,
    estimated_micros: estimated,
    unpriced_models: unpriced,
    models,
    passes,
    byok_calls: clampInt(r.byok_calls),
    shadow_micros: clampInt(r.shadow_micros),
    shadow_models: shadowModels,
  };
}

// ---------------------------------------------------------------------------
// Report — recent sessions side by side, with a per-model rollup
// ---------------------------------------------------------------------------

/** Rows one `GET /costs/sessions` returns by default, and the most it will. */
export const DEFAULT_SESSION_COST_ROWS = 50;
export const MAX_SESSION_COST_ROWS = 200;
/** Ended-session rows the registry keeps, newest first; older ones are pruned
 * as new ones arrive. Bounds the registry's storage and the listing's scan. */
export const SESSION_COST_RETAINED_ROWS = 500;

export interface SessionCostModelTotals {
  provider: string;
  model: string;
  /** Sessions in which this model served at least one call. */
  sessions: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  micros: number;
  usd: number;
  /** Summed duration of the sessions this model appeared in. A session that
   * failed over mid-way counts its whole duration for BOTH models, so a
   * fallback-heavy cohort reads slightly cheap per minute on each. */
  duration_ms: number;
  usd_per_minute: number | null;
  transcript_words: number;
  usd_per_1k_words: number | null;
  basis: PriceBasis;
}

export interface SessionCostTotals {
  sessions: number;
  /** Sessions that made at least one call on our key. */
  sessions_with_cost: number;
  /** Sessions with at least one `unpriced_models` entry — how many rows the
   * money columns are partly a guess for. */
  sessions_with_unpriced: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  micros: number;
  usd: number;
  priced_micros: number;
  estimated_micros: number;
  duration_ms: number;
  transcript_words: number;
  usd_per_minute: number | null;
  usd_per_1k_words: number | null;
  byok_calls: number;
  shadow_micros: number;
}

export interface SessionCostReport {
  generated_at: string;
  returned: number;
  limit: number;
  /** The listing covers at most {@link SESSION_COST_RETAINED_ROWS} ended
   * sessions; older ones are gone. */
  retained_rows: number;
  totals: SessionCostTotals;
  /** Per provider+model across every returned session, most spend first —
   * the table to read when choosing a model on cost. */
  by_model: SessionCostModelTotals[];
  sessions: SessionCostRow[];
}

export function emptySessionCostTotals(): SessionCostTotals {
  return {
    sessions: 0,
    sessions_with_cost: 0,
    sessions_with_unpriced: 0,
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    micros: 0,
    usd: 0,
    priced_micros: 0,
    estimated_micros: 0,
    duration_ms: 0,
    transcript_words: 0,
    usd_per_minute: null,
    usd_per_1k_words: null,
    byok_calls: 0,
    shadow_micros: 0,
  };
}

/** Compose the report over rows the registry already holds, newest first. */
export function summarizeSessionCosts(
  rows: SessionCostRow[],
  opts: { now: number; limit: number },
): SessionCostReport {
  const limit = Math.max(1, Math.min(MAX_SESSION_COST_ROWS, Math.floor(opts.limit)));
  const sessions = rows.slice(0, limit);
  const totals = emptySessionCostTotals();
  const byModel = new Map<string, SessionCostModelTotals>();

  for (const row of sessions) {
    totals.sessions += 1;
    if (row.calls > 0) totals.sessions_with_cost += 1;
    if (row.unpriced_models.length > 0) totals.sessions_with_unpriced += 1;
    totals.calls += row.calls;
    totals.input_tokens += row.input_tokens;
    totals.output_tokens += row.output_tokens;
    totals.micros += row.micros;
    totals.priced_micros += row.priced_micros;
    totals.estimated_micros += row.estimated_micros;
    totals.duration_ms += row.duration_ms;
    totals.transcript_words += row.transcript_words;
    totals.byok_calls += row.byok_calls;
    totals.shadow_micros += row.shadow_micros;

    for (const m of row.models) {
      const key = `${m.provider} ${m.model}`;
      const cur = byModel.get(key);
      if (cur) {
        cur.sessions += 1;
        cur.calls += m.calls;
        cur.input_tokens += m.input_tokens;
        cur.output_tokens += m.output_tokens;
        cur.micros += m.micros;
        cur.duration_ms += row.duration_ms;
        cur.transcript_words += row.transcript_words;
        cur.basis = worseBasis(cur.basis, m.basis);
      } else {
        byModel.set(key, {
          provider: m.provider,
          model: m.model,
          sessions: 1,
          calls: m.calls,
          input_tokens: m.input_tokens,
          output_tokens: m.output_tokens,
          micros: m.micros,
          usd: 0,
          duration_ms: row.duration_ms,
          usd_per_minute: null,
          transcript_words: row.transcript_words,
          usd_per_1k_words: null,
          basis: m.basis,
        });
      }
    }
  }

  totals.usd = usdOf(totals.micros);
  totals.usd_per_minute = usdPer(totals.micros, totals.duration_ms / 60_000);
  totals.usd_per_1k_words = usdPer(totals.micros, totals.transcript_words / 1000);

  const by_model = [...byModel.values()]
    .map((m) => ({
      ...m,
      usd: usdOf(m.micros),
      usd_per_minute: usdPer(m.micros, m.duration_ms / 60_000),
      usd_per_1k_words: usdPer(m.micros, m.transcript_words / 1000),
    }))
    .sort((a, b) => b.micros - a.micros || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  return {
    generated_at: new Date(opts.now).toISOString(),
    returned: sessions.length,
    limit,
    retained_rows: SESSION_COST_RETAINED_ROWS,
    totals,
    by_model,
    sessions,
  };
}

/** Clamp a caller-supplied integer into a bound, falling back on junk. */
export function clampSessionCostLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_SESSION_COST_ROWS;
  return Math.max(1, Math.min(MAX_SESSION_COST_ROWS, n));
}

/** The registry storage key for an ended session's row: zero-padded end time
 * first so a reverse prefix list is newest-first, then the id for uniqueness. */
export function sessionCostStorageKey(endedAtMs: number, sessionId: string): string {
  return `${SESSION_COST_KEY_PREFIX}${String(clampInt(endedAtMs)).padStart(15, "0")}:${sessionId}`;
}
export const SESSION_COST_KEY_PREFIX = "sessioncost:";

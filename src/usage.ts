// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Per-user, per-period LLM cost meter for the paid hosted tier (2026-07-13,
// paid-hosted contract). Pure logic, unit-testable without a Durable
// Object; RegistryDO persists the state and calls these.
//
// The product tier is "unlimited fair-use" — this is NOT a product quota. The
// only enforcement is an anti-abuse safety ceiling that stops a runaway or
// shared-login from an unbounded bill on our key. Flip it to a real product
// cap (or per-plan caps) from telemetry later.
//
// 2026-08-19: the meter also carries a per-provider+model BREAKDOWN, so an
// expensive subject shows WHY and not only how much (defect D3), plus a count
// of calls made on a client's own key, which cost us nothing but are not the
// same thing as no calls at all (defect D5).

import { worseBasis, type PriceBasis } from "./llm/pricing.js";

/** Rolling metering period. In P2 this aligns to the Stripe billing period;
 * until then it's a 30-day window from the first metered activity. "Activity",
 * not "spend", since 2026-08-19: a BYOK call reports zero micro-dollars and a
 * call count, and that report is what starts the window for a subject who only
 * ever brings their own key. */
export const USAGE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** Anti-abuse ceiling: micro-dollars of OUR LLM spend allowed per period ($25).
 * Far above any legitimate monthly use of the Haiku smart layer — a real heavy
 * user won't approach it; a 24/7 script or shared login will. */
export const USER_SAFETY_CEILING_MICROS = 25_000_000;

/**
 * Hard cap on how many provider+model buckets one subject's breakdown may
 * store. Bounds the record: a subject that somehow touches many models (an
 * operator sweeping HOSTED_PAID_MODEL, a BYOK-ish deployment pointing the
 * hosted leg at a proxy that rotates model ids) must not grow a StoredUser
 * without limit — a DO value has a 128 KiB ceiling and the user record carries
 * licensing state we cannot afford to lose to a fat breakdown.
 *
 * PAST THE CAP: the buckets are ranked by micro-dollars, the top
 * (cap - 1) are kept by name, and everything else is folded into ONE bucket
 * named {@link OVERFLOW_PROVIDER}/{@link OVERFLOW_MODEL}. Nothing is dropped —
 * the folded calls, tokens and micros are all still there, and the fold takes
 * the least-trustworthy basis of what it swallowed — so the totals still
 * reconcile exactly (I6); only the per-model IDENTITY of the small tail is
 * lost. The tail is by construction the cheap end of the subject's spend, which
 * is the part an operator asking "why is this subject expensive" needs least.
 */
export const MAX_USAGE_LEGS = 12;
/** Separate, smaller cap for the shadow class (see {@link UsageLeg.shadow}).
 * Shadow buckets are one per configured price-test target, so a handful is the
 * realistic ceiling; they get their own budget so they can never crowd the
 * subject's real spend out of the stored breakdown. */
export const MAX_SHADOW_USAGE_LEGS = 6;
export const OVERFLOW_PROVIDER = "(other)";
export const OVERFLOW_MODEL = "(other)";

/** One provider+model bucket of a subject's spend for the current period. */
export interface UsageLeg {
  /** Billing provider (llm/pricing.ts BillingProvider), or {@link OVERFLOW_PROVIDER}. */
  provider: string;
  model: string;
  /** Usage blocks attributed to this bucket. */
  calls: number;
  /** All prompt-side tokens: fresh input + cache writes + cache reads. */
  inputTokens: number;
  outputTokens: number;
  micros: number;
  basis: PriceBasis;
  /**
   * SHADOW SPEND: our money, on our keys, attributable to this subject's
   * session — but work the subject never asked for (the PRICE_TEST_TARGETS
   * fan-out, which re-runs each analysis window against candidate providers for
   * market measurement). Set only when true; a real serving leg omits the field
   * entirely, so a stored record and a wire body from before this existed are
   * byte-identical to what they were.
   *
   * Counted as a FACT and kept out of the CEILING. It lands in
   * `UsageState.shadowMicros`, never in `spendMicros`, because the anti-abuse
   * ceiling exists to bound what a subject can make us spend — degrading a
   * session to `budget_exhausted` over our own R&D fan-out would be the exact
   * wrong-cutoff bug this whole stage exists to prevent. Same shape as the BYOK
   * rule, one step further: BYOK is zero dollars and a count; shadow is real
   * dollars, attributed, and uncharged.
   */
  shadow?: true;
}

/** What a call site reports to the meter for one request or flush. */
export interface UsageDelta {
  /** Always equal to the sum of the NON-shadow `legs[].micros`. */
  micros: number;
  legs: UsageLeg[];
  /** Calls served on a client-supplied key: zero of our dollars, still a fact. */
  byokCalls: number;
  /** Always equal to the sum of the `shadow` `legs[].micros`. */
  shadowMicros: number;
}

export interface UsageState {
  /** ms; start of the current metering period. */
  periodStart: number;
  /** our LLM spend this period, micro-dollars. */
  spendMicros: number;
  /** our LLM spend all-time, micro-dollars. */
  lifetimeSpendMicros: number;
  /** This period's provider+model breakdown, capped at {@link MAX_USAGE_LEGS}
   * for real spend plus {@link MAX_SHADOW_USAGE_LEGS} for shadow.
   * Optional: records written before 2026-08-19 have none, and read as []. */
  legs?: UsageLeg[];
  /** This period's BYOK call count (zero dollars of ours). */
  byokCalls?: number;
  /** All-time BYOK call count. Kept across a period roll, like lifetime spend. */
  lifetimeByokCalls?: number;
  /** This period's SHADOW spend: real micro-dollars we spent on this subject's
   * traffic that the subject did not ask for and is not charged for
   * (see {@link UsageLeg.shadow}). Never included in `spendMicros`. */
  shadowMicros?: number;
  /** All-time shadow spend. Kept across a period roll, like lifetime spend. */
  lifetimeShadowMicros?: number;
}

export interface UsageView {
  spendMicros: number;
  lifetimeMicros: number;
  periodStart: number;
  overCeiling: boolean;
  ceilingMicros: number;
  /** This period's per-provider+model breakdown of CHARGED spend, highest
   * first. Shadow buckets are not in here — they are in `shadowLegs`. */
  legs: UsageLeg[];
  byokCalls: number;
  lifetimeByokCalls: number;
  /** Micro-dollars attributed to a (non-shadow) leg. Below `spendMicros` only
   * for spend accrued before the breakdown existed — the gap is legacy, not
   * loss. */
  attributedMicros: number;
  /** Attributed micro-dollars split by how much the figure can be trusted. */
  basisMicros: { exact: number; configured: number; estimated: number };
  /**
   * basisMicros.exact / attributedMicros, or NULL when nothing is attributed.
   *
   * This used to report 1 for an empty breakdown, which reads "100% of this
   * subject's spend is a published price" at precisely the moment the least is
   * known — and every pre-breakdown record is in exactly that state (spend, no
   * legs) for the rest of its current period. An honesty metric must not read
   * best when it knows nothing, so the no-data case is now explicitly no data.
   */
  exactFraction: number | null;
  /** This period's SHADOW spend: our dollars on this subject's traffic that the
   * subject never asked for and is not charged for ({@link UsageLeg.shadow}).
   * Excluded from `spendMicros` and from the ceiling verdict; reported so a
   * per-subject cost report is not silently short by it. */
  shadowMicros: number;
  lifetimeShadowMicros: number;
  /** Per provider+model breakdown of `shadowMicros`. */
  shadowLegs: UsageLeg[];
  /** What this subject ACTUALLY cost us this period: charged + shadow. The
   * number a cost report should sum across subjects. */
  totalCostMicros: number;
}

/** The current period's state, rolling to a fresh period (spend, breakdown and
 * BYOK count reset; lifetime totals kept) if the prior one has elapsed or none
 * exists. The breakdown is period-scoped on purpose: it exists to explain THIS
 * period's bill, and an all-time breakdown would be the unbounded thing
 * MAX_USAGE_LEGS is there to prevent. */
function rolled(prev: UsageState | undefined, now: number): UsageState {
  if (!prev || now - prev.periodStart >= USAGE_PERIOD_MS) {
    return {
      periodStart: now,
      spendMicros: 0,
      lifetimeSpendMicros: prev?.lifetimeSpendMicros ?? 0,
      legs: [],
      byokCalls: 0,
      lifetimeByokCalls: prev?.lifetimeByokCalls ?? 0,
      shadowMicros: 0,
      lifetimeShadowMicros: prev?.lifetimeShadowMicros ?? 0,
    };
  }
  return prev;
}

function clampInt(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
  return v > 0 ? v : 0;
}

function isOverflow(leg: UsageLeg): boolean {
  return leg.provider === OVERFLOW_PROVIDER && leg.model === OVERFLOW_MODEL;
}

function fold(into: UsageLeg, from: UsageLeg): UsageLeg {
  return {
    provider: into.provider,
    model: into.model,
    calls: into.calls + from.calls,
    inputTokens: into.inputTokens + from.inputTokens,
    outputTokens: into.outputTokens + from.outputTokens,
    micros: into.micros + from.micros,
    basis: worseBasis(into.basis, from.basis),
    ...(into.shadow ? { shadow: true as const } : {}),
  };
}

export function isShadowLeg(leg: UsageLeg): boolean {
  return leg.shadow === true;
}

/** Bound one CLASS of buckets (charged or shadow) to `cap`, folding the cheap
 * tail into a single overflow bucket of that same class. Classes are bounded
 * separately and never folded into each other: a merged overflow would put
 * shadow micro-dollars into a bucket the charged total sums, which is the one
 * thing the shadow split exists to prevent. */
function boundClass(all: UsageLeg[], cap: number, shadow: boolean): UsageLeg[] {
  if (all.length <= cap) return all;
  const named = all.filter((l) => !isOverflow(l));
  const existingOverflow = all.filter(isOverflow);
  const kept = named.slice(0, cap - 1);
  const tail = [...named.slice(cap - 1), ...existingOverflow];
  let overflow: UsageLeg = {
    provider: OVERFLOW_PROVIDER,
    model: OVERFLOW_MODEL,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    micros: 0,
    basis: "exact",
    ...(shadow ? { shadow: true as const } : {}),
  };
  for (const leg of tail) overflow = fold(overflow, leg);
  return [...kept, overflow];
}

/**
 * Merge `next` into `prev` bucket-by-bucket, then bound the result. Sorted
 * highest-spend-first with a deterministic tie-break so two identical inputs
 * always produce byte-identical stored records.
 *
 * The bucket key includes the shadow flag, so a charged `anthropic/haiku` leg
 * and a shadow `anthropic/haiku` leg stay two buckets — merging them would
 * silently move R&D dollars into the subject's bill.
 */
function mergeLegs(prev: UsageLeg[], next: UsageLeg[]): UsageLeg[] {
  const byKey = new Map<string, UsageLeg>();
  for (const leg of [...prev, ...next]) {
    const key = `${leg.shadow ? "s" : "c"}|${leg.provider} ${leg.model}`;
    const existing = byKey.get(key);
    byKey.set(key, existing ? fold(existing, leg) : { ...leg });
  }
  const all = [...byKey.values()].sort(
    (a, b) => b.micros - a.micros || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
  return [
    ...boundClass(all.filter((l) => !isShadowLeg(l)), MAX_USAGE_LEGS, false),
    ...boundClass(all.filter(isShadowLeg), MAX_SHADOW_USAGE_LEGS, true),
  ];
}

/** Coerce anything (including a body off the wire) into a safe UsageDelta.
 * `micros` is recomputed from the legs whenever legs are present, so a caller
 * cannot report a total that disagrees with its own breakdown. */
export function normalizeUsageDelta(raw: number | UsageDelta | null | undefined): UsageDelta {
  if (typeof raw === "number" || raw == null) {
    return { micros: clampInt(raw ?? 0), legs: [], byokCalls: 0, shadowMicros: 0 };
  }
  const legs: UsageLeg[] = (Array.isArray(raw.legs) ? raw.legs : [])
    // Bound the parse itself: this endpoint is internal (DO to DO), but a body
    // is a body. mergeLegs caps what is STORED; this caps what is examined.
    .slice(0, MAX_USAGE_LEGS * 8)
    .map((l) => ({
      provider: String(l?.provider ?? "unknown").slice(0, 64),
      model: String(l?.model ?? "unknown").slice(0, 128),
      calls: clampInt(l?.calls),
      inputTokens: clampInt(l?.inputTokens),
      outputTokens: clampInt(l?.outputTokens),
      micros: clampInt(l?.micros),
      basis: l?.basis === "exact" || l?.basis === "configured" ? l.basis : "estimated",
      // Only ever written when true, so a charged leg round-trips byte-identical
      // to the pre-shadow shape.
      ...(l?.shadow === true ? { shadow: true as const } : {}),
    }));
  const charged = legs.filter((l) => !isShadowLeg(l));
  const shadow = legs.filter(isShadowLeg);
  return {
    micros: legs.length > 0 ? charged.reduce((s, l) => s + l.micros, 0) : clampInt(raw.micros),
    legs,
    byokCalls: clampInt(raw.byokCalls),
    shadowMicros: legs.length > 0 ? shadow.reduce((s, l) => s + l.micros, 0) : clampInt(raw.shadowMicros),
  };
}

/**
 * Add a delta of spend, rolling the period first if it has elapsed. Accepts a
 * bare micro-dollar number (the pre-breakdown shape, still used by tests and by
 * any caller with nothing to attribute) or a full {@link UsageDelta}.
 * Returns the new state to persist.
 */
export function applyUsage(
  prev: UsageState | undefined,
  delta: number | UsageDelta,
  now: number,
): UsageState {
  const d = normalizeUsageDelta(delta);
  const base = rolled(prev, now);
  return {
    periodStart: base.periodStart,
    // Shadow micro-dollars are deliberately NOT in spendMicros: they are our
    // R&D fan-out, not the subject's bill, and spendMicros is what the
    // anti-abuse ceiling reads.
    spendMicros: base.spendMicros + d.micros,
    lifetimeSpendMicros: base.lifetimeSpendMicros + d.micros,
    legs: mergeLegs(base.legs ?? [], d.legs),
    byokCalls: (base.byokCalls ?? 0) + d.byokCalls,
    lifetimeByokCalls: (base.lifetimeByokCalls ?? 0) + d.byokCalls,
    shadowMicros: (base.shadowMicros ?? 0) + d.shadowMicros,
    lifetimeShadowMicros: (base.lifetimeShadowMicros ?? 0) + d.shadowMicros,
  };
}

/** Read the current period's usage (a record past its period reads as zero
 * spent) plus the ceiling verdict. Does not mutate. */
export function usageView(
  prev: UsageState | undefined,
  now: number,
  ceilingMicros = USER_SAFETY_CEILING_MICROS,
): UsageView {
  const s = rolled(prev, now);
  const stored = s.legs ?? [];
  const legs = stored.filter((l) => !isShadowLeg(l));
  const shadowLegs = stored.filter(isShadowLeg);
  const basisMicros = { exact: 0, configured: 0, estimated: 0 };
  // Basis is about how much the SUBJECT'S BILL can be trusted, so it is
  // computed over charged legs only; shadow legs carry their own basis inside
  // `shadowLegs` for a report that wants it.
  // `leg.basis` comes straight back off DO storage, and only the WIRE path
  // (normalizeUsageDelta) coerces an unrecognised basis. Every stored leg was
  // normalized on the way in, so this is unreachable today — but this is an
  // object-literal lookup on a string we did not re-validate, the same class as
  // defect D8, and reading it back is the cheaper half to make total. An
  // unrecognised basis drops its micros OUT of `attributedMicros` rather than
  // being counted as `exact`: the safe direction, and `exactFraction` then
  // describes only spend we can actually vouch for.
  for (const leg of legs) {
    if (Object.hasOwn(basisMicros, leg.basis)) basisMicros[leg.basis] += leg.micros;
  }
  const attributedMicros = basisMicros.exact + basisMicros.configured + basisMicros.estimated;
  const shadowMicros = s.shadowMicros ?? 0;
  return {
    spendMicros: s.spendMicros,
    lifetimeMicros: s.lifetimeSpendMicros,
    periodStart: s.periodStart,
    // Charged spend only — see UsageLeg.shadow for why our own fan-out must not
    // be able to push a subject into budget_exhausted.
    overCeiling: s.spendMicros >= ceilingMicros,
    ceilingMicros,
    legs,
    byokCalls: s.byokCalls ?? 0,
    lifetimeByokCalls: s.lifetimeByokCalls ?? 0,
    attributedMicros,
    basisMicros,
    exactFraction: attributedMicros > 0 ? basisMicros.exact / attributedMicros : null,
    shadowMicros,
    lifetimeShadowMicros: s.lifetimeShadowMicros ?? 0,
    shadowLegs,
    totalCostMicros: s.spendMicros + shadowMicros,
  };
}

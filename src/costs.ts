// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Per-subject cost attribution — "which users are costing us money and which
// ones aren't".
//
// WHAT A SUBJECT IS, AND WHY IT IS NOT A PERSON
// ---------------------------------------------
// The meter (usage.ts) keys on `userId`, the tenant identity a credential
// resolves to. This file turns that identity into something an operator can
// ACT on by attaching the PURCHASE RECORD THAT WAS ALREADY THERE — nothing is
// collected from any client for this, and nothing is added to the session
// `hello` (BAR invariant I7):
//   - App Store: `stripeSubscriptionId = "apple:<originalTransactionId>"`,
//     written from Apple's signed JWS in registry-do `appStoreLink`. That is
//     Apple's own opaque subscription identifier. It is NOT an Apple ID —
//     Apple never sends us one — and it is not an email, a name, or a device.
//     It is the string you paste into App Store Connect to find the same
//     subscription from the other side, which is the entire point.
//   - Stripe: `stripeCustomerId` / `stripeSubscriptionId`, already on the
//     record from the checkout webhook.
//   - Promo / operator-minted: the label the operator chose, plus the promo
//     expiry. The operator wrote the label; it tells them nothing new.
// The subject-identity rules are documented inline below.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
//   - PER-DEVICE cost. Sessions carry no device id, so attributing spend to a
//     device would require the client to start sending one. That is the one
//     thing the 2026-08-19 constraint ruled out. Device COUNT is reported
//     where licensing already keeps a device-bearing record (see
//     {@link deviceJoinFor}), and is `null` — "no licensing record joins to
//     this identity" — everywhere else, which is most subscribers.
//   - Any field of a licensing record beyond "is a device bound to it": no
//     device name, no customer email, no fingerprint. {@link CostRow} is a
//     closed shape and test/costs.test.ts pins its keys for exactly this
//     reason.
//   - BYOK dollars. There are none: a client-key call reports a call count and
//     zero micro-dollars by construction (usage.ts, defect D5). A subject with
//     500 BYOK calls and $0.00 is not a quiet user, and the report says so.

import { FREE_COLD_PLAN, MCP_PLAN, RELAY_PLAN, isEntitled } from "./entitlement.js";
import {
  USAGE_PERIOD_MS,
  USER_SAFETY_CEILING_MICROS,
  usageView,
  type UsageLeg,
  type UsageState,
} from "./usage.js";
import type { PriceBasis } from "./llm/pricing.js";

// ---------------------------------------------------------------------------
// Bounds. The registry holds an unbounded number of user records; a report
// that loads them all to sort them falls over at exactly the scale that makes
// the report worth running.
// ---------------------------------------------------------------------------

/** Subject rows one response returns. */
export const DEFAULT_COST_ROWS = 50;
export const MAX_COST_ROWS = 200;
/**
 * User records ONE request will read before it stops and hands back a cursor.
 * The scan is what bounds the request; {@link MAX_COST_ROWS} bounds the reply.
 * Past this the response carries `truncated: true` and a `next_cursor`, and
 * a caller can walk it — see {@link createCostCollector} for why
 * paging still yields the exact global top-N.
 */
export const DEFAULT_COST_SCAN = 2000;
export const MAX_COST_SCAN = 10000;

// ---------------------------------------------------------------------------
// Purchase-record linkage
// ---------------------------------------------------------------------------

/** Where this subject's money (if any) comes from. */
export type SubjectSource =
  | "apple"
  | "stripe"
  | "promo"
  | "license-relay"
  | "free-cold"
  | "operator";

/**
 * The purchase record already stored server-side for this subject. Every field
 * is read off the StoredUser; none is collected, derived from a client, or
 * looked up anywhere else.
 */
export interface PurchaseLink {
  source: SubjectSource;
  /**
   * Apple's `originalTransactionId`, unwrapped from the `apple:` prefix the
   * subscription index stores it under. Opaque, Apple-issued, per-subscription.
   * Paste it into App Store Connect to see the same subscription from Apple's
   * side. NOT an Apple ID, an email, or a device.
   */
  apple_original_transaction_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  /** ISO 8601, or null. Present → a comped promo/test key. */
  promo_expires_at: string | null;
  /** ISO 8601, or null. Apple states a paid-through date; Stripe does not. */
  sub_expires_at: string | null;
}

/** The StoredUser fields this report reads. Structurally a subset of
 * registry-do's `StoredUser` so the DO can pass records straight through. */
export interface CostSubjectRecord {
  userId: string;
  label: string;
  createdAt: number;
  plan?: string;
  subStatus?: string;
  subExpiresAt?: number;
  promoExpiresAt?: number;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  usage?: UsageState;
}

const APPLE_SUBSCRIPTION_PREFIX = "apple:";

export function purchaseLinkFor(u: CostSubjectRecord): PurchaseLink {
  const sub = u.stripeSubscriptionId;
  const apple = sub?.startsWith(APPLE_SUBSCRIPTION_PREFIX)
    ? sub.slice(APPLE_SUBSCRIPTION_PREFIX.length)
    : null;
  const common = {
    apple_original_transaction_id: apple,
    // The field name is Stripe's and the index it feeds is Stripe's, but an
    // Apple subscription is stored in it (registry-do appStoreLink says why).
    // Reporting it under `stripe_*` for an Apple subject would be a lie the
    // operator then has to remember, so Apple's id appears ONLY above.
    stripe_customer_id: apple ? null : (u.stripeCustomerId ?? null),
    stripe_subscription_id: apple ? null : (sub ?? null),
    promo_expires_at: isoOrNull(u.promoExpiresAt),
    sub_expires_at: isoOrNull(u.subExpiresAt),
  };
  if (apple) return { source: "apple", ...common };
  if (sub) return { source: "stripe", ...common };
  // A promo key with `months: 0` is unlimited and stores NO expiry (promo.ts
  // promoExpiryFromMonths), so the label prefix is the only signal left for
  // one minted without an operator-supplied label. A lifetime promo minted
  // WITH a custom label is indistinguishable from an operator tenant here, and
  // both are correctly "we are not being paid" — see revenueFor.
  if (u.promoExpiresAt != null || u.label.startsWith("promo_")) {
    return { source: "promo", ...common };
  }
  if (u.label.startsWith("relay_")) return { source: "license-relay", ...common };
  if (u.label.startsWith("freecold_")) return { source: "free-cold", ...common };
  return { source: "operator", ...common };
}

// ---------------------------------------------------------------------------
// Device linkage (counts only, from records licensing already keeps)
// ---------------------------------------------------------------------------

/**
 * How — and whether — a device-bearing licensing record joins to this subject.
 * Pure and label-derived, so the report needs no index and no scan of the
 * license/trial space to know which subjects can even be asked about.
 *
 *  - `license`: a `relay_<sha256(licenseKey)>` identity (registry-do
 *    `relayTokenForLicense`). The label CONTAINS the license's storage-key
 *    suffix, so the record is one point-read away, and a license holds at most
 *    one device slot — the answer is 0 or 1.
 *  - `self`: a `freecold_<sha256(deviceId)>` identity (registry-do
 *    `enrollFreeCold`). The identity IS one device, by construction.
 *  - `none`: an App Store or Stripe subscription, a promo key, or an operator
 *    tenant. A subscription is not device-bound — it is restored onto every
 *    device the buyer signs in on and we are told about none of them — so the
 *    honest answer is "not linked", never 0. Aggregate device counts for those
 *    populations are what `/adoption` is for.
 */
export type DeviceJoin =
  | { kind: "license"; licenseHash: string }
  | { kind: "self"; devices: number }
  | { kind: "none" };

/** A sha256 hex digest — the only shape either label suffix can legitimately
 * have, and the only shape allowed to become a storage-key suffix. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function deviceJoinFor(label: string): DeviceJoin {
  if (label.startsWith("relay_")) {
    const hash = label.slice("relay_".length);
    if (SHA256_HEX.test(hash)) return { kind: "license", licenseHash: hash };
  }
  if (label.startsWith("freecold_")) {
    const hash = label.slice("freecold_".length);
    if (SHA256_HEX.test(hash)) return { kind: "self", devices: 1 };
  }
  return { kind: "none" };
}

/** Where a row's `devices` figure came from, so "1" and "null" are readable. */
export type DeviceSource = "license" | "device-identity" | "none";

// ---------------------------------------------------------------------------
// Revenue — the other half of "is this subject paying us more than they cost us"
// ---------------------------------------------------------------------------

/**
 * LIST price per plan, USD per 30 days. The checked-in reporting defaults use
 * 2026-07-13 pricing: $1.99/mo billed annually ($23.88/yr), $4.99/mo monthly.
 *
 * THIS IS GROSS. It is what the customer is charged, not what lands in the
 * bank: Apple keeps 15–30%, Stripe roughly 3% + 30¢, and neither tax, refunds,
 * chargebacks, nor proration is visible from here. An operator who wants the
 * net figure sets PLAN_REVENUE_USD_PER_MONTH (see {@link planRevenueFromEnv})
 * — the doc quotes ~$1.85 / ~$4.24 net of Stripe fees. The report labels this
 * `revenue_basis: "configured"` for the same reason llm/pricing.ts labels a
 * rate it cannot cite: a number somebody chose must not read as a bill.
 *
 * The transport-only plans are 0 on purpose and not absent: `pro-relay` and
 * `mcp-plus` and `free-cold` are structurally barred from hosted LLM spend
 * (entitlement.ts RELAY_ONLY_PLANS), so their cost is ~0 and their recurring
 * revenue genuinely is 0 — a lifetime Pro license is a one-off purchase that
 * no per-period figure can honestly represent, and inventing a monthly number
 * for it would make the NET column fiction.
 */
export const DEFAULT_PLAN_REVENUE_USD_PER_MONTH: Readonly<Record<string, number>> = Object.freeze({
  annual: 1.99,
  monthly: 4.99,
  [RELAY_PLAN]: 0,
  [MCP_PLAN]: 0,
  [FREE_COLD_PLAN]: 0,
});

/** How much a revenue figure can be trusted, mirroring PriceBasis's job. */
export type RevenueBasis =
  /** A configured list price for a plan we sell. */
  | "configured"
  /** Structurally zero: a comped promo/test key, or a transport-only plan. */
  | "comped"
  /**
   * Structurally zero because the subject is NOT ENTITLED right now:
   * canceled / unpaid / expired, or `active` so far past its verified
   * paid-through date that entitlement.ts's silence backstop closed it.
   *
   * Zero and not the plan's list price. A lapsed subscriber still carries
   * `plan: "monthly"` on the record — that field says what they LAST bought,
   * not what they are paying — so pricing off the plan alone invented $4.99 a
   * month of revenue for someone billing us nothing, printed it beside
   * `entitled: false`, and folded it into the cohort total. That inverted the
   * report's answer to the second half of the question it exists to answer
   * ("which subjects AREN'T paying for what they cost") for precisely the
   * population it exists to catch, and it broke the FLOOR guarantee on
   * {@link CostTotals.net_micros} in the one direction nothing bounds.
   *
   * Zero and not `null`, for the same reason "comped" is zero: an unentitled
   * subject earning us nothing is a FACT we know, not data we lack.
   */
  | "lapsed"
  /** No plan, or a plan with no configured price. Reported as null, never 0 —
   * a subject we cannot price is not a subject earning nothing. */
  | "unknown";

/**
 * Operator override for the plan → USD/30-days map, as JSON:
 *   PLAN_REVENUE_USD_PER_MONTH = {"annual":1.85,"monthly":4.24}
 * Merged over {@link DEFAULT_PLAN_REVENUE_USD_PER_MONTH}, so naming one plan
 * leaves the others alone. Junk (unparseable, non-numeric, negative) is
 * ignored key by key rather than failing the whole report — an operator typo
 * must not take the cost report down.
 */
export function planRevenueFromEnv(
  env: { PLAN_REVENUE_USD_PER_MONTH?: string } | undefined,
): Record<string, number> {
  // NULL-PROTOTYPE. This map is looked up by `u.plan`, a string off a stored
  // user record, so a plan literally named "constructor" / "toString" /
  // "valueOf" would otherwise resolve to an inherited function. The `typeof
  // usd !== "number"` guard in revenueFor already catches that, but this is the
  // same class as defect D8 (an Object.prototype model key priced as a $0.00
  // bill at `exact`) and the cheapest place to make it unreachable is here.
  const out: Record<string, number> = Object.assign(
    Object.create(null) as Record<string, number>,
    DEFAULT_PLAN_REVENUE_USD_PER_MONTH,
  );
  const raw = env?.PLAN_REVENUE_USD_PER_MONTH;
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [plan, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[plan] = value;
    }
  } catch {
    // Unparseable → defaults. Silent by design: this runs inside a DO with no
    // operator watching, and a thrown report is worse than a defaulted one.
  }
  return out;
}

const MICROS_PER_USD = 1_000_000;

/**
 * What this subject pays us per 30 days, and how much that figure can be
 * trusted.
 *
 * `entitled` is {@link isEntitled}'s verdict for the same instant the row is
 * built, and it is not optional: `u.plan` records what a subject last BOUGHT,
 * which is not the same question as what they are paying now. Without the
 * verdict this function priced a canceled subscription at full list — see
 * {@link RevenueBasis}'s `lapsed` arm for what that broke.
 */
function revenueFor(
  u: CostSubjectRecord,
  purchase: PurchaseLink,
  usdPerMonth: Record<string, number>,
  entitled: boolean,
): { micros: number | null; basis: RevenueBasis } {
  // A comped key earns nothing whatever plan it carries — and that is a FACT,
  // not an absence of data, so it prices 0 rather than null. This is the row an
  // operator most wants to see: a tester quietly costing real dollars.
  // Checked BEFORE entitlement so an EXPIRED promo still reads "comped": the
  // number is the same 0 either way, and "comped" is the truer word for a key
  // that was never going to earn anything.
  if (purchase.source === "promo") return { micros: 0, basis: "comped" };
  // Not entitled → not paying, whatever the plan field still says. Operator and
  // self-hosted tenants (no subStatus, no promo) are entitled by construction
  // and never reach this line, so this arm is specifically the lapsed
  // subscriber the report exists to surface.
  if (!entitled) return { micros: 0, basis: "lapsed" };
  const plan = u.plan;
  if (!plan) return { micros: null, basis: "unknown" };
  const usd = usdPerMonth[plan];
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
    return { micros: null, basis: "unknown" };
  }
  return {
    micros: Math.round(usd * MICROS_PER_USD),
    basis: usd === 0 ? "comped" : "configured",
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One provider+model bucket, in the report's snake_case wire shape. */
export interface CostLegRow {
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  micros: number;
  basis: PriceBasis;
}

/**
 * One subject's line in the report. A CLOSED shape: test/costs.test.ts pins
 * this key set (and `purchase`'s) so a future field that would widen what the
 * operator view exposes about a person has to be argued for in a failing test
 * rather than slipped in (BAR I7).
 */
export interface CostRow {
  user_id: string;
  /** The registry label. For a subscriber this is derived from the purchase
   * record (`apple_<otid>` / `stripe_<sub>`); for an operator tenant it is
   * whatever the operator typed. Never an email, never a device. */
  label: string;
  first_seen_at: string;
  plan: string | null;
  sub_status: string | null;
  /** entitlement.ts's verdict, so a row that costs money while unentitled
   * (a lapse we are still serving) is visible rather than inferred. */
  entitled: boolean;
  purchase: PurchaseLink;
  /** Devices licensing already knows about for THIS identity, or null when no
   * licensing record joins to it. See {@link deviceJoinFor}. */
  devices: number | null;
  device_source: DeviceSource;
  /** ISO 8601 start of the metering period the current-period figures cover. */
  period_start: string;
  // --- current period ---
  /** Charged to this subject's meter (what the ceiling reads). */
  spend_micros: number;
  /** Our own price-test fan-out on this subject's traffic: real money, never
   * charged to them, never in `spend_micros` (usage.ts UsageLeg.shadow). */
  shadow_micros: number;
  /** What this subject actually cost us this period: charged + shadow. The
   * report sorts on this. */
  total_cost_micros: number;
  // --- all time ---
  lifetime_micros: number;
  lifetime_shadow_micros: number;
  lifetime_total_cost_micros: number;
  // --- provenance ---
  attributed_micros: number;
  basis_micros: { exact: number; configured: number; estimated: number };
  /** exact / attributed, or NULL when nothing is attributed. Null is the
   * honest answer for every record carrying spend from before the breakdown
   * existed (usage.ts D10) — a report that printed 1.00 there would claim
   * published prices for the spend it can explain least. */
  exact_fraction: number | null;
  byok_calls: number;
  lifetime_byok_calls: number;
  over_ceiling: boolean;
  legs: CostLegRow[];
  shadow_legs: CostLegRow[];
  // --- the answer to "are they paying more than they cost" ---
  /** GROSS list price for a WHOLE period (see {@link CostReport.period_days}),
   * before Apple's / Stripe's cut, tax, refunds and proration. 0 for a comped
   * or LAPSED subject; null when no price is known. This is the plan's sticker
   * price and is NOT comparable with the cost columns above, which cover only
   * the part of the period that has actually elapsed — use
   * {@link revenue_to_date_micros} for that. */
  revenue_micros: number | null;
  revenue_basis: RevenueBasis;
  /**
   * {@link revenue_micros} prorated to the elapsed share of THIS subject's
   * current metering period — the like-for-like counterpart of
   * `total_cost_micros`, which is itself period-to-date.
   *
   * Why this exists: cost accrues continuously from `period_start` while a
   * subscription is charged once for the whole period, so comparing a full
   * period's revenue against a few hours of cost made every subject look
   * maximally profitable on day 1 of its period and biased the cohort NET
   * optimistic by a factor nothing bounded. Proration is an ACCRUAL
   * CONVENTION, not a cash fact: nobody is billed by the hour, and a subject
   * who cancels tomorrow was still charged the whole period today.
   */
  revenue_to_date_micros: number | null;
  /** `revenue_to_date_micros - total_cost_micros`: period-to-date margin, both
   * sides covering the same elapsed window. Null when revenue is unknown —
   * never computed against a guessed revenue, so an unpriceable subject
   * reports its cost and declines to score it. */
  net_micros: number | null;
}

export interface CostTotals {
  subjects: number;
  /** Subjects that cost us anything at all this period (charged or shadow). */
  subjects_with_cost: number;
  /** Subjects whose only LLM calls this period ran on their own key. */
  byok_only_subjects: number;
  spend_micros: number;
  shadow_micros: number;
  total_cost_micros: number;
  lifetime_micros: number;
  lifetime_shadow_micros: number;
  lifetime_total_cost_micros: number;
  byok_calls: number;
  /** Sum of the GROSS per-period list price over subjects with a KNOWN revenue
   * figure only. Not comparable with the cost totals — see
   * {@link revenue_to_date_micros}. */
  revenue_micros: number;
  /** Sum of {@link CostRow.revenue_to_date_micros}: revenue accrued over the
   * same elapsed window the cost totals cover. This is the term `net_micros`
   * is computed from. */
  revenue_to_date_micros: number;
  /**
   * How many subjects contributed cost above AND have no revenue figure — the
   * number that says how far `net_micros` can be trusted.
   *
   * Cost-bearing only, deliberately. Counting every null-revenue subject
   * inflated this by the ratio of idle tenants to active ones (measured 62 vs
   * 9 on a real registry scan) and made the one number that qualifies NET
   * unreadable. A subject that spent nothing cannot move NET, so its unknown
   * revenue says nothing about how far NET can be trusted.
   */
  revenue_unknown_subjects: number;
  /**
   * `revenue_to_date_micros - total_cost_micros` — period-to-date margin.
   *
   * A FLOOR *with respect to unpriced revenue*: cost is summed over ALL scanned
   * subjects while revenue is summed only over the priceable ones, so the
   * subjects this report cannot price can only make the real figure better.
   * `revenue_unknown_subjects` says how many of those there are.
   *
   * It is NOT a floor on a whole period's margin, and must not be read as one:
   * both sides stop at `now`, so a cohort whose subjects are early in their
   * periods has booked most of its cost's worth of future revenue and none of
   * its future cost.
   */
  net_micros: number;
  over_ceiling: number;
}

export interface CostReport {
  generated_at: string;
  /** Length of the metering period the current-period columns cover, and the
   * period `revenue_micros` is quoted per. */
  period_days: number;
  ceiling_micros: number;
  /** User records read to produce this page. */
  scanned: number;
  returned: number;
  limit: number;
  scan_limit: number;
  /** True when the scan stopped on its bound rather than on the end of the
   * registry. `totals` then covers only what was scanned. */
  truncated: boolean;
  next_cursor: string | null;
  totals: CostTotals;
  subjects: CostRow[];
}

function isoOrNull(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function legRow(l: UsageLeg): CostLegRow {
  return {
    provider: l.provider,
    model: l.model,
    calls: l.calls,
    input_tokens: l.inputTokens,
    output_tokens: l.outputTokens,
    micros: l.micros,
    basis: l.basis,
  };
}

export interface CostRowOptions {
  now: number;
  /** Plan → USD per 30 days. {@link planRevenueFromEnv}. */
  revenueUsdPerMonth?: Record<string, number>;
  ceilingMicros?: number;
  /** Devices already resolved for this subject, when the caller could look one
   * up. Omitted → derived from the label alone ({@link deviceJoinFor}), which
   * answers for a free-cold identity and leaves a license identity null until
   * the DO point-reads its record. */
  devices?: number | null;
}

/**
 * How much of a subject's current metering period has elapsed, clamped to
 * 0..1. `usageView` rolls a stale period forward, so `periodStart` is always
 * at or before `now` in practice; the clamps are here because this multiplies
 * a revenue figure and a negative or >1 factor would silently fabricate money.
 */
function periodElapsedFraction(periodStart: number, now: number): number {
  if (!Number.isFinite(periodStart) || !Number.isFinite(now)) return 1;
  const elapsed = now - periodStart;
  if (!(elapsed > 0)) return 0;
  return Math.min(1, elapsed / USAGE_PERIOD_MS);
}

/** One subject → one row. Pure; every figure comes from `u` and the options. */
export function costRowFor(u: CostSubjectRecord, opts: CostRowOptions): CostRow {
  const ceiling = opts.ceilingMicros ?? USER_SAFETY_CEILING_MICROS;
  const view = usageView(u.usage, opts.now, ceiling);
  const purchase = purchaseLinkFor(u);
  const join = deviceJoinFor(u.label);
  const devices =
    opts.devices !== undefined ? opts.devices : join.kind === "self" ? join.devices : null;
  // ONE entitlement verdict, used twice: reported on the row AND fed to the
  // revenue side, so the row can never say `entitled: false` next to a full
  // list price. They were computed independently once, and the report claimed a
  // lapsed subscriber was our most profitable customer.
  const entitled = isEntitled(
    {
      subStatus: u.subStatus ?? null,
      promoExpiresAt: u.promoExpiresAt ?? null,
      subExpiresAt: u.subExpiresAt ?? null,
    },
    opts.now,
  );
  const revenue = revenueFor(
    u,
    purchase,
    opts.revenueUsdPerMonth ?? DEFAULT_PLAN_REVENUE_USD_PER_MONTH,
    entitled,
  );
  const totalCost = view.totalCostMicros;
  // Cost is period-to-date; a plan price is per whole period. Compare like with
  // like or every subject reads as maximally profitable on day 1.
  const elapsed = periodElapsedFraction(view.periodStart, opts.now);
  const revenueToDate = revenue.micros === null ? null : Math.round(revenue.micros * elapsed);

  return {
    user_id: u.userId,
    label: u.label,
    first_seen_at: new Date(u.createdAt).toISOString(),
    plan: u.plan ?? null,
    sub_status: u.subStatus ?? null,
    entitled,
    purchase,
    devices,
    device_source: join.kind === "license" ? "license" : join.kind === "self" ? "device-identity" : "none",
    period_start: new Date(view.periodStart).toISOString(),
    spend_micros: view.spendMicros,
    shadow_micros: view.shadowMicros,
    total_cost_micros: totalCost,
    lifetime_micros: view.lifetimeMicros,
    lifetime_shadow_micros: view.lifetimeShadowMicros,
    lifetime_total_cost_micros: view.lifetimeMicros + view.lifetimeShadowMicros,
    attributed_micros: view.attributedMicros,
    basis_micros: view.basisMicros,
    exact_fraction: view.exactFraction,
    byok_calls: view.byokCalls,
    lifetime_byok_calls: view.lifetimeByokCalls,
    over_ceiling: view.overCeiling,
    legs: view.legs.map(legRow),
    shadow_legs: view.shadowLegs.map(legRow),
    revenue_micros: revenue.micros,
    revenue_basis: revenue.basis,
    revenue_to_date_micros: revenueToDate,
    net_micros: revenueToDate === null ? null : revenueToDate - totalCost,
  };
}

/** Most expensive first. Ties break on lifetime cost then user_id, so two runs
 * over the same data return the same order — a report whose rows shuffle
 * between runs is one an operator cannot diff. */
export function compareCostRows(a: CostRow, b: CostRow): number {
  return (
    b.total_cost_micros - a.total_cost_micros ||
    b.lifetime_total_cost_micros - a.lifetime_total_cost_micros ||
    (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0)
  );
}

export function emptyCostTotals(): CostTotals {
  return {
    subjects: 0,
    subjects_with_cost: 0,
    byok_only_subjects: 0,
    spend_micros: 0,
    shadow_micros: 0,
    total_cost_micros: 0,
    lifetime_micros: 0,
    lifetime_shadow_micros: 0,
    lifetime_total_cost_micros: 0,
    byok_calls: 0,
    revenue_micros: 0,
    revenue_to_date_micros: 0,
    revenue_unknown_subjects: 0,
    net_micros: 0,
    over_ceiling: 0,
  };
}

/** Fold one row into the running totals. Totals accumulate over EVERY scanned
 * subject, not only the rows that survive the top-N cut — otherwise "what does
 * this cohort cost" would silently mean "what do the 50 most expensive cost". */
export function accumulateCostTotals(totals: CostTotals, row: CostRow): void {
  totals.subjects += 1;
  if (row.total_cost_micros > 0) totals.subjects_with_cost += 1;
  if (row.total_cost_micros === 0 && row.byok_calls > 0) totals.byok_only_subjects += 1;
  totals.spend_micros += row.spend_micros;
  totals.shadow_micros += row.shadow_micros;
  totals.total_cost_micros += row.total_cost_micros;
  totals.lifetime_micros += row.lifetime_micros;
  totals.lifetime_shadow_micros += row.lifetime_shadow_micros;
  totals.lifetime_total_cost_micros += row.lifetime_total_cost_micros;
  totals.byok_calls += row.byok_calls;
  if (row.revenue_micros === null) {
    // Only a subject that actually SPENT something can weaken NET, so only such
    // a subject counts against it. Counting every idle unpriceable tenant made
    // this number ~7x the population it claims to describe, on a real scan.
    if (row.total_cost_micros > 0) totals.revenue_unknown_subjects += 1;
  } else {
    totals.revenue_micros += row.revenue_micros;
    totals.revenue_to_date_micros += row.revenue_to_date_micros ?? 0;
  }
  if (row.over_ceiling) totals.over_ceiling += 1;
  // Period-to-date on BOTH sides. See CostTotals.net_micros.
  totals.net_micros = totals.revenue_to_date_micros - totals.total_cost_micros;
}

/**
 * A bounded top-N accumulator.
 *
 * WHY NOT `records.map(costRowFor).sort()`: the registry's user space is
 * unbounded, and building one row object per user before sorting is the shape
 * that dies at scale — inside a Durable Object, on a 128 MiB budget, with the
 * whole registry (licensing, trials, ChatGPT tokens) sharing it.
 *
 * This keeps at most `2 * limit` rows alive: rows are pushed, and the buffer is
 * sorted and truncated back to `limit` whenever it doubles. Totals accumulate
 * over everything added, so bounding the ROWS never bounds the ARITHMETIC.
 *
 * PAGING STILL YIELDS THE EXACT GLOBAL TOP-N. A row in the global top-N is by
 * definition in its own page's top-N, so merging each page's returned rows and
 * re-ranking across pages reproduces the true ranking
 * — the cursor loses no row that could have placed.
 */
export interface CostCollector {
  add(record: CostSubjectRecord): void;
  readonly totals: CostTotals;
  /** Final, ranked, at most `limit` rows. */
  rows(): CostRow[];
}

export function createCostCollector(
  opts: CostRowOptions & { limit: number },
): CostCollector {
  const limit = Math.max(1, Math.min(MAX_COST_ROWS, Math.floor(opts.limit)));
  const totals = emptyCostTotals();
  let buffer: CostRow[] = [];

  return {
    add(record) {
      const row = costRowFor(record, opts);
      accumulateCostTotals(totals, row);
      buffer.push(row);
      if (buffer.length >= limit * 2) {
        buffer.sort(compareCostRows);
        buffer.length = limit;
      }
    },
    totals,
    rows() {
      buffer.sort(compareCostRows);
      if (buffer.length > limit) buffer = buffer.slice(0, limit);
      return buffer;
    },
  };
}

/** Clamp a caller-supplied integer into a bound, falling back on junk. */
export function clampCostParam(raw: string | null, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, n));
}

/**
 * Compose the pieces over an in-memory iterable. This is the shape tests drive
 * and the shape a small deployment gets in one page; RegistryDO uses
 * {@link createCostCollector} directly so it can page, bound its scan, and
 * resolve device counts for the surviving rows only.
 */
export function summarizeCosts(
  records: Iterable<CostSubjectRecord>,
  opts: CostRowOptions & { limit?: number; scanLimit?: number },
): CostReport {
  const limit = opts.limit ?? DEFAULT_COST_ROWS;
  const collector = createCostCollector({ ...opts, limit });
  let scanned = 0;
  for (const record of records) {
    collector.add(record);
    scanned += 1;
  }
  const subjects = collector.rows();
  return {
    generated_at: new Date(opts.now).toISOString(),
    period_days: Math.round(USAGE_PERIOD_MS / 86_400_000),
    ceiling_micros: opts.ceilingMicros ?? USER_SAFETY_CEILING_MICROS,
    scanned,
    returned: subjects.length,
    limit,
    scan_limit: opts.scanLimit ?? scanned,
    truncated: false,
    next_cursor: null,
    totals: collector.totals,
    subjects,
  };
}

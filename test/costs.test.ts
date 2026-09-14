// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Per-subject cost attribution (src/costs.ts + the GET /costs forwarding rule in
// src/index.ts). What is pinned
// here:
//
//   I7  NO NEW SUBJECT DATA. `CostRow` and `PurchaseLink` are CLOSED shapes:
//       the key sets below are asserted exactly, so a future field that widens
//       what the operator view exposes about a person has to be argued for in a
//       failing test rather than slipped in. Every value in a row comes off the
//       StoredUser that licensing/billing already wrote — nothing is collected
//       from a client, and the session `hello` is not touched.
//   D4  the report ENUMERATES subjects, ranked by what they cost us, which is
//       what `/usage` (one user_id at a time, and no way to learn which one to
//       ask about) could never do.
//   I6  reconciliation survives the report layer: a row's figures are the
//       meter's figures, and the totals are summed over every record SCANNED,
//       not over the top-N rows returned.
//
// Every micro-dollar below is derived by hand from the rate card or from the
// UsageState literal above it, never from running the implementation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COST_ROWS,
  DEFAULT_PLAN_REVENUE_USD_PER_MONTH,
  MAX_COST_ROWS,
  clampCostParam,
  compareCostRows,
  costRowFor,
  createCostCollector,
  deviceJoinFor,
  planRevenueFromEnv,
  purchaseLinkFor,
  summarizeCosts,
  type CostSubjectRecord,
} from "../src/costs.js";
import { costsQuery } from "../src/index.js";
import { RegistryDO } from "../src/registry-do.js";
import type { Env } from "../src/env.js";
import { USAGE_PERIOD_MS, USER_SAFETY_CEILING_MICROS, type UsageState } from "../src/usage.js";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** A 64-hex sha256, the only shape either device-bearing label suffix may have. */
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function record(over: Partial<CostSubjectRecord> = {}): CostSubjectRecord {
  return {
    userId: "u_1",
    label: "operator_test",
    createdAt: NOW - 10 * DAY,
    ...over,
  };
}

/** A meter state with a breakdown, written the way SpendLedger→applyUsage
 * writes one. Kept as a literal so the expected figures below are hand-summed
 * from something a reader can see rather than from the implementation. */
function usage(over: Partial<UsageState> = {}): UsageState {
  return {
    periodStart: NOW - 5 * DAY,
    spendMicros: 3_000,
    lifetimeSpendMicros: 9_000,
    legs: [
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        calls: 2,
        inputTokens: 1_000,
        outputTokens: 400,
        micros: 3_000,
        basis: "exact",
      },
    ],
    byokCalls: 0,
    lifetimeByokCalls: 0,
    shadowMicros: 0,
    lifetimeShadowMicros: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// I7 — the row is a closed shape
// ---------------------------------------------------------------------------

describe("I7: the operator row is a CLOSED shape over data already stored", () => {
  // Written out rather than derived, so widening the row fails HERE and a human
  // has to decide whether the new field is something we should be showing.
  const ROW_KEYS = [
    "user_id",
    "label",
    "first_seen_at",
    "plan",
    "sub_status",
    "entitled",
    "purchase",
    "devices",
    "device_source",
    "period_start",
    "spend_micros",
    "shadow_micros",
    "total_cost_micros",
    "lifetime_micros",
    "lifetime_shadow_micros",
    "lifetime_total_cost_micros",
    "attributed_micros",
    "basis_micros",
    "exact_fraction",
    "byok_calls",
    "lifetime_byok_calls",
    "over_ceiling",
    "legs",
    "shadow_legs",
    "revenue_micros",
    "revenue_basis",
    // Derived from revenue_micros and period_start — nothing new about a
    // person, and the term `net_micros` is actually computed from.
    "revenue_to_date_micros",
    "net_micros",
  ];

  const PURCHASE_KEYS = [
    "source",
    "apple_original_transaction_id",
    "stripe_customer_id",
    "stripe_subscription_id",
    "promo_expires_at",
    "sub_expires_at",
  ];

  it("exposes exactly these fields and no others", () => {
    const row = costRowFor(record({ usage: usage() }), { now: NOW });
    expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort());
    expect(Object.keys(row.purchase).sort()).toEqual([...PURCHASE_KEYS].sort());
  });

  it("carries no email, device id, name, fingerprint or transcript-derived string", () => {
    const row = costRowFor(
      record({
        label: `relay_${HASH_A}`,
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_456",
        usage: usage(),
      }),
      { now: NOW, devices: 1 },
    );
    const flat = JSON.stringify(row);
    // The label and the billing ids are the only free-form strings a row may
    // carry, and all three were already on the user record.
    for (const forbidden of ["@", "device_id", "deviceId", "fingerprint", "email"]) {
      expect(flat).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Purchase-record linkage — the SUBJECT IDENTITY constraint
// ---------------------------------------------------------------------------

describe("purchaseLinkFor: the purchase record already on the user record", () => {
  it("unwraps Apple's opaque original-transaction id and never files it under stripe_*", () => {
    const link = purchaseLinkFor(
      record({ stripeSubscriptionId: "apple:2000000912345678", stripeCustomerId: "cus_should_not_appear" }),
    );
    expect(link.source).toBe("apple");
    expect(link.apple_original_transaction_id).toBe("2000000912345678");
    // The field name is Stripe's and an Apple subscription is stored in it;
    // reporting it as a Stripe id would be a lie the operator has to remember.
    expect(link.stripe_subscription_id).toBeNull();
    expect(link.stripe_customer_id).toBeNull();
  });

  it("reports a Stripe subscriber under the Stripe ids and no Apple id", () => {
    const link = purchaseLinkFor(record({ stripeCustomerId: "cus_9", stripeSubscriptionId: "sub_9" }));
    expect(link).toMatchObject({
      source: "stripe",
      apple_original_transaction_id: null,
      stripe_customer_id: "cus_9",
      stripe_subscription_id: "sub_9",
    });
  });

  it("classifies a promo key by its expiry OR its minted label prefix", () => {
    expect(purchaseLinkFor(record({ promoExpiresAt: NOW + DAY })).source).toBe("promo");
    // A `months: 0` promo is unlimited and stores NO expiry (promo.ts), so the
    // label prefix is the only signal left for one minted without a label.
    expect(purchaseLinkFor(record({ label: "promo_lifetime" })).source).toBe("promo");
  });

  it("classifies the transport-only identities and falls back to operator", () => {
    expect(purchaseLinkFor(record({ label: `relay_${HASH_A}` })).source).toBe("license-relay");
    expect(purchaseLinkFor(record({ label: `freecold_${HASH_B}` })).source).toBe("free-cold");
    expect(purchaseLinkFor(record({ label: "jonathan_laptop" })).source).toBe("operator");
  });

  it("renders the two dates as ISO or null, never as a raw epoch", () => {
    const link = purchaseLinkFor(record({ promoExpiresAt: NOW + DAY, subExpiresAt: NOW + 2 * DAY }));
    expect(link.promo_expires_at).toBe(new Date(NOW + DAY).toISOString());
    expect(link.sub_expires_at).toBe(new Date(NOW + 2 * DAY).toISOString());
    expect(purchaseLinkFor(record({})).sub_expires_at).toBeNull();
  });
});

describe("deviceJoinFor: device COUNTS only, and only where licensing keeps one", () => {
  it("joins a relay identity to its license by the hash in its own label", () => {
    expect(deviceJoinFor(`relay_${HASH_A}`)).toEqual({ kind: "license", licenseHash: HASH_A });
  });

  it("knows a free-cold identity IS one device", () => {
    expect(deviceJoinFor(`freecold_${HASH_B}`)).toEqual({ kind: "self", devices: 1 });
  });

  it("refuses to turn a non-sha256 suffix into a storage-key lookup", () => {
    expect(deviceJoinFor("relay_../../license/oops")).toEqual({ kind: "none" });
    expect(deviceJoinFor(`relay_${HASH_A.toUpperCase()}`)).toEqual({ kind: "none" });
    expect(deviceJoinFor("relay_")).toEqual({ kind: "none" });
  });

  it("says NOT LINKED — never 0 — for a subscription, which is not device-bound", () => {
    expect(deviceJoinFor("apple_2000000912345678")).toEqual({ kind: "none" });
    const row = costRowFor(record({ label: "apple_2000000912345678", usage: usage() }), { now: NOW });
    expect(row.devices).toBeNull();
    expect(row.device_source).toBe("none");
  });

  it("self-reports the free-cold device without any lookup at all", () => {
    const row = costRowFor(record({ label: `freecold_${HASH_B}` }), { now: NOW });
    expect(row.devices).toBe(1);
    expect(row.device_source).toBe("device-identity");
  });
});

// ---------------------------------------------------------------------------
// Revenue — the other half of "are they paying more than they cost us"
// ---------------------------------------------------------------------------

describe("planRevenueFromEnv", () => {
  it("defaults to the locked list prices and merges an override key by key", () => {
    expect(planRevenueFromEnv(undefined)).toEqual(DEFAULT_PLAN_REVENUE_USD_PER_MONTH);
    const merged = planRevenueFromEnv({ PLAN_REVENUE_USD_PER_MONTH: '{"annual":1.85}' });
    expect(merged.annual).toBe(1.85);
    // Naming one plan leaves the others alone.
    expect(merged.monthly).toBe(DEFAULT_PLAN_REVENUE_USD_PER_MONTH.monthly);
  });

  it("ignores junk key by key rather than taking the report down", () => {
    for (const raw of ["not json", "[1,2,3]", '"a string"', '{"annual":"1.85"}', '{"annual":-3}']) {
      expect(planRevenueFromEnv({ PLAN_REVENUE_USD_PER_MONTH: raw }).annual).toBe(
        DEFAULT_PLAN_REVENUE_USD_PER_MONTH.annual,
      );
    }
  });

  it("keeps the transport-only plans at a real 0, not at absent", () => {
    const defaults = planRevenueFromEnv(undefined);
    expect(defaults["pro-relay"]).toBe(0);
    expect(defaults["mcp-plus"]).toBe(0);
    expect(defaults["free-cold"]).toBe(0);
  });
});

describe("revenue and net: a number nobody chose is null, never zero", () => {
  /** `usage()` starts its period 5 days before NOW, and a period is 30 days,
   * so a sixth of every subject's period has elapsed. Cost is period-to-date,
   * so revenue is accrued the same way before NET subtracts them. */
  const ELAPSED = (5 * DAY) / USAGE_PERIOD_MS;
  const toDate = (perPeriod: number) => Math.round(perPeriod * ELAPSED);

  it("prices a monthly subscriber at the configured list price and nets it against cost", () => {
    // monthly = $4.99/30d = 4_990_000 micro-$. Cost = 3_000 charged + 0 shadow.
    const row = costRowFor(record({ plan: "monthly", subStatus: "active", usage: usage() }), { now: NOW });
    expect(row.revenue_micros).toBe(4_990_000);
    expect(row.revenue_basis).toBe("configured");
    // The sticker price is the whole period; the cost beside it is five days.
    expect(row.revenue_to_date_micros).toBe(toDate(4_990_000));
    expect(row.net_micros).toBe(toDate(4_990_000) - 3_000);
  });

  it("accrues revenue with the period, so nobody is maximally profitable on day 1", () => {
    const fresh = costRowFor(
      record({ plan: "monthly", subStatus: "active", usage: usage({ periodStart: NOW }) }),
      { now: NOW },
    );
    expect(fresh.revenue_micros).toBe(4_990_000);
    expect(fresh.revenue_to_date_micros).toBe(0);
    expect(fresh.net_micros).toBe(-3_000);

    // …and a period at its very end accrues the whole figure, never more.
    const full = costRowFor(
      record({ plan: "monthly", subStatus: "active", usage: usage({ periodStart: NOW - USAGE_PERIOD_MS + 1 }) }),
      { now: NOW },
    );
    expect(full.revenue_to_date_micros).toBe(4_990_000);
    expect(full.revenue_to_date_micros).toBeLessThanOrEqual(full.revenue_micros!);

    // A period start in the FUTURE (a clock skew, a hand-edited record) must
    // clamp to zero rather than multiply revenue by a negative factor.
    const skewed = costRowFor(
      record({ plan: "monthly", subStatus: "active", usage: usage({ periodStart: NOW + DAY }) }),
      { now: NOW },
    );
    expect(skewed.revenue_to_date_micros).toBe(0);
  });

  it("reports a comped key as earning a REAL zero — the row an operator most wants", () => {
    const row = costRowFor(
      record({ plan: "monthly", promoExpiresAt: NOW + DAY, usage: usage({ spendMicros: 250_000 }) }),
      { now: NOW },
    );
    expect(row.revenue_basis).toBe("comped");
    expect(row.revenue_micros).toBe(0);
    expect(row.net_micros).toBe(-250_000);
  });

  it("declines to score a subject whose plan we cannot price", () => {
    const row = costRowFor(record({ plan: "some-future-plan", usage: usage() }), { now: NOW });
    expect(row.revenue_micros).toBeNull();
    expect(row.revenue_basis).toBe("unknown");
    // Cost is still reported; only the SCORE is withheld.
    expect(row.net_micros).toBeNull();
    expect(row.revenue_to_date_micros).toBeNull();
    expect(row.total_cost_micros).toBe(3_000);
  });

  it("has no plan at all → unknown, not free", () => {
    expect(costRowFor(record({}), { now: NOW }).revenue_basis).toBe("unknown");
  });

  // -------------------------------------------------------------------------
  // A LAPSED SUBSCRIPTION EARNS NOTHING.
  //
  // `plan` records what a subject last BOUGHT. Pricing off it alone printed a
  // canceled subscriber at $4.99 beside `entitled: false`, folded that phantom
  // revenue into the cohort total, and made the report's answer to "which
  // subjects AREN'T paying for what they cost" the exact inverse of the truth
  // for the one population it exists to catch.
  // -------------------------------------------------------------------------

  it("prices a CANCELED subscription at zero, not at the plan it used to be on", () => {
    const row = costRowFor(
      record({ plan: "monthly", subStatus: "canceled", usage: usage({ spendMicros: 51_600, legs: [] }) }),
      { now: NOW },
    );
    expect(row.entitled).toBe(false);
    expect(row.revenue_micros).toBe(0);
    expect(row.revenue_basis).toBe("lapsed");
    expect(row.revenue_to_date_micros).toBe(0);
    // Costs us money, earns nothing: NET is the cost, negative.
    expect(row.net_micros).toBe(-51_600);
  });

  it("prices an EXPIRED subscription, and an `active` one past its silence backstop, the same way", () => {
    const expired = costRowFor(
      record({ plan: "annual", subStatus: "expired", usage: usage({ spendMicros: 1_000, legs: [] }) }),
      { now: NOW },
    );
    expect(expired.entitled).toBe(false);
    expect(expired.revenue_micros).toBe(0);
    expect(expired.revenue_basis).toBe("lapsed");

    // `active`, but paid through a month ago and we were never told what
    // happened — entitlement.ts's RENEWAL_NOTICE_GRACE_MS backstop. Revenue
    // must follow that verdict rather than the status string.
    const silent = costRowFor(
      record({
        plan: "monthly",
        subStatus: "active",
        subExpiresAt: NOW - 30 * DAY,
        usage: usage({ spendMicros: 1_000, legs: [] }),
      }),
      { now: NOW },
    );
    expect(silent.entitled).toBe(false);
    expect(silent.revenue_basis).toBe("lapsed");
    expect(silent.net_micros).toBe(-1_000);
  });

  it("keeps paying subscribers priced — past_due is dunning grace, not a lapse", () => {
    for (const subStatus of ["active", "trialing", "past_due"]) {
      const row = costRowFor(record({ plan: "monthly", subStatus, usage: usage() }), { now: NOW });
      expect(row.entitled, subStatus).toBe(true);
      expect(row.revenue_basis, subStatus).toBe("configured");
      expect(row.revenue_micros, subStatus).toBe(4_990_000);
    }
  });

  it("never prints `entitled: false` beside a positive revenue figure, for any status", () => {
    // The invariant behind the two cases above, stated once over every status
    // string the registry can hold — including ones nobody has invented yet.
    for (const subStatus of ["active", "trialing", "past_due", "canceled", "unpaid", "expired", "paused", "weird"]) {
      const row = costRowFor(record({ plan: "monthly", subStatus, usage: usage() }), { now: NOW });
      if (!row.entitled) {
        expect(row.revenue_micros, subStatus).toBe(0);
        expect(row.net_micros, subStatus).toBeLessThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The figures are the meter's figures
// ---------------------------------------------------------------------------

describe("a row restates the meter without re-deciding anything", () => {
  it("keeps shadow spend out of the charge and inside the cost", () => {
    const row = costRowFor(
      record({
        usage: usage({
          spendMicros: 3_000,
          shadowMicros: 8_340,
          lifetimeSpendMicros: 9_000,
          lifetimeShadowMicros: 25_020,
          legs: [
            {
              provider: "anthropic",
              model: "claude-haiku-4-5",
              calls: 2,
              inputTokens: 1_000,
              outputTokens: 400,
              micros: 3_000,
              basis: "exact",
            },
            {
              provider: "openai",
              model: "gpt-5.6-luna",
              calls: 1,
              inputTokens: 1_000,
              outputTokens: 400,
              micros: 8_340,
              basis: "configured",
              shadow: true,
            },
          ],
        }),
      }),
      { now: NOW },
    );
    expect(row.spend_micros).toBe(3_000);
    expect(row.shadow_micros).toBe(8_340);
    expect(row.total_cost_micros).toBe(11_340);
    expect(row.lifetime_total_cost_micros).toBe(9_000 + 25_020);
    // The basis split is about the SUBJECT'S BILL, so the shadow leg is not in
    // it; it is reported separately, with its own basis.
    expect(row.legs).toHaveLength(1);
    expect(row.shadow_legs).toHaveLength(1);
    expect(row.basis_micros).toEqual({ exact: 3_000, configured: 0, estimated: 0 });
    expect(row.exact_fraction).toBe(1);
  });

  it("reports exact_fraction NULL for a legacy record with spend and no breakdown", () => {
    // The state EVERY production subject is in for the rest of its current
    // period on the day this ships. A row printing 1.00 here would claim
    // published prices for precisely the spend it can explain least.
    const row = costRowFor(
      record({ usage: { periodStart: NOW - DAY, spendMicros: 500_000, lifetimeSpendMicros: 500_000 } }),
      { now: NOW },
    );
    expect(row.spend_micros).toBe(500_000);
    expect(row.attributed_micros).toBe(0);
    expect(row.exact_fraction).toBeNull();
  });

  it("shows BYOK as a call count with zero dollars, so cheap and BYOK differ", () => {
    const row = costRowFor(
      record({ usage: usage({ spendMicros: 0, lifetimeSpendMicros: 0, legs: [], byokCalls: 40, lifetimeByokCalls: 512 }) }),
      { now: NOW },
    );
    expect(row.total_cost_micros).toBe(0);
    expect(row.byok_calls).toBe(40);
    expect(row.lifetime_byok_calls).toBe(512);
  });

  it("carries the ceiling verdict and the entitlement verdict, so a lapse that still costs money is visible", () => {
    const over = costRowFor(
      record({
        plan: "monthly",
        subStatus: "canceled",
        usage: usage({ spendMicros: USER_SAFETY_CEILING_MICROS + 1 }),
      }),
      { now: NOW },
    );
    expect(over.over_ceiling).toBe(true);
    expect(over.entitled).toBe(false);
    expect(over.total_cost_micros).toBeGreaterThan(0);
    // …and the money side agrees with the verdict on the same row. This test
    // used to stop one line above: it built a canceled subscriber, asserted it
    // was unentitled, and never looked at the $4.99 sitting beside that.
    expect(over.revenue_micros).toBe(0);
    expect(over.revenue_basis).toBe("lapsed");
    expect(over.net_micros).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Ranking and bounds
// ---------------------------------------------------------------------------

describe("ranking is by what a subject COST us, and is deterministic", () => {
  const rowWith = (userId: string, cost: number, lifetime = cost) =>
    costRowFor(record({ userId, usage: usage({ spendMicros: cost, lifetimeSpendMicros: lifetime, legs: [] }) }), {
      now: NOW,
    });

  it("sorts most expensive first, breaking ties on lifetime then user_id", () => {
    const rows = [rowWith("u_b", 10, 10), rowWith("u_a", 10, 99), rowWith("u_c", 500), rowWith("u_d", 10, 10)];
    const sorted = [...rows].sort(compareCostRows).map((r) => r.user_id);
    expect(sorted).toEqual(["u_c", "u_a", "u_b", "u_d"]);
    // Two runs over the same data return the same order — a report whose rows
    // shuffle between runs is one an operator cannot diff.
    expect([...rows].sort(compareCostRows).map((r) => r.user_id)).toEqual(sorted);
  });
});

describe("the collector is bounded in ROWS and unbounded in ARITHMETIC", () => {
  it("returns the true top-N while totalling every record added", () => {
    const collector = createCostCollector({ now: NOW, limit: 3 });
    for (let i = 0; i < 200; i++) {
      collector.add(
        record({ userId: `u_${String(i).padStart(3, "0")}`, usage: usage({ spendMicros: i, lifetimeSpendMicros: i, legs: [] }) }),
      );
    }
    const rows = collector.rows();
    expect(rows.map((r) => r.user_id)).toEqual(["u_199", "u_198", "u_197"]);
    // Totals cover EVERY subject scanned, not the three returned: otherwise
    // "what does this cohort cost" would silently mean "what do the top 3 cost".
    expect(collector.totals.subjects).toBe(200);
    expect(collector.totals.spend_micros).toBe((199 * 200) / 2);
    expect(collector.totals.total_cost_micros).toBe((199 * 200) / 2);
    // u_000 spends nothing.
    expect(collector.totals.subjects_with_cost).toBe(199);
  });

  it("counts a BYOK-only subject as activity with no cost", () => {
    const collector = createCostCollector({ now: NOW, limit: 5 });
    collector.add(record({ userId: "u_byok", usage: usage({ spendMicros: 0, lifetimeSpendMicros: 0, legs: [], byokCalls: 7 }) }));
    collector.add(record({ userId: "u_paid", usage: usage() }));
    expect(collector.totals.byok_only_subjects).toBe(1);
    expect(collector.totals.byok_calls).toBe(7);
    expect(collector.totals.subjects_with_cost).toBe(1);
  });

  it("clamps a caller-supplied limit into the bound instead of trusting it", () => {
    const collector = createCostCollector({ now: NOW, limit: 10_000 });
    for (let i = 0; i < MAX_COST_ROWS + 5; i++) {
      collector.add(record({ userId: `u_${i}`, usage: usage({ spendMicros: i + 1, legs: [] }) }));
    }
    expect(collector.rows().length).toBe(MAX_COST_ROWS);
  });

  it("net_micros is a FLOOR: unpriceable subjects are counted in cost, not in revenue", () => {
    const collector = createCostCollector({ now: NOW, limit: 10 });
    collector.add(record({ userId: "u_paid", plan: "monthly", usage: usage({ spendMicros: 1_000, legs: [] }) }));
    collector.add(record({ userId: "u_mystery", usage: usage({ spendMicros: 2_000, legs: [] }) }));
    expect(collector.totals.revenue_unknown_subjects).toBe(1);
    expect(collector.totals.revenue_micros).toBe(4_990_000);
    expect(collector.totals.total_cost_micros).toBe(3_000);
    // NET compares the same elapsed window on both sides: a sixth of the
    // period's revenue against a sixth of the period's worth of cost.
    const toDate = Math.round((4_990_000 * 5 * DAY) / USAGE_PERIOD_MS);
    expect(collector.totals.revenue_to_date_micros).toBe(toDate);
    expect(collector.totals.net_micros).toBe(toDate - 3_000);
  });

  it("counts only COST-BEARING subjects as revenue-unknown — the number that qualifies NET", () => {
    // A real registry is mostly idle tenants. Counting every unpriceable one
    // made this read 62 where 9 subjects had actually spent anything, which
    // inflated the one figure that tells an operator how far to trust NET.
    const collector = createCostCollector({ now: NOW, limit: 10 });
    collector.add(record({ userId: "u_spender", usage: usage({ spendMicros: 2_000, legs: [] }) }));
    for (let i = 0; i < 20; i++) {
      collector.add(record({ userId: `u_idle_${i}`, usage: usage({ spendMicros: 0, legs: [] }) }));
    }
    expect(collector.totals.subjects).toBe(21);
    expect(collector.totals.subjects_with_cost).toBe(1);
    expect(collector.totals.revenue_unknown_subjects).toBe(1);
  });

  it("a lapsed subscriber cannot inflate the cohort's revenue", () => {
    const collector = createCostCollector({ now: NOW, limit: 10 });
    collector.add(
      record({ userId: "u_live", plan: "monthly", subStatus: "active", usage: usage({ spendMicros: 1_000, legs: [] }) }),
    );
    collector.add(
      record({
        userId: "u_lapsed",
        plan: "monthly",
        subStatus: "expired",
        usage: usage({ spendMicros: 51_600, legs: [] }),
      }),
    );
    // One live subscription's list price, not two.
    expect(collector.totals.revenue_micros).toBe(4_990_000);
    expect(collector.totals.total_cost_micros).toBe(52_600);
    // The lapsed subject is priceable (a known zero), so it does NOT count
    // against NET's trustworthiness — it is IN the figure, at zero.
    expect(collector.totals.revenue_unknown_subjects).toBe(0);
    const toDate = Math.round((4_990_000 * 5 * DAY) / USAGE_PERIOD_MS);
    expect(collector.totals.net_micros).toBe(toDate - 52_600);
  });
});

describe("summarizeCosts: the whole report over an in-memory cohort", () => {
  it("reports the period, the ceiling, the scan and the ranked rows together", () => {
    const report = summarizeCosts(
      [
        record({ userId: "u_cheap", usage: usage({ spendMicros: 10, legs: [] }) }),
        record({ userId: "u_dear", usage: usage({ spendMicros: 900_000, legs: [] }) }),
      ],
      { now: NOW },
    );
    expect(report.generated_at).toBe(new Date(NOW).toISOString());
    expect(report.period_days).toBe(Math.round(USAGE_PERIOD_MS / 86_400_000));
    expect(report.ceiling_micros).toBe(USER_SAFETY_CEILING_MICROS);
    expect(report.scanned).toBe(2);
    expect(report.returned).toBe(2);
    expect(report.limit).toBe(DEFAULT_COST_ROWS);
    expect(report.subjects.map((s) => s.user_id)).toEqual(["u_dear", "u_cheap"]);
    expect(report.totals.total_cost_micros).toBe(900_010);
    // An in-memory cohort is never truncated: the caller handed us all of it.
    expect(report.truncated).toBe(false);
    expect(report.next_cursor).toBeNull();
  });
});

describe("clampCostParam", () => {
  it("clamps into the bound and falls back on junk", () => {
    expect(clampCostParam("25", 50, 200)).toBe(25);
    expect(clampCostParam("9999", 50, 200)).toBe(200);
    expect(clampCostParam("0", 50, 200)).toBe(1);
    expect(clampCostParam("-4", 50, 200)).toBe(1);
    for (const junk of [null, "", "abc", "NaN"]) expect(clampCostParam(junk, 50, 200)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// The forwarding rule (src/index.ts)
// ---------------------------------------------------------------------------

describe("costsQuery: an allowlist, re-encoded, never a pass-through", () => {
  const q = (search: string) => costsQuery(new URL(`https://api.example.com/costs${search}`));

  it("forwards exactly the three parameters _costs reads", () => {
    expect(q("?limit=10&scan=500&cursor=user%3Aalice")).toBe("?limit=10&scan=500&cursor=user%3Aalice");
    expect(q("")).toBe("");
  });

  it("drops everything else, including a parameter a future _costs might learn", () => {
    expect(q("?limit=5&user_id=victim&prefix=license:&debug=1")).toBe("?limit=5");
  });

  it("re-encodes rather than concatenating, so no second ? or # can travel", () => {
    // `url.search` would have carried this along verbatim into the internal
    // DO URL; URLSearchParams re-encodes it into one value of one parameter.
    const out = q("?cursor=user%3Aa%23frag%3Fmore%26scan%3D99999");
    expect(out.startsWith("?cursor=")).toBe(true);
    expect(out).not.toContain("#");
    expect(out.split("&")).toHaveLength(1);
  });

  it("length-caps the one parameter that is not a number", () => {
    const out = new URLSearchParams(q(`?cursor=${"x".repeat(4000)}`).slice(1));
    expect(out.get("cursor")!.length).toBe(512);
  });

  it("passes junk through the clamp rather than rejecting it — the DO decides", () => {
    // clampCostParam is what makes this safe; the allowlist only bounds WHAT
    // travels, never validates it twice in two places that could disagree.
    expect(q("?limit=abc")).toBe("?limit=abc");
    expect(clampCostParam("abc", DEFAULT_COST_ROWS, MAX_COST_ROWS)).toBe(DEFAULT_COST_ROWS);
  });
});

// ---------------------------------------------------------------------------
// The DO route (src/registry-do.ts `_costs`) — the bound, the cursor, and the
// one place a device count is actually looked up.
// ---------------------------------------------------------------------------

/**
 * In-memory storage, same harness shape as free-cold.test.ts / appstore-link
 * .test.ts — extended to honour `limit` and `startAfter`, because the whole
 * point of `_costs` is that it pages rather than loading the registry.
 */
class PagingStorage {
  readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list<T>({
    prefix,
    limit,
    startAfter,
  }: {
    prefix: string;
    limit?: number;
    startAfter?: string;
  }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const key of [...this.map.keys()].sort()) {
      if (!key.startsWith(prefix)) continue;
      if (startAfter !== undefined && key <= startAfter) continue;
      out.set(key, this.map.get(key) as T);
      if (limit !== undefined && out.size >= limit) break;
    }
    return out;
  }

  async transaction<T>(fn: (txn: PagingStorage) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function makeRegistry(env: Partial<Env> = {}) {
  const storage = new PagingStorage();
  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  } as unknown as DurableObjectState;
  return { registry: new RegistryDO(ctx, env as Env), storage };
}

async function costs(registry: RegistryDO, query = ""): Promise<any> {
  const res = await registry.fetch(new Request(`https://registry/_costs${query}`));
  expect(res.status).toBe(200);
  return res.json();
}

describe("RegistryDO /_costs: a bounded, resumable scan", () => {
  // The DO reads the wall clock, and the fixtures' `periodStart` (NOW - 5 days)
  // is a fixed date: once USAGE_PERIOD_MS elapsed past it in real time, every
  // period-to-date figure rolled to zero and this block failed on its own.
  // Pin the clock to the fixtures' NOW so the assertions describe the code,
  // not the calendar.
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ranks by cost, totals over everything SCANNED, and reports the bound honestly", async () => {
    const { registry, storage } = makeRegistry();
    // 5 subjects, ascending cost. Keys are `user:<label>` and the scan walks
    // them in key order, which is NOT cost order — that is the point.
    for (let i = 0; i < 5; i++) {
      await storage.put(`user:sub_${i}`, {
        userId: `u_${i}`,
        label: `sub_${i}`,
        hash: "irrelevant-token-hash",
        createdAt: NOW - DAY,
        usage: usage({ spendMicros: (i + 1) * 1_000, lifetimeSpendMicros: (i + 1) * 1_000, legs: [] }),
      });
    }
    const report = await costs(registry, "?limit=2");
    expect(report.subjects.map((s: any) => s.user_id)).toEqual(["u_4", "u_3"]);
    expect(report.returned).toBe(2);
    expect(report.scanned).toBe(5);
    // Totals cover all five, not the two returned.
    expect(report.totals.subjects).toBe(5);
    expect(report.totals.total_cost_micros).toBe(1_000 + 2_000 + 3_000 + 4_000 + 5_000);
    expect(report.truncated).toBe(false);
    expect(report.next_cursor).toBeNull();
    expect(report.period_days).toBe(Math.round(USAGE_PERIOD_MS / 86_400_000));
    expect(report.ceiling_micros).toBe(USER_SAFETY_CEILING_MICROS);
  });

  it("never reads the whole registry: a small --scan stops and hands back a cursor", async () => {
    const { registry, storage } = makeRegistry();
    for (let i = 0; i < 6; i++) {
      await storage.put(`user:sub_${i}`, {
        userId: `u_${i}`,
        label: `sub_${i}`,
        hash: "h",
        createdAt: NOW - DAY,
        usage: usage({ spendMicros: 100, lifetimeSpendMicros: 100, legs: [] }),
      });
    }
    const first = await costs(registry, "?scan=2&limit=10");
    expect(first.scanned).toBe(2);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toBe("user:sub_1");
    expect(first.totals.subjects).toBe(2);

    // Resuming from the cursor covers the rest and never repeats a subject —
    // which is what makes summing page totals across a paginated caller exact.
    const seen = new Set<string>(first.subjects.map((s: any) => s.user_id));
    let cursor = first.next_cursor;
    let pages = 1;
    while (cursor) {
      const page: any = await costs(registry, `?scan=2&limit=10&cursor=${encodeURIComponent(cursor)}`);
      for (const s of page.subjects) {
        expect(seen.has(s.user_id)).toBe(false);
        seen.add(s.user_id);
      }
      cursor = page.truncated ? page.next_cursor : null;
      pages += 1;
      expect(pages).toBeLessThan(10); // never spin
    }
    expect([...seen].sort()).toEqual(["u_0", "u_1", "u_2", "u_3", "u_4", "u_5"]);
  });

  it("point-reads a device count ONLY for a license identity, and only for returned rows", async () => {
    const { registry, storage } = makeRegistry();
    await storage.put(`license:${HASH_A}`, { device_id: "some-bound-device" });
    // A license whose device slot is empty: a purchase, not an install.
    await storage.put(`license:${HASH_B}`, {});
    await storage.put(`user:relay_${HASH_A}`, {
      userId: "u_bound",
      label: `relay_${HASH_A}`,
      hash: "h",
      createdAt: NOW - DAY,
      usage: usage({ spendMicros: 300, legs: [] }),
    });
    await storage.put(`user:relay_${HASH_B}`, {
      userId: "u_unbound",
      label: `relay_${HASH_B}`,
      hash: "h",
      createdAt: NOW - DAY,
      usage: usage({ spendMicros: 200, legs: [] }),
    });
    // An identity whose license is gone: we LOOKED, and there is none → 0.
    await storage.put(`user:relay_${"d".repeat(64)}`, {
      userId: "u_orphan",
      label: `relay_${"d".repeat(64)}`,
      hash: "h",
      createdAt: NOW - DAY,
      usage: usage({ spendMicros: 100, legs: [] }),
    });
    // A subscription is not device-bound, so it stays NOT LINKED, never 0.
    await storage.put("user:apple_2000000912345678", {
      userId: "u_apple",
      label: "apple_2000000912345678",
      hash: "h",
      createdAt: NOW - DAY,
      stripeSubscriptionId: "apple:2000000912345678",
      usage: usage({ spendMicros: 400, legs: [] }),
    });

    const report = await costs(registry, "?limit=10");
    const by = Object.fromEntries(report.subjects.map((s: any) => [s.user_id, s]));
    expect(by.u_bound.devices).toBe(1);
    expect(by.u_bound.device_source).toBe("license");
    expect(by.u_unbound.devices).toBe(0);
    expect(by.u_orphan.devices).toBe(0);
    expect(by.u_apple.devices).toBeNull();
    expect(by.u_apple.device_source).toBe("none");
    expect(by.u_apple.purchase.apple_original_transaction_id).toBe("2000000912345678");
  });

  it("reads the operator's revenue override off env, and prices a comped tester at zero", async () => {
    const { registry, storage } = makeRegistry({
      PLAN_REVENUE_USD_PER_MONTH: '{"monthly":4.24}',
    });
    await storage.put("user:paying", {
      userId: "u_pay",
      label: "paying",
      hash: "h",
      createdAt: NOW - DAY,
      plan: "monthly",
      subStatus: "active",
      usage: usage({ spendMicros: 1_000, legs: [] }),
    });
    await storage.put("user:promo_tester", {
      userId: "u_promo",
      label: "promo_tester",
      hash: "h",
      createdAt: NOW - DAY,
      plan: "monthly",
      promoExpiresAt: NOW + DAY,
      usage: usage({ spendMicros: 5_000_000, legs: [] }),
    });
    const report = await costs(registry, "?limit=10");
    const by = Object.fromEntries(report.subjects.map((s: any) => [s.user_id, s]));
    expect(by.u_pay.revenue_micros).toBe(4_240_000);
    expect(by.u_pay.revenue_basis).toBe("configured");
    // The row an operator most wants: a tester quietly costing real dollars.
    expect(by.u_promo.revenue_basis).toBe("comped");
    expect(by.u_promo.net_micros).toBe(-5_000_000);
    // The DO reads the wall clock, so assert the RELATIONSHIP rather than a
    // figure that would drift with the hour the suite is run in: revenue is
    // accrued over the elapsed part of the period and NET subtracts like from
    // like. (`u_promo` is comped, so it contributes 0 to both.)
    const payToDate = by.u_pay.revenue_to_date_micros;
    expect(payToDate).toBeGreaterThan(0);
    expect(payToDate).toBeLessThan(4_240_000);
    expect(by.u_pay.net_micros).toBe(payToDate - 1_000);
    expect(report.totals.revenue_to_date_micros).toBe(payToDate);
    expect(report.totals.net_micros).toBe(payToDate - 5_001_000);
  });

  it("never leaks the token hash or any other StoredUser field the row does not name", async () => {
    const { registry, storage } = makeRegistry();
    await storage.put("user:someone", {
      userId: "u_1",
      label: "someone",
      hash: "THE-SECRET-TOKEN-HASH",
      createdAt: NOW - DAY,
      usage: usage(),
    });
    const report = await costs(registry, "");
    expect(JSON.stringify(report)).not.toContain("THE-SECRET-TOKEN-HASH");
  });
});

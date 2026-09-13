// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  applyUsage,
  usageView,
  USAGE_PERIOD_MS,
  USER_SAFETY_CEILING_MICROS,
} from "../src/usage.js";

// Per-user LLM $ meter for the paid hosted tier. The product tier is
// "unlimited fair-use" — the only enforcement is the anti-abuse ceiling, so
// what's pinned here is: accrual within a period, period rollover, negative
// clamping, and that a lapsed period reads as zero (not stuck over-ceiling).

describe("applyUsage / usageView", () => {
  const t0 = 1_000_000_000_000;

  it("starts a period on first spend and accumulates within it", () => {
    let s = applyUsage(undefined, 500, t0);
    expect(s).toEqual({
      periodStart: t0,
      spendMicros: 500,
      lifetimeSpendMicros: 500,
      // A bare-number delta has nothing to attribute: the breakdown fields are
      // present and empty, never absent, so a stored record has one shape.
      legs: [],
      byokCalls: 0,
      lifetimeByokCalls: 0,
      // Shadow spend (our own price-test fan-out) is a separate channel from
      // the subject's charged spend and stays at zero unless one is recorded.
      shadowMicros: 0,
      lifetimeShadowMicros: 0,
    });
    s = applyUsage(s, 300, t0 + 1000);
    expect(s.spendMicros).toBe(800);
    expect(s.lifetimeSpendMicros).toBe(800);
    expect(s.periodStart).toBe(t0);
  });

  it("clamps negative / garbage deltas to zero", () => {
    expect(applyUsage(undefined, -100, t0).spendMicros).toBe(0);
    expect(applyUsage(undefined, Number.NaN, t0).spendMicros).toBe(0);
  });

  it("rolls the period after USAGE_PERIOD_MS: period spend resets, lifetime carries", () => {
    const s1 = applyUsage(undefined, 1000, t0);
    const s2 = applyUsage(s1, 400, t0 + USAGE_PERIOD_MS);
    expect(s2.periodStart).toBe(t0 + USAGE_PERIOD_MS);
    expect(s2.spendMicros).toBe(400);
    expect(s2.lifetimeSpendMicros).toBe(1400);
  });

  it("usageView flags over_ceiling and reads a lapsed period as zero", () => {
    const under = applyUsage(undefined, USER_SAFETY_CEILING_MICROS - 1, t0);
    expect(usageView(under, t0).overCeiling).toBe(false);

    const over = applyUsage(under, 1, t0);
    expect(usageView(over, t0).overCeiling).toBe(true);
    expect(usageView(over, t0).spendMicros).toBe(USER_SAFETY_CEILING_MICROS);

    // Same state read a full period later → rolled to a fresh period, so it's
    // not stuck over the ceiling.
    const later = usageView(over, t0 + USAGE_PERIOD_MS);
    expect(later.spendMicros).toBe(0);
    expect(later.overCeiling).toBe(false);
  });
});

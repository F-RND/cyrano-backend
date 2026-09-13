// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { generatePromoCode, promoExpiryFromMonths, PROMO_MONTH_MS } from "../src/promo.js";

describe("generatePromoCode", () => {
  it("formats CYRANO-XXXX-XXXX-XXXX from the unambiguous alphabet", () => {
    const code = generatePromoCode();
    // Groups drawn from A-H J-N P-Z 2-9 (no ambiguous 0/1/I/O). The positive
    // pattern already pins the charset; the "CYRANO" prefix itself contains an
    // O, so don't scan the whole string for excluded chars.
    expect(code).toMatch(/^CYRANO-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it("is unique across many calls", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generatePromoCode()));
    expect(codes.size).toBe(200);
  });

  it("honors a custom prefix", () => {
    expect(generatePromoCode("TEST")).toMatch(/^TEST-/);
  });
});

describe("promoExpiryFromMonths", () => {
  const now = 1_000_000_000_000;

  it("adds N months of milliseconds", () => {
    expect(promoExpiryFromMonths(1, now)).toBe(now + PROMO_MONTH_MS);
    expect(promoExpiryFromMonths(3, now)).toBe(now + 3 * PROMO_MONTH_MS);
    expect(promoExpiryFromMonths(12, now)).toBe(now + 12 * PROMO_MONTH_MS);
  });

  it("treats 0 / negative / invalid months as unlimited (null)", () => {
    expect(promoExpiryFromMonths(0, now)).toBeNull();
    expect(promoExpiryFromMonths(-2, now)).toBeNull();
    expect(promoExpiryFromMonths(Number.NaN, now)).toBeNull();
  });
});

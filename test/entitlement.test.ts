// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isEntitled, RENEWAL_NOTICE_GRACE_MS } from "../src/entitlement.js";

// A lapsed subscription degrades hosted analysis to on-device (2026-07-13), and
// a promo/test key is entitled until its expiry (2026-07-14). This pins the
// precedence: promo expiry wins, then Stripe status, then "never gated".

const T = 1_000_000_000_000;

describe("isEntitled", () => {
  it("grants hosted access for active / trialing / past_due (dunning grace)", () => {
    expect(isEntitled({ subStatus: "active" }, T)).toBe(true);
    expect(isEntitled({ subStatus: "trialing" }, T)).toBe(true);
    expect(isEntitled({ subStatus: "past_due" }, T)).toBe(true);
  });

  it("denies a canceled / unpaid / never-paid subscription", () => {
    expect(isEntitled({ subStatus: "canceled" }, T)).toBe(false);
    expect(isEntitled({ subStatus: "unpaid" }, T)).toBe(false);
    expect(isEntitled({ subStatus: "incomplete_expired" }, T)).toBe(false);
  });

  it("never gates a non-subscriber (operator/self-host tenant — no subStatus, no promo)", () => {
    expect(isEntitled({}, T)).toBe(true);
    expect(isEntitled({ subStatus: null }, T)).toBe(true);
  });

  it("promo key: entitled until promoExpiresAt, then not — and it takes precedence", () => {
    expect(isEntitled({ promoExpiresAt: T + 1000 }, T)).toBe(true);
    expect(isEntitled({ promoExpiresAt: T - 1000 }, T)).toBe(false);
    // An expired promo is not entitled even if a subStatus happens to be set.
    expect(isEntitled({ subStatus: "active", promoExpiresAt: T - 1 }, T)).toBe(false);
  });
});

// The paid-through backstop (2026-08-03). Status is only ever as fresh as the
// last webhook that landed; an App Store subscription whose renewal
// notification never arrives would otherwise read as active forever.
describe("isEntitled — the verified paid-through date", () => {
  it("keeps an active subscription entitled before its expiry", () => {
    expect(isEntitled({ subStatus: "active", subExpiresAt: T + 86_400_000 }, T)).toBe(true);
  });

  it("holds the line through the grace window, then lapses", () => {
    // A delivery hiccup must not lock out someone who paid, so the window
    // covers Apple's whole retry ladder before anything changes.
    const expired = { subStatus: "active", subExpiresAt: T - 1000 };
    expect(isEntitled(expired, T)).toBe(true);
    expect(isEntitled(expired, T - 1000 + RENEWAL_NOTICE_GRACE_MS - 1)).toBe(true);
    expect(isEntitled(expired, T - 1000 + RENEWAL_NOTICE_GRACE_MS)).toBe(false);
  });

  it("treats a renewal as the newer truth", () => {
    // What a DID_RENEW write does: the expiry moves forward and the record is
    // entitled again, even well past the old date.
    const renewed = { subStatus: "active", subExpiresAt: T + 30 * 86_400_000 };
    expect(isEntitled(renewed, T + 10 * 86_400_000)).toBe(true);
  });

  it("leaves a Stripe subscriber (no expiry sent) governed by status alone", () => {
    // Absent means "no opinion", never "expired" — Stripe's webhook does not
    // send a period end, and reading the missing field as lapsed would cut off
    // every Stripe subscriber at once.
    expect(isEntitled({ subStatus: "active" }, T)).toBe(true);
    expect(isEntitled({ subStatus: "active", subExpiresAt: null }, T)).toBe(true);
  });

  it("does not shorten dunning grace for past_due or trialing", () => {
    // Those are states a provider explicitly put us in, and the 2026-07-13
    // decision governs them: they end on an explicit EXPIRED, not on a clock.
    // Only the silence case (active, long past its date) is closed here.
    const longGone = T - 365 * 86_400_000;
    expect(isEntitled({ subStatus: "past_due", subExpiresAt: longGone }, T)).toBe(true);
    expect(isEntitled({ subStatus: "trialing", subExpiresAt: longGone }, T)).toBe(true);
    expect(isEntitled({ subStatus: "active", subExpiresAt: longGone }, T)).toBe(false);
  });

  it("still denies a canceled subscription whose expiry is in the future", () => {
    // A refund revokes immediately; paid-through time does not buy it back.
    expect(isEntitled({ subStatus: "canceled", subExpiresAt: T + 86_400_000 }, T)).toBe(false);
  });
});

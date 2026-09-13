// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { checkoutSessionIsFulfillable, planForPriceId, subStatusForEvent } from "../src/stripe.js";
import type { Env } from "../src/env.js";

const env = {
  STRIPE_PRICE_ANNUAL: "price_annual_123",
  STRIPE_PRICE_MONTHLY: "price_monthly_456",
} as unknown as Env;

describe("subStatusForEvent", () => {
  it("maps subscription.deleted to canceled regardless of status", () => {
    expect(subStatusForEvent("customer.subscription.deleted", "active")).toBe("canceled");
  });

  it("maps a failed invoice to past_due (degrade, don't cut off)", () => {
    expect(subStatusForEvent("invoice.payment_failed", null)).toBe("past_due");
  });

  it("treats active and trialing as active", () => {
    expect(subStatusForEvent("customer.subscription.updated", "active")).toBe("active");
    expect(subStatusForEvent("customer.subscription.updated", "trialing")).toBe("active");
  });

  it("treats past_due / unpaid / incomplete as past_due", () => {
    for (const s of ["past_due", "unpaid", "incomplete"]) {
      expect(subStatusForEvent("customer.subscription.updated", s)).toBe("past_due");
    }
  });

  it("treats canceled / incomplete_expired as canceled", () => {
    expect(subStatusForEvent("customer.subscription.updated", "canceled")).toBe("canceled");
    expect(subStatusForEvent("customer.subscription.updated", "incomplete_expired")).toBe("canceled");
  });

  it("defaults an unknown status to active on a live event", () => {
    expect(subStatusForEvent("customer.subscription.updated", "some_new_status")).toBe("active");
    expect(subStatusForEvent("checkout.session.completed", undefined)).toBe("active");
  });
});

describe("planForPriceId", () => {
  it("maps the configured price ids to plan labels", () => {
    expect(planForPriceId("price_annual_123", env)).toBe("annual");
    expect(planForPriceId("price_monthly_456", env)).toBe("monthly");
  });

  it("returns undefined for an unknown or missing price id", () => {
    expect(planForPriceId("price_unknown", env)).toBeUndefined();
    expect(planForPriceId(undefined, env)).toBeUndefined();
  });

  it("never matches when the env ids are unset (self-host with no Stripe)", () => {
    const bare = {} as unknown as Env;
    expect(planForPriceId("price_annual_123", bare)).toBeUndefined();
    expect(planForPriceId("", env)).toBeUndefined();
  });
});

describe("checkoutSessionIsFulfillable", () => {
  it("accepts completed paid and intentionally payment-free sessions", () => {
    expect(checkoutSessionIsFulfillable({ status: "complete", payment_status: "paid" })).toBe(true);
    expect(checkoutSessionIsFulfillable({ status: "complete", payment_status: "no_payment_required" })).toBe(true);
  });

  it("rejects complete-but-unpaid sessions while payment is still processing", () => {
    expect(checkoutSessionIsFulfillable({ status: "complete", payment_status: "unpaid" })).toBe(false);
  });

  it("rejects paid sessions until Checkout itself is complete", () => {
    expect(checkoutSessionIsFulfillable({ status: "open", payment_status: "paid" })).toBe(false);
    expect(checkoutSessionIsFulfillable({ status: "expired", payment_status: "paid" })).toBe(false);
  });
});

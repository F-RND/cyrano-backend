// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  allowedBundleIds,
  appleSubscriptionId,
  appleUserLabel,
  evaluateTransaction,
  notificationTransactionIsOurs,
  planForProductId,
  subStatusForAppleNotification,
} from "../src/appstore.js";
import type { Env } from "../src/env.js";

const BUNDLES = ["com.example.copilot", "com.example.copilot.desktop"];
const PROD = { allowedBundleIds: BUNDLES, expectedEnvironment: "Production" };
const NOW = 1_800_000_000_000;

describe("planForProductId", () => {
  it("maps both app records' recurring products to the same plans", () => {
    expect(planForProductId("com.example.copilot.pro.monthly")).toBe("monthly");
    expect(planForProductId("com.example.copilot.desktop.pro.monthly")).toBe("monthly");
    expect(planForProductId("com.example.copilot.pro.yearly")).toBe("annual");
    expect(planForProductId("com.example.copilot.desktop.pro.yearly")).toBe("annual");
  });

  it("refuses the lifetime non-consumable", () => {
    // Pro is the on-device tier. Minting a server token for it would hand out
    // an identity for a product that never talks to the Worker.
    expect(planForProductId("com.example.copilot.pro.lifetime")).toBeUndefined();
    expect(planForProductId("com.example.copilot.desktop.pro.lifetime")).toBeUndefined();
  });

  it("refuses unknown and empty products", () => {
    expect(planForProductId("com.someone.else.pro.monthly.extra")).toBeUndefined();
    expect(planForProductId(undefined)).toBeUndefined();
    expect(planForProductId("")).toBeUndefined();
  });
});

describe("subStatusForAppleNotification", () => {
  it("treats renewals and subscribes as active", () => {
    expect(subStatusForAppleNotification("SUBSCRIBED")).toBe("active");
    expect(subStatusForAppleNotification("DID_RENEW")).toBe("active");
    expect(subStatusForAppleNotification("RENEWAL_EXTENDED")).toBe("active");
  });

  it("keeps auto-renew-off subscriptions active until they actually end", () => {
    // The user turned off auto-renew but paid through the current period.
    // Downgrading here would take away time they already bought.
    expect(subStatusForAppleNotification("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED")).toBe("active");
  });

  it("treats a failed renewal as dunning, not an ending", () => {
    expect(subStatusForAppleNotification("DID_FAIL_TO_RENEW")).toBe("past_due");
    expect(subStatusForAppleNotification("DID_FAIL_TO_RENEW", "GRACE_PERIOD")).toBe("past_due");
  });

  it("ends the subscription on expiry, refund and revoke", () => {
    expect(subStatusForAppleNotification("EXPIRED")).toBe("canceled");
    expect(subStatusForAppleNotification("GRACE_PERIOD_EXPIRED")).toBe("canceled");
    expect(subStatusForAppleNotification("REFUND")).toBe("canceled");
    expect(subStatusForAppleNotification("REVOKE")).toBe("canceled");
  });

  it("leaves status alone for types that don't change it", () => {
    // undefined means "don't write", which is what the webhook checks.
    expect(subStatusForAppleNotification("DID_CHANGE_RENEWAL_PREF")).toBeUndefined();
    expect(subStatusForAppleNotification("CONSUMPTION_REQUEST")).toBeUndefined();
    expect(subStatusForAppleNotification("PRICE_INCREASE")).toBeUndefined();
    expect(subStatusForAppleNotification(undefined)).toBeUndefined();
  });
});

describe("allowedBundleIds", () => {
  it("fails closed when no bundle IDs are configured", () => {
    expect(allowedBundleIds({} as Env)).toEqual([]);
    expect(allowedBundleIds({ APPLE_BUNDLE_IDS: "" } as unknown as Env)).toEqual([]);
  });

  it("honours an explicit lock-down list", () => {
    const env = { APPLE_BUNDLE_IDS: " com.example.copilot.desktop , x.y " } as unknown as Env;
    expect(allowedBundleIds(env)).toEqual(["com.example.copilot.desktop", "x.y"]);
  });
});

describe("notificationTransactionIsOurs", () => {
  const base = {
    bundleId: "com.example.copilot",
    productId: "com.example.copilot.pro.monthly",
    originalTransactionId: "2000000012345",
    environment: "Production",
  };

  it("accepts a notification about one of our hosted subscriptions", () => {
    expect(notificationTransactionIsOurs(base, PROD)).toEqual({ ok: true });
  });

  it("rejects a production notification when no environment is configured", () => {
    expect(notificationTransactionIsOurs(base, { allowedBundleIds: BUNDLES }))
      .toMatchObject({ ok: false, reason: "environment_mismatch" });
  });

  it("ignores another app's transaction", () => {
    // Apple signs every developer's notifications with the same chain, so a
    // valid signature proves "Apple sent this", not "this is about us".
    expect(notificationTransactionIsOurs({ ...base, bundleId: "com.evil.app" }, PROD))
      .toMatchObject({ ok: false, reason: "bundle_mismatch" });
  });

  it("ignores a sandbox notification unless the deployment names Sandbox", () => {
    const sandbox = { ...base, environment: "Sandbox" };
    expect(notificationTransactionIsOurs(sandbox, PROD))
      .toMatchObject({ ok: false, reason: "environment_mismatch" });
    expect(
      notificationTransactionIsOurs(sandbox, {
        allowedBundleIds: BUNDLES,
        expectedEnvironment: "Production,Sandbox",
      }),
    ).toEqual({ ok: true });
  });

  it("ignores a notification with no environment at all", () => {
    const { environment: _drop, ...rest } = base;
    expect(notificationTransactionIsOurs(rest, PROD))
      .toMatchObject({ ok: false, reason: "environment_mismatch" });
  });

  it("ignores the lifetime unlock — it has no server-side subscription to update", () => {
    expect(
      notificationTransactionIsOurs(
        { ...base, productId: "com.example.copilot.pro.lifetime" },
        PROD,
      ),
    ).toMatchObject({ ok: false, reason: "not_a_hosted_product" });
  });

  it("accepts refunded and expired transactions — those are the ones that must land", () => {
    // The trap this helper exists to avoid: reusing evaluateTransaction here
    // would reject exactly the REFUND / REVOKE / EXPIRED notifications the
    // registry most needs to hear about, leaving a refunded account entitled.
    expect(notificationTransactionIsOurs({ ...base, revocationDate: NOW - 5 }, PROD))
      .toEqual({ ok: true });
    expect(notificationTransactionIsOurs({ ...base, expiresDate: NOW - 5 }, PROD))
      .toEqual({ ok: true });
  });
});

describe("appleSubscriptionId / appleUserLabel", () => {
  it("namespaces so Apple and Stripe ids can never collide in one index", () => {
    expect(appleSubscriptionId("2000000012345", "Production")).toBe("apple:2000000012345");
    expect(appleUserLabel("2000000012345", "Production")).toBe("apple_2000000012345");
  });

  it("gives sandbox its own namespace so a tester can never rotate a payer's token", () => {
    // Both must split, and split the same way: the id keys the subscription
    // index, the label keys the identity. If only one namespaced, a sandbox
    // link would write a sandbox subscription onto the production user.
    expect(appleSubscriptionId("2000000012345", "Sandbox")).toBe("apple:sandbox:2000000012345");
    expect(appleUserLabel("2000000012345", "Sandbox")).toBe("apple_sandbox_2000000012345");
    expect(appleSubscriptionId("2000000012345", "Sandbox"))
      .not.toBe(appleSubscriptionId("2000000012345", "Production"));
    expect(appleUserLabel("2000000012345", "Sandbox"))
      .not.toBe(appleUserLabel("2000000012345", "Production"));
  });

  it("treats anything that is not exactly Sandbox as production", () => {
    // Fail-safe direction: an unrecognised environment must not invent a third
    // namespace that nothing else in the system knows how to read.
    expect(appleSubscriptionId("2000000012345", "")).toBe("apple:2000000012345");
    expect(appleSubscriptionId("2000000012345", "sandbox")).toBe("apple:2000000012345");
  });
});

describe("evaluateTransaction", () => {
  const base = {
    bundleId: "com.example.copilot",
    productId: "com.example.copilot.pro.monthly",
    originalTransactionId: "2000000012345",
    purchaseDate: NOW - 1000,
    expiresDate: NOW + 30 * 86_400_000,
    environment: "Production",
  };

  it("accepts a live subscription", () => {
    const out = evaluateTransaction(base, { now: NOW, ...PROD });
    expect(out).toMatchObject({ ok: true, plan: "monthly", subStatus: "active", originalTransactionId: "2000000012345" });
  });

  it("rejects a transaction from another app", () => {
    const out = evaluateTransaction({ ...base, bundleId: "com.evil.app" }, { now: NOW, ...PROD });
    expect(out).toMatchObject({ ok: false, status: 403, error: "bundle_mismatch" });
  });

  it("rejects a sandbox receipt when the deployment declares Production", () => {
    const out = evaluateTransaction(
      { ...base, environment: "Sandbox" },
      { now: NOW, allowedBundleIds: BUNDLES, expectedEnvironment: "Production" },
    );
    expect(out).toMatchObject({ ok: false, status: 403, error: "environment_mismatch" });
  });

  it("rejects a sandbox receipt when the deployment declares nothing — fail closed", () => {
    const out = evaluateTransaction(
      { ...base, environment: "Sandbox" },
      { now: NOW, allowedBundleIds: BUNDLES },
    );
    expect(out).toMatchObject({ ok: false, status: 403, error: "environment_mismatch" });
  });

  it("accepts a sandbox receipt only where the deployment names Sandbox", () => {
    const out = evaluateTransaction(
      { ...base, environment: "Sandbox" },
      { now: NOW, allowedBundleIds: BUNDLES, expectedEnvironment: "Production,Sandbox" },
    );
    expect(out).toMatchObject({ ok: true });
  });

  it("reports the accepted environment so the identity can be namespaced", () => {
    // Accepting Sandbox is only safe because this value reaches the registry:
    // without it the tester and the payer would share one rotating identity.
    expect(evaluateTransaction(base, { now: NOW, ...PROD }))
      .toMatchObject({ ok: true, environment: "Production" });
    expect(
      evaluateTransaction(
        { ...base, environment: "Sandbox" },
        { now: NOW, allowedBundleIds: BUNDLES, expectedEnvironment: "Production,Sandbox" },
      ),
    ).toMatchObject({ ok: true, environment: "Sandbox" });
  });

  it("rejects a transaction with no environment at all", () => {
    const { environment: _drop, ...rest } = base;
    const out = evaluateTransaction(rest, { now: NOW, ...PROD });
    expect(out).toMatchObject({ ok: false, status: 403, error: "environment_mismatch" });
  });

  it("rejects the lifetime unlock — it needs no server identity", () => {
    const out = evaluateTransaction(
      { ...base, productId: "com.example.copilot.pro.lifetime" },
      { now: NOW, ...PROD },
    );
    expect(out).toMatchObject({ ok: false, status: 400, error: "not_a_hosted_product" });
  });

  it("rejects an expired subscription", () => {
    const out = evaluateTransaction({ ...base, expiresDate: NOW - 1 }, { now: NOW, ...PROD });
    expect(out).toMatchObject({ ok: false, status: 403, error: "subscription_expired" });
  });

  it("rejects a revoked (refunded) transaction", () => {
    const out = evaluateTransaction({ ...base, revocationDate: NOW - 5 }, { now: NOW, ...PROD });
    expect(out).toMatchObject({ ok: false, status: 403, error: "transaction_revoked" });
  });

  it("falls back to transactionId when there is no originalTransactionId", () => {
    const { originalTransactionId: _drop, ...rest } = base;
    const out = evaluateTransaction({ ...rest, transactionId: "999" }, { now: NOW, ...PROD });
    expect(out).toMatchObject({ ok: true, originalTransactionId: "999" });
  });

  it("rejects a transaction with no id at all", () => {
    const { originalTransactionId: _drop, ...rest } = base;
    const out = evaluateTransaction(rest, { now: NOW, ...PROD });
    expect(out).toMatchObject({ ok: false, status: 400, error: "missing_transaction_id" });
  });
});

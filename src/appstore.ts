// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// App Store (StoreKit) subscriptions for the paid hosted tier — the Apple-side
// twin of stripe.ts.
//
// Why this exists: Pro is a one-time on-device unlock and StoreKit settles it
// entirely on the client. Pro+ is not. Its copilot runs here, and this Worker
// will not answer without a bearer token it minted itself — a StoreKit receipt
// means nothing to it. So an App Store subscription has to be exchanged for a
// tenant token exactly the way a Stripe checkout is, or the purchase buys
// nothing and App Review rejects it under 2.1.
//
// The trust model is the whole point. The client sends a signed transaction; we
// verify Apple's signature and certificate chain (appstore-jws.ts) and take
// EVERY entitlement fact — product, expiry, bundle id — from that verified
// payload. Nothing the client asserts is believed. A client that could name its
// own plan could name itself Pro+ for free.
//
// The identity is keyed on Apple's originalTransactionId, stamped into the
// existing subscription index with an `apple:` namespace so notifications can
// find it through the same `_subscription` endpoint Stripe's webhook uses. One
// subscription record shape, two payment providers.
//
// Nothing here is exercised against a live App Store account yet — the pure
// helpers below are unit-tested, and the network paths need a sandbox purchase.

import type { Env } from "./env.js";
import { verifyAppleJWS, unsafeDecodeJWSPayload, AppleJWSError } from "./appstore-jws.js";
import type { SubStatus } from "./stripe.js";

/** The plan ids we stamp on a subscriber record. Same vocabulary as Stripe's,
 *  deliberately: entitlement.ts and SessionDO must not care who took payment. */
export type ApplePlanId = "monthly" | "annual";

export function allowedBundleIds(env: Env): string[] {
  const configured = env.APPLE_BUNDLE_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
  return configured ?? [];
}

/** Product id → plan. Only the recurring products map: the lifetime
 *  non-consumable is the on-device tier and must never mint a server token,
 *  which is exactly what returning undefined here prevents. Suffix-matched so
 *  separate app records can share one rule without embedding private product
 *  identifiers in this repository. */
export function planForProductId(productId: string | undefined): ApplePlanId | undefined {
  if (!productId) return undefined;
  if (productId.endsWith(".pro.monthly")) return "monthly";
  if (productId.endsWith(".pro.yearly") || productId.endsWith(".pro.annual")) return "annual";
  return undefined;
}

/**
 * Apple's notification vocabulary collapsed to our three states.
 *
 * The mapping is deliberately conservative in the user's favour, matching
 * Stripe's: a failed renewal is `past_due` (which entitlement.ts still treats
 * as entitled — dunning grace, not a lockout), and only a real ending is
 * `canceled`. DID_CHANGE_RENEWAL_STATUS is NOT a cancellation: auto-renew off
 * means the subscription still runs to the end of its paid period, and
 * downgrading it early would take away time the user paid for.
 *
 * Pure + tested; the webhook does nothing but call this and write the result.
 */
export function subStatusForAppleNotification(
  notificationType: string | undefined,
  subtype?: string | null,
): SubStatus | undefined {
  switch (notificationType) {
    case "SUBSCRIBED":
    case "DID_RENEW":
    case "RENEWAL_EXTENDED":
    case "OFFER_REDEEMED":
      return "active";
    case "DID_CHANGE_RENEWAL_STATUS":
      // Auto-renew was toggled. Still paid through the current period.
      return "active";
    case "DID_FAIL_TO_RENEW":
      // With or without a grace period this is dunning, not an ending. The
      // EXPIRED / GRACE_PERIOD_EXPIRED notification is what ends it.
      return "past_due";
    case "EXPIRED":
    case "GRACE_PERIOD_EXPIRED":
    case "REFUND":
    case "REVOKE":
      return "canceled";
    case "DID_CHANGE_RENEWAL_PREF":
      // Plan change (upgrade/downgrade/crossgrade). Status is unaffected;
      // returning undefined leaves the stored value alone.
      return undefined;
    default:
      // Unknown/irrelevant types (CONSUMPTION_REQUEST, PRICE_INCREASE, …) must
      // not touch status. Silence beats a guess that could revoke access.
      return subtype === undefined ? undefined : undefined;
  }
}

/** The subset of Apple's JWSTransactionDecodedPayload we rely on. */
export interface AppleTransactionPayload {
  transactionId?: string;
  originalTransactionId?: string;
  bundleId?: string;
  productId?: string;
  purchaseDate?: number;
  originalPurchaseDate?: number;
  expiresDate?: number;
  environment?: string;
  revocationDate?: number;
}

/** Apple's responseBodyV2DecodedPayload. */
export interface AppleNotificationPayload {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  data?: {
    bundleId?: string;
    environment?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

/** The namespaced subscription id. Shares the registry's existing
 *  `user-subscription:` index with Stripe — the index value is just a label,
 *  and namespacing keeps the two providers from ever colliding. */
export function appleSubscriptionId(originalTransactionId: string): string {
  return `apple:${originalTransactionId}`;
}

interface LinkOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Validate a verified transaction and decide what to write. Pure, so the
 * accept/reject matrix is testable without crypto or a DO.
 */
export function evaluateTransaction(
  payload: AppleTransactionPayload,
  opts: { now: number; allowedBundleIds: string[]; expectedEnvironment?: string },
): { ok: true; plan: ApplePlanId; subStatus: SubStatus; originalTransactionId: string; expiresAt?: number }
  | { ok: false; status: number; error: string } {
  const { now, allowedBundleIds: bundles, expectedEnvironment } = opts;

  if (!payload.bundleId || !bundles.includes(payload.bundleId)) {
    return { ok: false, status: 403, error: "bundle_mismatch" };
  }
  // FAIL CLOSED: an unset APPLE_ENVIRONMENT accepts no receipt. A deployment
  // must explicitly name every environment it intends to accept.
  //
  // A payload with NO environment is rejected too. Apple has stamped it on
  // every JWSTransaction for years, and "the field we authenticate on is
  // missing" is not a case to wave through.
  const allowedEnvironments = (expectedEnvironment ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!payload.environment || !allowedEnvironments.includes(payload.environment)) {
    return { ok: false, status: 403, error: "environment_mismatch" };
  }
  const originalTransactionId = payload.originalTransactionId ?? payload.transactionId;
  if (!originalTransactionId) {
    return { ok: false, status: 400, error: "missing_transaction_id" };
  }
  const plan = planForProductId(payload.productId);
  if (!plan) {
    // Includes the lifetime non-consumable: it is the on-device tier and needs
    // no server identity, so linking it would hand out a token for nothing.
    return { ok: false, status: 400, error: "not_a_hosted_product" };
  }
  if (payload.revocationDate != null) {
    return { ok: false, status: 403, error: "transaction_revoked" };
  }
  if (payload.expiresDate != null && payload.expiresDate <= now) {
    return { ok: false, status: 403, error: "subscription_expired" };
  }
  return { ok: true, plan, subStatus: "active", originalTransactionId, expiresAt: payload.expiresDate };
}

/**
 * Whether a notification's nested transaction belongs to this app at all.
 *
 * Deliberately NOT `evaluateTransaction`. That one rejects revoked and expired
 * transactions, which is right when linking and exactly wrong here: REFUND,
 * REVOKE and EXPIRED notifications carry precisely those, and they are the ones
 * that most need to land. So this checks provenance only — our app record, our
 * environment, one of our hosted products — and says nothing about whether the
 * subscription is live.
 *
 * The registry lookup is still the real gate: `apple:<originalTransactionId>`
 * matches nothing for a transaction we never linked, so a stranger's genuine
 * Apple-signed notification replayed at this public endpoint is already a
 * no-op. This is defence in depth on top of that, and it makes the invariant a
 * stated rule rather than an emergent property of id uniqueness.
 */
export function notificationTransactionIsOurs(
  txn: AppleTransactionPayload,
  opts: { allowedBundleIds: string[]; expectedEnvironment?: string },
): { ok: true } | { ok: false; reason: string } {
  if (!txn.bundleId || !opts.allowedBundleIds.includes(txn.bundleId)) {
    return { ok: false, reason: "bundle_mismatch" };
  }
  // Same fail-closed default as the link path: an unset APPLE_ENVIRONMENT
  // accepts nothing, and a payload with no environment is not waved through.
  const allowed = (opts.expectedEnvironment ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!txn.environment || !allowed.includes(txn.environment)) {
    return { ok: false, reason: "environment_mismatch" };
  }
  if (!planForProductId(txn.productId)) {
    return { ok: false, reason: "not_a_hosted_product" };
  }
  return { ok: true };
}

/**
 * POST /appstore/link — exchange a signed StoreKit transaction for a tenant
 * token. Token-less by necessity: the caller has just paid and has no
 * credential yet. The signed transaction IS the credential, which is why the
 * signature check is not optional and not skippable.
 */
export async function handleAppStoreLink(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { signedTransaction?: string } | null;
  const jws = body?.signedTransaction?.trim();
  if (!jws) return Response.json({ error: "bad_request" }, { status: 400 });

  let payload: AppleTransactionPayload;
  try {
    payload = await verifyAppleJWS<AppleTransactionPayload>(jws);
  } catch (err) {
    const reason = err instanceof AppleJWSError ? err.message : "verification_failed";
    console.error("appstore link verification failed:", reason);
    return Response.json({ error: "invalid_transaction" }, { status: 403 });
  }

  const verdict = evaluateTransaction(payload, {
    now: Date.now(),
    allowedBundleIds: allowedBundleIds(env),
    expectedEnvironment: env.APPLE_ENVIRONMENT,
  });
  if (!verdict.ok) return Response.json({ error: verdict.error }, { status: verdict.status });

  const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
  const res = await registry.fetch("https://registry/_appstore_link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      original_transaction_id: verdict.originalTransactionId,
      plan: verdict.plan,
      sub_status: verdict.subStatus,
      period_start: payload.purchaseDate,
      // The verified paid-through date. Without it the server-side entitlement
      // would rest entirely on a future notification arriving, and a single
      // month's purchase would read as active forever if none ever did.
      period_end: verdict.expiresAt,
    }),
  });
  if (!res.ok) {
    console.error("appstore link registry write failed:", res.status);
    return Response.json({ error: "link_failed" }, { status: 502 });
  }
  const minted = (await res.json()) as { token?: string; user_id?: string };
  if (!minted.token) return Response.json({ error: "link_failed" }, { status: 502 });

  return Response.json({
    token: minted.token,
    user_id: minted.user_id,
    plan: verdict.plan,
    expires_at: verdict.expiresAt ?? null,
  });
}

/**
 * POST /appstore/notifications — Apple's App Store Server Notifications V2.
 *
 * Same discipline as the Stripe webhook: the signature is the authentication,
 * unknown types are acked, and a write failure returns 500 so Apple retries.
 * Status changes route through the SAME registry `_subscription` endpoint
 * Stripe uses, keyed on the namespaced subscription id.
 */
export async function handleAppStoreNotifications(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { signedPayload?: string } | null;
  const signed = body?.signedPayload?.trim();
  if (!signed) return new Response("bad request", { status: 400 });

  let payload: AppleNotificationPayload;
  try {
    payload = await verifyAppleJWS<AppleNotificationPayload>(signed);
  } catch (err) {
    const reason = err instanceof AppleJWSError ? err.message : "verification_failed";
    console.error("appstore notification verification failed:", reason);
    // 400, not 500: a payload we cannot verify is not ours, and asking Apple to
    // retry it forever would be pointless.
    return new Response("invalid signature", { status: 400 });
  }

  try {
    const subStatus = subStatusForAppleNotification(payload.notificationType, payload.subtype);
    if (!subStatus) return new Response("ok"); // nothing to change; ack it

    // The transaction rides inside the notification as its own signed JWS.
    // Verify that too rather than trusting the envelope's summary fields.
    const signedTransaction = payload.data?.signedTransactionInfo;
    if (!signedTransaction) return new Response("ok");
    const txn = await verifyAppleJWS<AppleTransactionPayload>(signedTransaction);
    const originalTransactionId = txn.originalTransactionId ?? txn.transactionId;
    if (!originalTransactionId) return new Response("ok");

    // Apple signs every developer's notifications with the same chain, so a
    // valid signature proves "Apple sent this", not "this is about us". Ack and
    // drop anything that is not: a 500 would only buy pointless redeliveries of
    // a notification that will never be ours.
    const ours = notificationTransactionIsOurs(txn, {
      allowedBundleIds: allowedBundleIds(env),
      expectedEnvironment: env.APPLE_ENVIRONMENT,
    });
    if (!ours.ok) {
      console.warn("appstore notification ignored:", ours.reason);
      return new Response("ok");
    }

    const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
    const write = await registry.fetch("https://registry/_subscription", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stripe_subscription_id: appleSubscriptionId(originalTransactionId),
        sub_status: subStatus,
        plan: planForProductId(txn.productId),
        period_start: txn.purchaseDate,
        // A renewal's whole payload is its new paid-through date. Dropping it
        // would leave the record stuck behind the old expiry and, once the
        // grace window passed, degrade a subscriber who did renew.
        period_end: txn.expiresDate,
      }),
    });
    // Acking a failed write tells Apple the status change landed, and Apple
    // does not send it again: the account would keep Pro+ after a refund, or
    // stay locked out after a renewal. Throw into the catch below so the 500
    // asks for a redelivery. The registry write is idempotent.
    if (!write.ok) throw new Error(`registry subscription write failed: ${write.status}`);
    return new Response("ok");
  } catch (err) {
    // Mirror the Stripe webhook exactly: log the message, never the payload,
    // and 500 so the provider redelivers. The registry write is idempotent.
    console.error("appstore notification handling failed:", err instanceof Error ? err.message : "unknown");
    return new Response("error", { status: 500 });
  }
}

/** Re-exported so index.ts can decode a notification's type for logging
 *  without a second verify. Never use for trust decisions. */
export { unsafeDecodeJWSPayload };

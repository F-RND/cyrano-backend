// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Stripe subscription funnel for the paid hosted tier. Three public routes, all wired in index.ts
// BEFORE the bearer-token auth gate — none of them use a Cyrano credential:
//
//   • GET  /buy?plan=annual|monthly  — creates a Checkout Session, 303s to it.
//   • POST /stripe/webhook           — Stripe-signed; provisions/updates the
//                                      subscriber's tenant token + state.
//   • GET  /stripe/activated?session_id=…  — post-checkout page; hands the
//                                      freshly minted tenant token to the app
//                                      via a cyrano://activate deep link.
//
// The Stripe SDK runs on Workers with the fetch HTTP client + a SubtleCrypto
// signature provider (Workers has no Node crypto). Nothing here is exercised
// against a live Stripe account yet — the pure helpers below are unit-tested;
// the network paths need Stripe test mode (see the handoff checklist).

import Stripe from "stripe";
import type { Env } from "./env.js";

type PlanId = "annual" | "monthly";
export type SubStatus = "active" | "past_due" | "canceled";

/** Our three subscription states, derived from a Stripe event + the
 * subscription's own status. `deleted` is always canceled; a failed invoice is
 * past_due (degrade, keep the token through the grace window); everything else
 * trusts the subscription status, collapsed to our vocabulary. Pure + tested. */
export function subStatusForEvent(eventType: string, stripeStatus?: string | null): SubStatus {
  if (eventType === "customer.subscription.deleted") return "canceled";
  if (eventType === "invoice.payment_failed") return "past_due";
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "active";
  }
}

/** Maps a Stripe Price id back to our plan label using the configured ids.
 * Pure + tested. Unknown price → undefined (recorded as a subscriber with no
 * plan label rather than guessed). */
export function planForPriceId(priceId: string | undefined, env: Env): PlanId | undefined {
  if (priceId && env.STRIPE_PRICE_ANNUAL && priceId === env.STRIPE_PRICE_ANNUAL) return "annual";
  if (priceId && env.STRIPE_PRICE_MONTHLY && priceId === env.STRIPE_PRICE_MONTHLY) return "monthly";
  return undefined;
}

/** Checkout can be `complete` while an asynchronous payment is still
 * processing. Fulfill only once checkout has finished and funds are either
 * available or intentionally not required (for example a billing anchor). */
export function checkoutSessionIsFulfillable(
  session: Pick<Stripe.Checkout.Session, "status" | "payment_status">,
): boolean {
  return session.status === "complete"
    && (session.payment_status === "paid" || session.payment_status === "no_payment_required");
}

function stripeClient(env: Env): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}

function registryStub(env: Env): DurableObjectStub {
  return env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
}

/** Stripe moved `current_period_start` off the top-level Subscription onto the
 * subscription item in recent API versions; read either shape. Seconds → ms. */
function periodStartMs(sub: Stripe.Subscription): number | undefined {
  const s = sub as unknown as {
    current_period_start?: number;
    items?: { data?: Array<{ current_period_start?: number }> };
  };
  const secs = s.current_period_start ?? s.items?.data?.[0]?.current_period_start;
  return typeof secs === "number" ? secs * 1000 : undefined;
}

function planAndPeriod(sub: Stripe.Subscription, env: Env): { plan?: PlanId; periodStart?: number } {
  return { plan: planForPriceId(sub.items.data[0]?.price?.id, env), periodStart: periodStartMs(sub) };
}

// ---------------------------------------------------------------------------
// GET /buy?plan=annual|monthly
// ---------------------------------------------------------------------------

export async function handleBuy(request: Request, env: Env): Promise<Response> {
  const stripe = stripeClient(env);
  if (!stripe) return new Response("billing not configured", { status: 503 });

  const url = new URL(request.url);
  const plan = url.searchParams.get("plan") === "monthly" ? "monthly" : "annual";
  const price = plan === "annual" ? env.STRIPE_PRICE_ANNUAL : env.STRIPE_PRICE_MONTHLY;
  if (!price) return new Response("price not configured", { status: 503 });

  // Return to the marketing site on cancel; land on THIS backend's own
  // activation page on success (it owns the Stripe secret + the token stash).
  const marketing = env.LANDING_BASE_URL || url.origin;
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      automatic_tax: { enabled: true },
      success_url: `${url.origin}/stripe/activated?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${marketing}/?canceled=1`,
    });
    if (!session.url) return new Response("checkout unavailable", { status: 502 });
    return Response.redirect(session.url, 303);
  } catch (err) {
    console.error("stripe checkout create failed", err instanceof Error ? err.message : err);
    return new Response("checkout unavailable", { status: 502 });
  }
}

// ---------------------------------------------------------------------------
// POST /stripe/webhook  (Stripe-signed; no bearer token)
// ---------------------------------------------------------------------------

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const stripe = stripeClient(env);
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response("billing not configured", { status: 503 });
  }

  const sig = request.headers.get("stripe-signature") ?? "";
  const body = await request.text(); // raw body is required for signature verification
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return new Response("bad signature", { status: 400 });
  }

  const registry = registryStub(env);

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (!checkoutSessionIsFulfillable(s)) break;
        if (!s.subscription) break; // one-off payment, not a subscription — ignore
        const sub = await stripe.subscriptions.retrieve(s.subscription as string);
        const { plan, periodStart } = planAndPeriod(sub, env);
        await registry.fetch("https://registry/_provision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stripe_subscription_id: sub.id,
            stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
            plan,
            sub_status: subStatusForEvent(event.type, sub.status),
            period_start: periodStart,
            cs_id: s.id,
          }),
        });
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const { plan, periodStart } = planAndPeriod(sub, env);
        await registry.fetch("https://registry/_subscription", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stripe_subscription_id: sub.id,
            plan,
            sub_status: subStatusForEvent(event.type, sub.status),
            // Only realign the meter period on a live update, never on delete.
            period_start: event.type === "customer.subscription.updated" ? periodStart : undefined,
          }),
        });
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = (inv as unknown as { subscription?: string | { id: string } }).subscription;
        const id = typeof subId === "string" ? subId : subId?.id;
        if (!id) break;
        await registry.fetch("https://registry/_subscription", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            stripe_subscription_id: id,
            sub_status: subStatusForEvent(event.type, null),
          }),
        });
        break;
      }
      default:
        break; // unsubscribed event type — ack and ignore
    }
  } catch (err) {
    // A 5xx makes Stripe retry the event later, which is what we want if a DO
    // write hiccuped — better a redelivery (idempotent by subscription id)
    // than a silently dropped subscription.
    console.error("stripe webhook handling failed", event.type, err instanceof Error ? err.message : err);
    return new Response("handler error", { status: 500 });
  }

  return new Response("ok", { status: 200 }); // 2xx acks; non-2xx => Stripe retries
}

// ---------------------------------------------------------------------------
// GET /stripe/activated?session_id=…  (post-checkout success page)
// ---------------------------------------------------------------------------

export async function handleActivated(request: Request, env: Env): Promise<Response> {
  const stripe = stripeClient(env);
  if (!stripe) return htmlPage(activatedError("Billing isn’t configured on this backend."), 503);

  const url = new URL(request.url);
  const csId = url.searchParams.get("session_id");
  if (!csId) return htmlPage(activatedError("Missing checkout session."), 400);

  // Authenticate the claim by verifying the checkout session with Stripe: an
  // attacker can't invent a paid session id, and the ids are unguessable.
  let cs: Stripe.Checkout.Session;
  try {
    cs = await stripe.checkout.sessions.retrieve(csId);
  } catch {
    return htmlPage(activatedError("We couldn’t find that checkout session."), 404);
  }
  if (!checkoutSessionIsFulfillable(cs)) {
    return htmlPage(activatedError("This checkout isn’t complete yet. If you just paid, refresh in a moment."), 402);
  }

  const registry = registryStub(env);
  const backendOrigin = url.origin;

  // 1) The webhook usually lands first and stashes the token — claim it once.
  try {
    const res = await registry.fetch(`https://registry/_claim?cs_id=${encodeURIComponent(csId)}`);
    const body = (await res.json()) as { found?: boolean; consumed?: boolean; token?: string };
    if (body.token) return htmlPage(activatedSuccess(body.token, backendOrigin));
    if (body.found && body.consumed) return htmlPage(activatedAlready());
  } catch {
    // fall through to self-provision
  }

  // 2) Webhook hasn't landed — provision here so the buyer is never stranded.
  try {
    if (!cs.subscription) return htmlPage(activatedError("This purchase isn’t a subscription."), 400);
    const sub = await stripe.subscriptions.retrieve(cs.subscription as string);
    const { plan, periodStart } = planAndPeriod(sub, env);
    const res = await registry.fetch("https://registry/_provision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stripe_subscription_id: sub.id,
        stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer?.id,
        plan,
        sub_status: subStatusForEvent("customer.subscription.updated", sub.status),
        period_start: periodStart,
        cs_id: csId,
      }),
    });
    const body = (await res.json()) as { token?: string; reused?: boolean };
    if (body.token) return htmlPage(activatedSuccess(body.token, backendOrigin));
    // Reused with no token: the subscriber already exists and their token was
    // delivered on an earlier visit. Nothing to re-hand out.
    return htmlPage(activatedAlready());
  } catch (err) {
    console.error("stripe activation provisioning failed", err instanceof Error ? err.message : err);
    return htmlPage(activatedError("Something went wrong finishing activation. Your subscription is active — contact support to retrieve your key."), 500);
  }
}

// ---- activation page rendering (self-contained, no external assets) ----

function htmlPage(inner: string, status = 200): Response {
  const doc = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Cyrano — activation</title>
<style>
:root { color-scheme: light dark; }
body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0;
  display: grid; place-items: center; min-height: 100vh; background: #0e0e10; color: #ececf1; }
main { max-width: 32rem; padding: 2.5rem; text-align: center; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
p { color: #b6b6c2; }
.key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem;
  background: #1a1a1f; border: 1px solid #2a2a33; border-radius: .5rem; padding: .75rem 1rem;
  word-break: break-all; user-select: all; margin: 1rem 0; }
.btn { display: inline-block; background: #6d6df0; color: #fff; text-decoration: none;
  padding: .7rem 1.4rem; border-radius: .6rem; font-weight: 600; margin-top: .5rem; }
.muted { font-size: .85rem; color: #85859a; }
</style></head><body><main>${inner}</main></body></html>`;
  return new Response(doc, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function activatedSuccess(token: string, backendOrigin: string): string {
  const deepLink = `cyrano://activate?token=${encodeURIComponent(token)}&url=${encodeURIComponent(backendOrigin)}`;
  // Auto-open the app; also show the key so a user without the deep-link
  // handler (or on another machine) can paste it into Settings → Bearer token.
  const safeLink = deepLink.replace(/"/g, "&quot;");
  return `<h1>You’re in. 🎉</h1>
<p>Opening Cyrano to connect your subscription…</p>
<p><a class="btn" href="${safeLink}">Open Cyrano</a></p>
<p class="muted">Didn’t open? Paste this key into Cyrano → Settings → Bearer token, and set the backend URL to <code>${backendOrigin}</code>:</p>
<div class="key">${escapeHtml(token)}</div>
<p class="muted">Keep this key private — it’s your subscription credential.</p>
<script>setTimeout(function(){ window.location.href = "${safeLink}"; }, 600);</script>`;
}

function activatedAlready(): string {
  return `<h1>Already activated</h1>
<p>This subscription has already been connected. Open Cyrano — you’re all set.</p>
<p class="muted">If Cyrano isn’t connected on this Mac, re-open the link from your original activation email, or contact support.</p>`;
}

function activatedError(message: string): string {
  return `<h1>Activation</h1><p>${escapeHtml(message)}</p>`;
}

function escapeHtml(s: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (character) => replacements[character] ?? character);
}

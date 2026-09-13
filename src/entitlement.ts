// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Subscription / promo entitlement for the paid hosted tier (2026-07-13,
// paid-hosted contract). Pure so it's unit-testable; RegistryDO applies it
// and SessionDO gates the hosted smart layer on it.
//
// Product decision (2026-07-13): a lapsed subscription DEGRADES to on-device —
// the tenant token stays valid so the free on-device app keeps working, and
// only the hosted cloud copilot stops (with a "renew or bring your own key"
// banner). So entitlement gates hosted *analysis*, never authentication.

/** Stripe subscription statuses that grant hosted access. `past_due` is
 * included as grace during Stripe's dunning retries; a truly canceled / unpaid
 * / expired-before-first-payment subscription is not entitled. */
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * How long past its verified paid-through date an `active` subscription keeps
 * hosted access while we wait to be told it renewed.
 *
 * Sized to Apple's notification retry ladder (five attempts spread over roughly
 * three days), so one failed delivery never locks out someone who paid. Beyond
 * that, "active" with a long-past expiry is not a subscriber, it is silence —
 * and silence used to mean free forever.
 */
export const RENEWAL_NOTICE_GRACE_MS = 72 * 60 * 60 * 1000;

/** The entitlement-relevant slice of a StoredUser. */
export interface EntitlementInputs {
  subStatus?: string | null;
  /** Promo/test key expiry (ms). Set on promo keys; a null/absent value means
   * "not a promo key" (fall through to subStatus). See promo.ts. */
  promoExpiresAt?: number | null;
  /** Verified paid-through date (ms), when the payment provider gave us one.
   * Apple does, inside every signed transaction; Stripe's webhook does not send
   * one, so for Stripe subscribers this is absent and status remains the only
   * signal. Absent means "no opinion", never "expired". */
  subExpiresAt?: number | null;
}

/**
 * Whether a tenant is entitled to hosted analysis right now.
 *
 * Precedence:
 *  1. Promo key (`promoExpiresAt` set) → entitled while `now < promoExpiresAt`.
 *  2. Stripe subscriber (`subStatus` set) → entitled while the status is active
 *     / trialing / past_due (dunning grace).
 *  3. Neither → entitled. Operator-minted tenants and self-hosters are never
 *     subscription-gated; they keep working exactly as before this feature.
 *
 * Step 2 carries one backstop, added 2026-08-03. Status is only ever as fresh
 * as the last webhook that landed, so an `active` record whose verified
 * paid-through date passed long ago means we were never told what happened —
 * App Store Server Notifications not configured, misrouted, or silently
 * failing — and a one-month purchase would otherwise stay entitled forever.
 * `active` past its expiry plus `RENEWAL_NOTICE_GRACE_MS` is treated as lapsed.
 *
 * The backstop deliberately does NOT touch `past_due` or `trialing`: those are
 * states a provider explicitly PUT us in, and the 2026-07-13 decision (dunning
 * is grace, not a lockout) governs them. They end when an EXPIRED / canceled
 * notification says so. Only the silence case is closed here.
 */
export function isEntitled(user: EntitlementInputs, now: number): boolean {
  if (user.promoExpiresAt != null) return now < user.promoExpiresAt;
  if (user.subStatus) {
    if (!ENTITLED_STATUSES.has(user.subStatus)) return false;
    if (user.subStatus === "active" && user.subExpiresAt != null) {
      return now < user.subExpiresAt + RENEWAL_NOTICE_GRACE_MS;
    }
    return true;
  }
  return true;
}

// ---- Pro live relay ----

/** The `plan` stamped on a tenant identity minted from a Pro license via
 * `/license/relay-token`. Such an identity exists ONLY so a Pro user's live
 * session can transit the Worker for the agent loop — analysis stays on the
 * device, so it must never receive hosted analysis on the operator's key. */
export const RELAY_PLAN = "pro-relay";

/** The `plan` stamped on a tenant identity that subscribes to MCP+ — hosted
 * MCP transport as an add-on to Pro (documentation/PLAN-MCP-PLUS.md, 2026-08-03).
 *
 * Deliberately shares `pro-relay`'s analysis posture rather than inventing a
 * second one: MCP+ sells the CHANNEL, never the intelligence. Analysis runs on
 * the device (that's the Pro the add-on requires), so an MCP+ identity must
 * never be analysis-entitled either. The two plans are distinct only so
 * billing, revocation, and the connector gate can tell them apart — which is
 * exactly why this is a separate constant and not a reuse of RELAY_PLAN.
 *
 * NOT YET SOLD. No Stripe price, no checkout arm, and no client tier reads it;
 * the plan doc's P1 wires those. It exists now so the analysis guard below is
 * correct on the day an identity first carries it, rather than default-allowing
 * a paying MCP+ user onto the operator's LLM key. */
export const MCP_PLAN = "mcp-plus";

/** The `plan` stamped on a free-tier identity minted via `/free-cold/enroll`
 * (free-cold relay contract). It exists ONLY so a phone can pair a remote
 * assistant and push finished-session snapshots for cold reads — the free half
 * of the Mac's free/Pro boundary, on a device that cannot serve origin-pull.
 * It sells nothing and must never widen: no live relay socket, no write-back,
 * and (via the set below) no LLM spend, ever. The router additionally
 * allowlists this plan to `/free-cold/*` and the connector-management routes,
 * so a new route is closed to it by default. */
export const FREE_COLD_PLAN = "free-cold";

/** Plans that transit context but must never spend an LLM key server-side. */
const RELAY_ONLY_PLANS = new Set<string>([RELAY_PLAN, MCP_PLAN, FREE_COLD_PLAN]);

/** What SessionDO's hello resolves from a `/_entitlement` reply. */
export interface SessionAnalysisAccess {
  /** Gates `runAnalysisPass` — false means no hosted LLM spend this session. */
  userEntitled: boolean;
  /** True only for `pro-relay` identities: analysis is deliberately local, so
   * the client gets a `relay_only` status rather than `subscription_inactive`
   * (whose "Renew" copy would be wrong for a user who never lapsed). */
  relayOnly: boolean;
  /** True only when the PLAN said this is a relay — i.e. this is Cyrano's own
   * deployment serving a relay identity. Distinct from `relayOnly`, which a
   * self-hoster's client also asserts over the wire for its own Worker: that
   * server is theirs, and our retention ceiling has no business applying to it.
   * See `relayRetentionAction`. */
  hostedRelay: boolean;
}

/**
 * The session-level analysis gate. `isEntitled` default-allows any identity
 * with no subscription or promo — which a relay identity is — so without this
 * a relayed Pro session would silently burn the operator's LLM key. Plan wins
 * over the entitlement flag: a transport-only identity is never
 * analysis-entitled, no matter what the registry said.
 *
 * Membership in `RELAY_ONLY_PLANS`, not equality with one plan: MCP+ is sold as
 * transport too, and a new transport plan that forgot to be listed here would
 * fail OPEN onto the operator's key — the expensive direction.
 */
export function sessionAnalysisAccess(ent: {
  entitled?: boolean;
  plan?: string | null;
}): SessionAnalysisAccess {
  if (ent.plan && RELAY_ONLY_PLANS.has(ent.plan)) {
    return { userEntitled: false, relayOnly: true, hostedRelay: true };
  }
  return { userEntitled: ent.entitled !== false, relayOnly: false, hostedRelay: false };
}

// ---- Relayed-session retention ceiling (PLAN-REMOTE.md option C) ----

/**
 * How long a session relayed through CYRANO'S deployment may survive on the
 * server after it ends, whatever retention the user chose on their device.
 *
 * The claim this exists to make literally true is "Remote stores nothing after
 * the call". Without a ceiling that sentence is false for anyone who keeps
 * sessions for 24h — and flatly false for anyone who pins one, since a pinned
 * relayed session is an indefinite server-side copy, i.e. exactly the "database
 * of your conversations" the sentence says does not exist.
 *
 * An hour rather than zero because the request this protects is real: "catch me
 * up on the call I just finished" is the most natural thing to ask a remote
 * assistant, and answering it needs the session to still be there. A number a
 * person can hold in their head is also a better promise than an absolute —
 * "deleted within an hour of the call ending" is checkable in a way that
 * "ephemeral" is not.
 */
export const RELAY_RETENTION_CEILING_MS = 60 * 60_000;

/** Retention ordered by how much it keeps: 0 keeps nothing, 2 keeps forever.
 * Mirrors the client's `RetentionPolicy.keptRank` (SessionTag.swift). */
const RETENTION_KEPT_RANK: Record<"ephemeral" | "24h" | "pinned", number> = {
  ephemeral: 0,
  "24h": 1,
  pinned: 2,
};

/** Runtime guard for retention tiers that arrived over the wire. The wire
 * types are TypeScript fictions — a WebSocket frame can carry any string, and
 * an unknown tier stored into meta would fall through every purge path's
 * comparisons into `keep` (relayRetentionAction's non-relay default), turning
 * a malformed frame into an immortal server copy. */
export function isRetentionTier(value: unknown): value is "ephemeral" | "24h" | "pinned" {
  return value === "ephemeral" || value === "24h" || value === "pinned";
}

/**
 * The tier that keeps less of the two. The one-way valve behind mid-session
 * retention updates (`session.retention`, and the reconnect-hello fallback):
 * a session tag applied mid-call may shorten the server copy's life, and
 * nothing — not a tag removal, not a stale reconnect hello — may lengthen it
 * back. More-private-never-less, the same direction every other policy
 * resolution in this codebase moves.
 */
export function narrowestRetention(a: unknown, b: unknown): "ephemeral" | "24h" | "pinned" {
  // Both sides once crossed a wire, so both get the runtime check the
  // TypeScript union can't provide. A corrupt STORED tier (a) fails to
  // "ephemeral" — keep nothing when the copy's provenance is unknown — while
  // a junk UPDATE (b) is simply ignored: the stored tier is still good.
  if (!isRetentionTier(a)) return "ephemeral";
  if (!isRetentionTier(b)) return a;
  return RETENTION_KEPT_RANK[a] <= RETENTION_KEPT_RANK[b] ? a : b;
}

/** What `endSessionInternal` should do with a finished session's server copy. */
export type RelayRetentionAction =
  | { kind: "purge_now" }
  | { kind: "purge_after"; afterMs: number; ceiling: boolean }
  | { kind: "keep" };

/**
 * Resolve the server-side retention for a finished session. Pure so the ceiling
 * is unit-testable without a Durable Object.
 *
 * The ceiling CLAMPS, it never extends: an `ephemeral` session still purges
 * immediately, because more-private-never-less is the rule everywhere else this
 * codebase resolves two policies against each other (see the session-tag gate).
 * A user who asked for less retention than the ceiling gets what they asked for.
 *
 * `hostedRelay` — not `relayOnly` — is deliberately the predicate. A self-hoster
 * relaying to their OWN Worker also runs relay-only sessions, but that server is
 * theirs; imposing our retention policy on their infrastructure would be us
 * deciding how long their data lives on their machine. Our claim covers our
 * deployment, so our ceiling applies to our deployment.
 */
export function relayRetentionAction(input: {
  retention: "ephemeral" | "24h" | "pinned";
  hostedRelay: boolean;
  ceilingMs?: number;
  retain24hMs: number;
}): RelayRetentionAction {
  if (input.retention === "ephemeral") return { kind: "purge_now" };
  const ceiling = input.ceilingMs ?? RELAY_RETENTION_CEILING_MS;
  if (!input.hostedRelay) {
    return input.retention === "24h"
      ? { kind: "purge_after", afterMs: input.retain24hMs, ceiling: false }
      : { kind: "keep" };
  }
  const requested = input.retention === "24h" ? input.retain24hMs : Number.POSITIVE_INFINITY;
  return {
    kind: "purge_after",
    afterMs: Math.min(requested, ceiling),
    ceiling: ceiling <= requested,
  };
}

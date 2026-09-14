// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import type { AgentKeySummary } from "./types.js";
import {
  BUG_REPORT_PREFIX,
  bugReportKey,
  MAX_BODY_BYTES,
  MAX_STORED_REPORTS,
  RATE_LIMIT_PER_DAY,
  RATE_LIMIT_PREFIX,
  rateLimitKey,
  sanitizeBugReport,
  utcDayBucket,
  type SanitizedBugReport,
} from "./bugreport.js";
import {
  applyUsage,
  usageView,
  USAGE_PERIOD_MS,
  USER_SAFETY_CEILING_MICROS,
  type UsageState,
} from "./usage.js";
import { usageDeltaFromWire } from "./llm/spend.js";
import { FREE_COLD_PLAN, isEntitled, RELAY_PLAN } from "./entitlement.js";
import { generatePromoCode, promoExpiryFromMonths } from "./promo.js";
import { generateLicenseKey, type LicenseRecord } from "./license.js";
import {
  signTrialToken,
  trialSigningConfigured,
  type TrialRecord,
  TRIAL_DAYS,
  HEARTBEAT_INTERVAL_HOURS,
  HEARTBEAT_GRACE_HOURS,
} from "./trial.js";
import {
  normalizeAppVersion,
  normalizePlatform,
  summarizeAdoption,
  type AdoptionSighting,
} from "./adoption.js";
import {
  clampCostParam,
  createCostCollector,
  deviceJoinFor,
  planRevenueFromEnv,
  DEFAULT_COST_ROWS,
  DEFAULT_COST_SCAN,
  MAX_COST_ROWS,
  MAX_COST_SCAN,
  type CostReport,
} from "./costs.js";
import { appleSubscriptionId, appleUserLabel } from "./appstore.js";
import type { Env } from "./env.js";

interface StoredKey {
  label: string;
  hash: string;
  createdAt: number;
  /** The tenant this key was minted for, if any. Undefined for keys minted
   * by the operator (or minted before tenant users existed) — those remain
   * unscoped, exactly as every agent key behaved before this feature. */
  ownerUserId?: string;
  /** Last time a request arrived carrying this key. A key is a standing
   * credential, so its existence says nothing about whether an agent is
   * running right now — this is the only evidence of that, and it decides
   * which agent the app aims a question at by default. */
  lastSeenAt?: number;
  /** Whether this key may read live session context. Undefined means yes:
   * every key could before the flag existed, and a stored `false` is the only
   * thing that takes it away. */
  receivesContext?: boolean;
}

/** How coarse the last-seen stamp is. An agent long-polls every ~20s, and a
 * storage write per poll would be a write amplification of the whole key map
 * for a fact the UI renders as "seen just now" either way. */
const AGENT_SEEN_COALESCE_MS = 60_000;

type ChatGPTIdentityRef =
  | { kind: "operator" }
  | { kind: "user"; userId: string };

interface ChatGPTClientRegistration {
  clientName: string;
  redirectUris: string[];
  issuedAt: number;
}

interface StoredChatGPTPairing {
  identity: ChatGPTIdentityRef;
  label: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * What a pairing code leaves behind once it is spent or lapses. Carries no
 * identity — its only job is to let the authorize page say *why* a code failed
 * ("already used" vs "expired" vs "never existed"), which the single collapsed
 * error could not. Keyed by the same hash as the pairing it replaces.
 */
interface StoredChatGPTPairingTombstone {
  outcome: "used" | "expired";
  at: number;
  expiresAt: number;
}

interface StoredChatGPTAuthorizationCode {
  identity: ChatGPTIdentityRef;
  label: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

interface StoredChatGPTToken {
  identity: ChatGPTIdentityRef;
  connectionId: string;
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

interface StoredChatGPTConnection {
  id: string;
  identity: ChatGPTIdentityRef;
  label: string;
  clientId: string;
  // Exact client_name from dynamic client registration, decoded once at token
  // issue so attribution (Settings rows, edit provenance) can show precisely
  // which MCP client holds the grant. Optional: connections minted before the
  // generalization lack it.
  clientName?: string;
  createdAt: number;
  lastUsedAt?: number;
  accessHash: string;
  refreshHash: string;
}

interface StoredUser {
  userId: string;
  label: string;
  hash: string;
  createdAt: number;
  // Paid-tier fields. All optional
  // so tenant users minted before this deserialize unchanged.
  plan?: string; // "annual" | "monthly" | undefined (free/self-host)
  subStatus?: string; // "active" | "past_due" | "canceled" | undefined
  usage?: UsageState; // per-period meter of OUR LLM spend for this tenant
  // Stripe linkage. Present only for
  // subscribers provisioned through the Stripe webhook; the subscription id is
  // the idempotency key (Stripe redelivers events — we mint at most one tenant
  // token per subscription).
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  // Verified paid-through date (ms), added 2026-08-03. Written from the signed
  // Apple transaction, which states it; Stripe's webhook does not send one, so
  // Stripe subscribers leave it absent and are governed by status alone.
  // entitlement.ts reads it as a backstop against a renewal notification that
  // never arrives — absent means "no opinion", never "expired".
  subExpiresAt?: number;
  // Promo / test key expiry (ms), set when minted via /_promo.
  // Present → entitlement gates on it; absent →
  // a normal (subscription- or operator-minted) tenant. See promo.ts / entitlement.ts.
  promoExpiresAt?: number;
}

/** A minted tenant token stashed for one-time pickup by the post-checkout
 * `/stripe/activated` page, keyed by the Stripe Checkout Session id. Only the
 * hash of a tenant token is ever stored on the user record, so the RAW token
 * has to be held here for the brief window between the webhook minting it and
 * the success page delivering it to the app. Consumed on first read (the
 * `token` is dropped, `consumed` marker kept a while) so a page reload can't
 * re-deliver or rotate a working credential. */
interface ClaimStash {
  token?: string;
  userId: string;
  createdAt: number;
  consumed?: boolean;
}

const USER_PREFIX = "user:";
const USER_ID_INDEX_PREFIX = "user-id:";
const USER_HASH_INDEX_PREFIX = "user-hash:";
const USER_SUBSCRIPTION_INDEX_PREFIX = "user-subscription:";
// Lifetime Pro licenses (A4) — stored by the hash of the key, so a storage dump
// never reveals a usable key. A license is a device-bound record, not a tenant
// identity, so it lives under its own prefix rather than as a StoredUser.
const LICENSE_PREFIX = "license:";
// Free-trial records — keyed by the hash of the
// client-supplied hardware fingerprint, permanent so a reinstall can't earn a
// second trial. Independent of the Ed25519 signing keypair: rotating the keypair
// never resets these, so it never grants anyone a fresh trial.
const TRIAL_PREFIX = "trial:";
const CHATGPT_PAIR_PREFIX = "chatgpt-pair:";
const CHATGPT_PAIR_TOMBSTONE_PREFIX = "chatgpt-pair-spent:";
const CHATGPT_CODE_PREFIX = "chatgpt-code:";
const CHATGPT_ACCESS_PREFIX = "chatgpt-access:";
const CHATGPT_REFRESH_PREFIX = "chatgpt-refresh:";
const CHATGPT_CONNECTION_PREFIX = "chatgpt-connection:";
const CHATGPT_PAIR_TTL_MS = 15 * 60 * 1000;
// How long a spent/lapsed code stays explainable. Long enough to cover a user
// retrying a stale code they still have on screen, short enough that the
// tombstones self-evict rather than accumulating in DO storage forever.
const CHATGPT_PAIR_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const CHATGPT_CODE_TTL_MS = 5 * 60 * 1000;
const CHATGPT_ACCESS_TTL_SECONDS = 60 * 60;
const CHATGPT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `${prefix}_` + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64URL(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacBase64URL(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64URL(new Uint8Array(signature));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function randomPairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const characters = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return `CYR-${characters.slice(0, 4).join("")}-${characters.slice(4, 8).join("")}-${characters.slice(8).join("")}`;
}

type ChatGPTPairingFailure = "pairing_already_used" | "pairing_expired" | "invalid_pairing_code";

/**
 * Resolve a failed pairing lookup against whatever tombstone survives for it.
 * An aged-out tombstone is treated as no tombstone: past that window we can no
 * longer honestly claim the code was ever real.
 */
function chatGPTPairingFailure(
  tombstone: StoredChatGPTPairingTombstone | undefined,
  now: number,
): ChatGPTPairingFailure {
  if (!tombstone || tombstone.expiresAt < now) return "invalid_pairing_code";
  return tombstone.outcome === "used" ? "pairing_already_used" : "pairing_expired";
}

function chatGPTIdentityKey(identity: ChatGPTIdentityRef): string {
  return identity.kind === "operator" ? "operator" : `user:${identity.userId}`;
}

function chatGPTIdentityFromBody(body: Record<string, unknown>): ChatGPTIdentityRef | null {
  if (body.kind === "operator") return { kind: "operator" };
  if (body.kind === "user" && typeof body.user_id === "string" && body.user_id.length > 0) {
    return { kind: "user", userId: body.user_id };
  }
  return null;
}

function chatGPTIdentityMatches(a: ChatGPTIdentityRef, b: ChatGPTIdentityRef): boolean {
  return chatGPTIdentityKey(a) === chatGPTIdentityKey(b);
}

/**
 * Singleton Durable Object (one instance, id "registry") holding:
 *   - revocable "agent keys" — credentials handed to an external agent (a
 *     Hermes claw, or anything else) so it can pull session context and
 *     push results back, without ever being given the app's own AUTH_TOKEN
 *     or a tenant's own bearer token.
 *   - revocable "tenant user" tokens (added 2026-07-13) — credentials an
 *     operator mints for someone else who wants to use THIS deployment
 *     without running their own Worker. Each resolves to a stable `userId`
 *     that session ownership is checked against (see auth.ts, session-do.ts).
 * Only hashes are stored for either kind; the raw secret is returned once,
 * at mint time, same as any normal API key UX.
 */
export class RegistryDO implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    // Older deployments stored every tenant in one JSON value under `users`.
    // Split it once on wake, preserving all existing credentials and Stripe
    // linkage while removing the per-value size ceiling and whole-list writes.
    ctx.blockConcurrencyWhile(() => this.migrateLegacyUsers());
  }

  private static userKey(label: string): string {
    return `${USER_PREFIX}${label}`;
  }

  private async migrateLegacyUsers(): Promise<void> {
    const legacy = await this.ctx.storage.get<Record<string, StoredUser>>("users");
    if (!legacy) return;
    for (const user of Object.values(legacy)) {
      await this.putUser(user);
    }
    await this.ctx.storage.delete("users");
  }

  private async putUser(user: StoredUser): Promise<void> {
    const writes = [
      this.ctx.storage.put(RegistryDO.userKey(user.label), user),
      this.ctx.storage.put(`${USER_ID_INDEX_PREFIX}${user.userId}`, user.label),
      this.ctx.storage.put(`${USER_HASH_INDEX_PREFIX}${user.hash}`, user.label),
    ];
    if (user.stripeSubscriptionId) {
      writes.push(this.ctx.storage.put(
        `${USER_SUBSCRIPTION_INDEX_PREFIX}${user.stripeSubscriptionId}`,
        user.label,
      ));
    }
    await Promise.all(writes);
  }

  private async getUserByLabel(label: string): Promise<StoredUser | undefined> {
    return this.ctx.storage.get<StoredUser>(RegistryDO.userKey(label));
  }

  private async allUsers(): Promise<StoredUser[]> {
    return [...(await this.ctx.storage.list<StoredUser>({ prefix: USER_PREFIX })).values()];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/") {
      return this.mintAgentKey(request);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return this.listAgentKeys(url);
    }
    // PATCH /:label — change one agent key's permissions (today: whether it
    // may read live context). Same label-in-the-path shape as revoke, same
    // ownership rule, and carved out from the internal routes for the same
    // reason the DELETE catch-all is.
    if (
      request.method === "PATCH" &&
      !url.pathname.startsWith("/users") &&
      !url.pathname.startsWith("/_")
    ) {
      const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
      return this.updateAgentKey(request, label);
    }
    if (
      request.method === "DELETE" &&
      !url.pathname.startsWith("/users") &&
      // Internal routes below own their DELETEs — without this carve-out the
      // agent-key catch-all would treat their path as a key label.
      !url.pathname.startsWith("/_bugreport") &&
      !url.pathname.startsWith("/_chatgpt")
    ) {
      const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
      return this.revokeAgentKey(request, label);
    }
    if (request.method === "POST" && url.pathname === "/users") {
      return this.mintUser(request);
    }
    if (request.method === "GET" && url.pathname === "/users") {
      return this.listUsers();
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/users/")) {
      const label = decodeURIComponent(url.pathname.replace(/^\/users\//, ""));
      return this.revokeUser(label);
    }
    if (request.method === "POST" && url.pathname === "/_validate") {
      return this.validateAgentKey(request);
    }
    if (request.method === "POST" && url.pathname === "/_chatgpt/pair") {
      return this.mintChatGPTPairing(request);
    }
    if (request.method === "POST" && url.pathname === "/_chatgpt/register") {
      return this.registerChatGPTClient(request);
    }
    if (request.method === "POST" && url.pathname === "/_chatgpt/authorize") {
      return this.authorizeChatGPT(request);
    }
    if (request.method === "POST" && url.pathname === "/_chatgpt/token") {
      return this.exchangeChatGPTToken(request);
    }
    if (request.method === "POST" && url.pathname === "/_chatgpt/validate") {
      return this.validateChatGPTToken(request);
    }
    if (request.method === "GET" && url.pathname === "/_chatgpt/connections") {
      return this.listChatGPTConnections(url);
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/_chatgpt/connections/")) {
      const id = decodeURIComponent(url.pathname.slice("/_chatgpt/connections/".length));
      return this.revokeChatGPTConnection(url, id);
    }
    if (request.method === "POST" && url.pathname === "/_validate_user") {
      return this.validateUser(request);
    }
    if (request.method === "POST" && url.pathname === "/_active") {
      return this.setActive(request);
    }
    if (request.method === "GET" && url.pathname === "/_latest") {
      return this.getLatest(url);
    }
    if (request.method === "POST" && url.pathname === "/_presence") {
      return this.setPresence(request);
    }
    if (request.method === "POST" && url.pathname === "/_usage") {
      return this.recordUsage(request);
    }
    if (request.method === "GET" && url.pathname === "/_usage") {
      return this.readUsage(url);
    }
    if (request.method === "POST" && url.pathname === "/_provision") {
      return this.provisionSubscriber(request);
    }
    if (request.method === "POST" && url.pathname === "/_subscription") {
      return this.setSubscription(request);
    }
    if (request.method === "POST" && url.pathname === "/_appstore_link") {
      return this.appStoreLink(request);
    }
    if (request.method === "GET" && url.pathname === "/_claim") {
      return this.claim(url);
    }
    if (request.method === "GET" && url.pathname === "/_entitlement") {
      return this.readEntitlement(url);
    }
    if (request.method === "POST" && url.pathname === "/_promo") {
      return this.mintPromo(request);
    }
    // Lifetime Pro licenses (A4). Internal-only, like every other `_` route —
    // reached solely via the Worker's /license/* and /license-keys forwarding.
    if (request.method === "POST" && url.pathname === "/_license/mint") {
      return this.mintLicense(request);
    }
    if (request.method === "POST" && url.pathname === "/_license/activate") {
      return this.activateLicense(request);
    }
    if (request.method === "POST" && url.pathname === "/_license/validate") {
      return this.validateLicense(request);
    }
    if (request.method === "POST" && url.pathname === "/_license/deactivate") {
      return this.deactivateLicense(request);
    }
    if (request.method === "POST" && url.pathname === "/_license/relay-token") {
      return this.relayTokenForLicense(request);
    }
    // Free cold relay. Internal-only, reached
    // solely via the Worker's /free-cold/enroll forwarding.
    if (request.method === "POST" && url.pathname === "/_freecold/enroll") {
      return this.enrollFreeCold(request);
    }
    // Free 3-day trial. Internal-only, reached solely
    // via the Worker's /trial/* forwarding.
    if (request.method === "POST" && url.pathname === "/_trial/start") {
      return this.startTrial(request);
    }
    if (request.method === "POST" && url.pathname === "/_trial/heartbeat") {
      return this.heartbeatTrial(request);
    }
    // Release adoption (adoption.ts). Internal-only, reached solely via the
    // Worker's operator-only GET /adoption.
    if (request.method === "GET" && url.pathname === "/_adoption") {
      return this.adoptionStats(url);
    }
    // Per-subject cost report (costs.ts). Internal-only, reached solely via the
    // Worker's operator-only GET /costs — same discipline as /_adoption.
    if (request.method === "GET" && url.pathname === "/_costs") {
      return this.costReport(url);
    }
    // In-app bug reports (bugreport.ts). Internal-only, reached solely via the
    // Worker's token-less POST /bug-report (submit) and operator-only
    // /bug-reports (read/delete) forwarding.
    if (request.method === "POST" && url.pathname === "/_bugreport") {
      return this.submitBugReport(request);
    }
    if (request.method === "GET" && url.pathname === "/_bugreport") {
      return this.listBugReports(url);
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/_bugreport/")) {
      const id = decodeURIComponent(url.pathname.slice("/_bugreport/".length));
      return this.deleteBugReport(id);
    }

    return new Response("not found", { status: 404 });
  }

  // ---- agent keys ----

  /** `request` carries the identity of whoever is minting (set by index.ts
   * from the already-authorized caller): the new key is scoped to them if
   * they're a tenant, or left unscoped for the operator — matching how
   * every agent key behaved before tenant users existed. */
  private async mintAgentKey(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { label?: string; owner_user_id?: string };
    const label = (body.label ?? "").trim() || `agent-${Date.now()}`;

    const keys = (await this.ctx.storage.get<Record<string, StoredKey>>("keys")) ?? {};
    if (keys[label]) {
      return Response.json({ error: "label_already_exists" }, { status: 409 });
    }

    const key = randomToken("cyrano_agent");
    keys[label] = {
      label,
      hash: await sha256Hex(key),
      createdAt: Date.now(),
      ...(body.owner_user_id ? { ownerUserId: body.owner_user_id } : {}),
    };
    await this.ctx.storage.put("keys", keys);

    return Response.json({ key, label, created_at: keys[label]!.createdAt });
  }

  /** `?owner_user_id=` scopes the list to one tenant's own keys (what a
   * tenant's Settings screen should see); omitted, every key is returned
   * (operator view — unchanged behavior for single-tenant self-host). */
  private async listAgentKeys(url: URL): Promise<Response> {
    const ownerFilter = url.searchParams.get("owner_user_id");
    const keys = (await this.ctx.storage.get<Record<string, StoredKey>>("keys")) ?? {};
    const summaries: AgentKeySummary[] = Object.values(keys)
      .filter((k) => !ownerFilter || k.ownerUserId === ownerFilter)
      .map((k) => ({
        label: k.label,
        created_at: k.createdAt,
        last_seen_at: k.lastSeenAt ?? null,
        receives_context: k.receivesContext !== false,
      }));
    return Response.json({ keys: summaries });
  }

  /** Change what a key is allowed to do without re-minting it. Today that is
   * one flag — whether it may read live context — because a user with two
   * agents connected needs to be able to say "this one follows along, that one
   * only answers when I ask it". Ownership is checked exactly as revoke does. */
  private async updateAgentKey(request: Request, label: string): Promise<Response> {
    const url = new URL(request.url);
    const callerOwnerUserId = url.searchParams.get("owner_user_id");
    const body = (await request.json().catch(() => ({}))) as { receives_context?: boolean };
    const keys = (await this.ctx.storage.get<Record<string, StoredKey>>("keys")) ?? {};
    const existing = keys[label];
    if (!existing) return new Response("not found", { status: 404 });
    if (callerOwnerUserId && existing.ownerUserId !== callerOwnerUserId) {
      return new Response("forbidden", { status: 403 });
    }
    if (typeof body.receives_context === "boolean") {
      existing.receivesContext = body.receives_context;
    }
    await this.ctx.storage.put("keys", keys);
    return Response.json({
      label: existing.label,
      created_at: existing.createdAt,
      last_seen_at: existing.lastSeenAt ?? null,
      receives_context: existing.receivesContext !== false,
    });
  }

  /** Revoking requires owning the key: a tenant can only revoke their own
   * (checked via the `owner_user_id` query param index.ts attaches from the
   * caller's resolved identity); the operator can revoke anything, same as
   * before. */
  private async revokeAgentKey(request: Request, label: string): Promise<Response> {
    const url = new URL(request.url);
    const callerOwnerUserId = url.searchParams.get("owner_user_id");
    const keys = (await this.ctx.storage.get<Record<string, StoredKey>>("keys")) ?? {};
    const existing = keys[label];
    if (!existing) return new Response("not found", { status: 404 });
    if (callerOwnerUserId && existing.ownerUserId !== callerOwnerUserId) {
      return new Response("forbidden", { status: 403 });
    }
    delete keys[label];
    await this.ctx.storage.put("keys", keys);
    return Response.json({ revoked: true });
  }

  /** Every agent request passes through here, which makes it the one place
   * that sees an agent is alive — so it is also where presence is stamped
   * (coalesced, see AGENT_SEEN_COALESCE_MS). Returns the key's label and its
   * context permission so the caller can address a question to one agent and
   * enforce the per-key read gate without a second round trip. */
  private async validateAgentKey(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { key?: string };
    if (!body.key) return Response.json({ valid: false });

    const hash = await sha256Hex(body.key);
    const keys = (await this.ctx.storage.get<Record<string, StoredKey>>("keys")) ?? {};
    const match = Object.values(keys).find((k) => k.hash === hash);
    if (!match) return Response.json({ valid: false });

    const now = Date.now();
    if (match.lastSeenAt === undefined || now - match.lastSeenAt > AGENT_SEEN_COALESCE_MS) {
      match.lastSeenAt = now;
      await this.ctx.storage.put("keys", keys);
    }
    return Response.json({
      valid: true,
      label: match.label,
      ownerUserId: match.ownerUserId,
      receivesContext: match.receivesContext !== false,
    });
  }

  // ---- ChatGPT MCP OAuth / pairing ----

  /**
   * The Mac app authenticates this call with its normal Worker credential at
   * the outer router. The short human-readable code carries only an identity
   * reference, expires quickly, and is consumed by the browser authorization
   * form exactly once.
   */
  private async mintChatGPTPairing(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const identity = chatGPTIdentityFromBody(body);
    if (!identity) return Response.json({ error: "invalid_identity" }, { status: 400 });

    const code = randomPairingCode();
    const createdAt = Date.now();
    const expiresAt = createdAt + CHATGPT_PAIR_TTL_MS;
    const hash = await sha256Hex(code);
    const record: StoredChatGPTPairing = {
      identity,
      label: typeof body.label === "string" ? body.label.slice(0, 80) : "ChatGPT",
      createdAt,
      expiresAt,
    };
    await this.ctx.storage.put(`${CHATGPT_PAIR_PREFIX}${hash}`, record);
    return Response.json({
      pairing_code: code,
      created_at: createdAt,
      expires_at: expiresAt,
    });
  }

  /**
   * Dynamic client registration is stateless: the redirect allowlist is
   * carried in an HMAC-signed client id. A public registration endpoint cannot
   * otherwise be allowed to fill RegistryDO storage with anonymous clients.
   */
  private async registerChatGPTClient(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      client_name?: string;
      redirect_uris?: string[];
    };
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
      return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
    }
    const registration: ChatGPTClientRegistration = {
      clientName: (body.client_name ?? "ChatGPT").slice(0, 120),
      redirectUris: body.redirect_uris,
      issuedAt: Date.now(),
    };
    const payload = base64URL(new TextEncoder().encode(JSON.stringify(registration)));
    const signature = await hmacBase64URL(this.env.AUTH_TOKEN, payload);
    const clientId = `cyrano_chatgpt_${payload}.${signature}`;
    return Response.json({
      client_id: clientId,
      client_id_issued_at: Math.floor(registration.issuedAt / 1000),
      client_name: registration.clientName,
      redirect_uris: registration.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }, { status: 201 });
  }

  private async decodeChatGPTClient(clientId: string): Promise<ChatGPTClientRegistration | null> {
    const match = clientId.match(/^cyrano_chatgpt_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    if (!match) return null;
    const payload = match[1]!;
    const expected = await hmacBase64URL(this.env.AUTH_TOKEN, payload);
    if (!constantTimeEqual(expected, match[2]!)) return null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(decodeBase64URL(payload))) as ChatGPTClientRegistration;
      if (
        typeof parsed.clientName !== "string" ||
        !Array.isArray(parsed.redirectUris) ||
        !parsed.redirectUris.every((value) => typeof value === "string") ||
        typeof parsed.issuedAt !== "number"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Retire a pairing code: drop the live record and leave a tombstone so a
   * retry of the same code gets a specific answer instead of a shrug. Both
   * writes happen inside one DO turn, so a code can never be both live and
   * spent.
   */
  private async retireChatGPTPairing(
    pairingHash: string,
    outcome: StoredChatGPTPairingTombstone["outcome"],
  ): Promise<void> {
    const at = Date.now();
    const tombstone: StoredChatGPTPairingTombstone = {
      outcome,
      at,
      expiresAt: at + CHATGPT_PAIR_TOMBSTONE_TTL_MS,
    };
    await Promise.all([
      this.ctx.storage.delete(`${CHATGPT_PAIR_PREFIX}${pairingHash}`),
      this.ctx.storage.put(`${CHATGPT_PAIR_TOMBSTONE_PREFIX}${pairingHash}`, tombstone),
    ]);
  }

  /** Why a code with no live record failed, as an OAuth-style error slug. */
  private async chatGPTPairingFailureReason(pairingHash: string): Promise<ChatGPTPairingFailure> {
    const key = `${CHATGPT_PAIR_TOMBSTONE_PREFIX}${pairingHash}`;
    const tombstone = await this.ctx.storage.get<StoredChatGPTPairingTombstone>(key);
    const reason = chatGPTPairingFailure(tombstone, Date.now());
    // A tombstone we've aged out is indistinguishable from one that never
    // existed, so stop paying storage for it.
    if (tombstone && reason === "invalid_pairing_code") await this.ctx.storage.delete(key);
    return reason;
  }

  private async authorizeChatGPT(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      pairing_code?: string;
      client_id?: string;
      redirect_uri?: string;
      code_challenge?: string;
      resource?: string;
      scope?: string;
    };
    if (
      !body.pairing_code ||
      !body.client_id ||
      !body.redirect_uri ||
      !body.code_challenge ||
      !body.resource
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const client = await this.decodeChatGPTClient(body.client_id);
    if (!client || !client.redirectUris.includes(body.redirect_uri)) {
      return Response.json({ error: "invalid_client" }, { status: 400 });
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(body.code_challenge)) {
      return Response.json({ error: "invalid_code_challenge" }, { status: 400 });
    }

    const normalizedPairing = body.pairing_code.trim().toUpperCase();
    const pairingHash = await sha256Hex(normalizedPairing);
    const pairingKey = `${CHATGPT_PAIR_PREFIX}${pairingHash}`;
    const pairing = await this.ctx.storage.get<StoredChatGPTPairing>(pairingKey);
    if (!pairing) {
      // No live pairing. A tombstone tells us the code was real and says what
      // became of it; without one the code was never minted here (mistyped, or
      // from a different deployment).
      const reason = await this.chatGPTPairingFailureReason(pairingHash);
      console.log(`chatgpt_pairing_rejected reason=${reason}`);
      return Response.json({ error: reason }, { status: 400 });
    }
    if (pairing.expiresAt < Date.now()) {
      await this.retireChatGPTPairing(pairingHash, "expired");
      console.log("chatgpt_pairing_rejected reason=pairing_expired");
      return Response.json({ error: "pairing_expired" }, { status: 400 });
    }

    // Consume before returning the code. RegistryDO serializes the event, and
    // the authorization code itself is also single-use at token exchange.
    await this.retireChatGPTPairing(pairingHash, "used");
    const code = randomToken("cyrano_oauth_code");
    const codeHash = await sha256Hex(code);
    const now = Date.now();
    const authorization: StoredChatGPTAuthorizationCode = {
      identity: pairing.identity,
      label: pairing.label,
      clientId: body.client_id,
      redirectUri: body.redirect_uri,
      codeChallenge: body.code_challenge,
      resource: body.resource,
      scope: body.scope || "context:read context:write",
      createdAt: now,
      expiresAt: now + CHATGPT_CODE_TTL_MS,
    };
    await this.ctx.storage.put(`${CHATGPT_CODE_PREFIX}${codeHash}`, authorization);
    return Response.json({ code });
  }

  private async exchangeChatGPTToken(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      client_id?: string;
      code_verifier?: string;
      refresh_token?: string;
      resource?: string;
    };
    if (body.grant_type === "authorization_code") {
      return this.exchangeChatGPTAuthorizationCode(body);
    }
    if (body.grant_type === "refresh_token") {
      return this.exchangeChatGPTRefreshToken(body);
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  private async exchangeChatGPTAuthorizationCode(body: {
    code?: string;
    redirect_uri?: string;
    client_id?: string;
    code_verifier?: string;
    resource?: string;
  }): Promise<Response> {
    if (!body.code || !body.redirect_uri || !body.client_id || !body.code_verifier) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const key = `${CHATGPT_CODE_PREFIX}${await sha256Hex(body.code)}`;
    const authorization = await this.ctx.storage.get<StoredChatGPTAuthorizationCode>(key);
    if (!authorization || authorization.expiresAt < Date.now()) {
      if (authorization) await this.ctx.storage.delete(key);
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const verifierDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body.code_verifier),
    );
    const challenge = base64URL(new Uint8Array(verifierDigest));
    if (
      !constantTimeEqual(challenge, authorization.codeChallenge) ||
      body.client_id !== authorization.clientId ||
      body.redirect_uri !== authorization.redirectUri ||
      (body.resource && body.resource !== authorization.resource)
    ) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }

    await this.ctx.storage.delete(key);
    return this.issueChatGPTTokens({
      identity: authorization.identity,
      label: authorization.label,
      clientId: authorization.clientId,
      resource: authorization.resource,
      scope: authorization.scope,
    });
  }

  private async exchangeChatGPTRefreshToken(body: {
    refresh_token?: string;
    client_id?: string;
    resource?: string;
  }): Promise<Response> {
    if (!body.refresh_token || !body.client_id) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const oldRefreshHash = await sha256Hex(body.refresh_token);
    const oldRefreshKey = `${CHATGPT_REFRESH_PREFIX}${oldRefreshHash}`;
    const token = await this.ctx.storage.get<StoredChatGPTToken>(oldRefreshKey);
    if (
      !token ||
      token.expiresAt < Date.now() ||
      token.clientId !== body.client_id ||
      (body.resource && token.resource !== body.resource)
    ) {
      if (token?.expiresAt && token.expiresAt < Date.now()) {
        await this.ctx.storage.delete(oldRefreshKey);
      }
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }

    const connectionKey = `${CHATGPT_CONNECTION_PREFIX}${chatGPTIdentityKey(token.identity)}:${token.connectionId}`;
    const connection = await this.ctx.storage.get<StoredChatGPTConnection>(connectionKey);
    if (!connection || connection.refreshHash !== oldRefreshHash) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }

    await Promise.all([
      this.ctx.storage.delete(oldRefreshKey),
      this.ctx.storage.delete(`${CHATGPT_ACCESS_PREFIX}${connection.accessHash}`),
      this.ctx.storage.delete(connectionKey),
    ]);
    return this.issueChatGPTTokens({
      identity: token.identity,
      label: connection.label,
      clientId: token.clientId,
      resource: token.resource,
      scope: token.scope,
      connectionId: token.connectionId,
      createdAt: connection.createdAt,
    });
  }

  private async issueChatGPTTokens(input: {
    identity: ChatGPTIdentityRef;
    label: string;
    clientId: string;
    resource: string;
    scope: string;
    connectionId?: string;
    createdAt?: number;
  }): Promise<Response> {
    const accessToken = randomToken("cyrano_chatgpt_access");
    const refreshToken = randomToken("cyrano_chatgpt_refresh");
    const accessHash = await sha256Hex(accessToken);
    const refreshHash = await sha256Hex(refreshToken);
    const now = Date.now();
    const connectionId = input.connectionId ?? crypto.randomUUID();
    const access: StoredChatGPTToken = {
      identity: input.identity,
      connectionId,
      clientId: input.clientId,
      resource: input.resource,
      scope: input.scope,
      expiresAt: now + CHATGPT_ACCESS_TTL_SECONDS * 1000,
    };
    const refresh: StoredChatGPTToken = {
      ...access,
      expiresAt: now + CHATGPT_REFRESH_TTL_MS,
    };
    const clientName = (await this.decodeChatGPTClient(input.clientId))?.clientName;
    const connection: StoredChatGPTConnection = {
      id: connectionId,
      identity: input.identity,
      label: input.label,
      clientId: input.clientId,
      ...(clientName ? { clientName } : {}),
      createdAt: input.createdAt ?? now,
      lastUsedAt: now,
      accessHash,
      refreshHash,
    };
    const connectionKey = `${CHATGPT_CONNECTION_PREFIX}${chatGPTIdentityKey(input.identity)}:${connectionId}`;
    await Promise.all([
      this.ctx.storage.put(`${CHATGPT_ACCESS_PREFIX}${accessHash}`, access),
      this.ctx.storage.put(`${CHATGPT_REFRESH_PREFIX}${refreshHash}`, refresh),
      this.ctx.storage.put(connectionKey, connection),
    ]);
    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: CHATGPT_ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: input.scope,
    });
  }

  private async validateChatGPTToken(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { token?: string; resource?: string };
    if (!body.token) return Response.json({ valid: false });
    const hash = await sha256Hex(body.token);
    const key = `${CHATGPT_ACCESS_PREFIX}${hash}`;
    const token = await this.ctx.storage.get<StoredChatGPTToken>(key);
    if (!token) return Response.json({ valid: false });
    // Expiry is the ONLY reason to destroy the record. A resource mismatch is
    // "this live token isn't for this audience" — answer no and leave it
    // alone. Deleting on mismatch means the day the Worker answers on a
    // second hostname (a custom domain beside workers.dev), one request to
    // the wrong origin silently revokes a working connection, and the
    // connection record still lists it as active.
    if (token.expiresAt < Date.now()) {
      await this.ctx.storage.delete(key);
      return Response.json({ valid: false });
    }
    if (body.resource && token.resource !== body.resource) {
      return Response.json({ valid: false });
    }

    const connectionKey = `${CHATGPT_CONNECTION_PREFIX}${chatGPTIdentityKey(token.identity)}:${token.connectionId}`;
    const connection = await this.ctx.storage.get<StoredChatGPTConnection>(connectionKey);
    if (!connection || connection.accessHash !== hash) {
      return Response.json({ valid: false });
    }
    if (!connection.lastUsedAt || Date.now() - connection.lastUsedAt > 5 * 60 * 1000) {
      connection.lastUsedAt = Date.now();
      await this.ctx.storage.put(connectionKey, connection);
    }
    // label/client_name ride along so the MCP layer can attribute tool calls
    // to the exact connected client (e.g. edit provenance, logs).
    const attribution = {
      label: connection.label,
      ...(connection.clientName ? { client_name: connection.clientName } : {}),
    };
    return Response.json(
      token.identity.kind === "user"
        ? { valid: true, kind: "user", user_id: token.identity.userId, scope: token.scope, ...attribution }
        : { valid: true, kind: "operator", scope: token.scope, ...attribution },
    );
  }

  private async listChatGPTConnections(url: URL): Promise<Response> {
    const identity = chatGPTIdentityFromBody({
      kind: url.searchParams.get("kind"),
      user_id: url.searchParams.get("user_id"),
    });
    if (!identity) return Response.json({ error: "invalid_identity" }, { status: 400 });
    const prefix = `${CHATGPT_CONNECTION_PREFIX}${chatGPTIdentityKey(identity)}:`;
    const connections = [...(await this.ctx.storage.list<StoredChatGPTConnection>({ prefix })).values()]
      .map((connection) => ({
        id: connection.id,
        label: connection.label,
        ...(connection.clientName ? { client_name: connection.clientName } : {}),
        created_at: connection.createdAt,
        ...(connection.lastUsedAt ? { last_used_at: connection.lastUsedAt } : {}),
      }))
      .sort((a, b) => b.created_at - a.created_at);
    return Response.json({ connections });
  }

  private async revokeChatGPTConnection(url: URL, id: string): Promise<Response> {
    const identity = chatGPTIdentityFromBody({
      kind: url.searchParams.get("kind"),
      user_id: url.searchParams.get("user_id"),
    });
    if (!identity) return Response.json({ error: "invalid_identity" }, { status: 400 });
    const key = `${CHATGPT_CONNECTION_PREFIX}${chatGPTIdentityKey(identity)}:${id}`;
    const connection = await this.ctx.storage.get<StoredChatGPTConnection>(key);
    if (!connection) return new Response("not found", { status: 404 });
    if (!chatGPTIdentityMatches(connection.identity, identity)) {
      return new Response("forbidden", { status: 403 });
    }
    await Promise.all([
      this.ctx.storage.delete(`${CHATGPT_ACCESS_PREFIX}${connection.accessHash}`),
      this.ctx.storage.delete(`${CHATGPT_REFRESH_PREFIX}${connection.refreshHash}`),
      this.ctx.storage.delete(key),
    ]);
    return Response.json({ revoked: true });
  }

  // ---- tenant users ----

  /** Operator-only at the routing layer (index.ts requires an operator
   * identity before forwarding here) — tenants don't mint other tenants. */
  private async mintUser(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { label?: string };
    const label = (body.label ?? "").trim() || `user-${Date.now()}`;

    if (await this.getUserByLabel(label)) {
      return Response.json({ error: "label_already_exists" }, { status: 409 });
    }

    const token = randomToken("cyrano_user");
    const userId = crypto.randomUUID();
    const user: StoredUser = { userId, label, hash: await sha256Hex(token), createdAt: Date.now() };
    await this.putUser(user);

    return Response.json({ token, user_id: userId, label, created_at: user.createdAt });
  }

  private async listUsers(): Promise<Response> {
    const summaries = (await this.allUsers()).map((u) => ({
      label: u.label,
      user_id: u.userId,
      created_at: u.createdAt,
    }));
    return Response.json({ users: summaries });
  }

  private async revokeUser(label: string): Promise<Response> {
    const user = await this.getUserByLabel(label);
    if (!user) return new Response("not found", { status: 404 });
    const deletes = [
      this.ctx.storage.delete(RegistryDO.userKey(label)),
      this.ctx.storage.delete(`${USER_ID_INDEX_PREFIX}${user.userId}`),
      this.ctx.storage.delete(`${USER_HASH_INDEX_PREFIX}${user.hash}`),
    ];
    if (user.stripeSubscriptionId) {
      deletes.push(this.ctx.storage.delete(`${USER_SUBSCRIPTION_INDEX_PREFIX}${user.stripeSubscriptionId}`));
    }
    await Promise.all(deletes);
    return Response.json({ revoked: true });
  }

  private async validateUser(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { token?: string };
    if (!body.token) return Response.json({ valid: false });

    const hash = await sha256Hex(body.token);
    const label = await this.ctx.storage.get<string>(`${USER_HASH_INDEX_PREFIX}${hash}`);
    const match = label ? await this.getUserByLabel(label) : undefined;
    // `plan` rides along so the router can scope narrow plans (free-cold's
    // allowlist) without a second registry round-trip per request.
    return Response.json(
      match
        ? { valid: true, userId: match.userId, label: match.label, ...(match.plan ? { plan: match.plan } : {}) }
        : { valid: false },
    );
  }

  // ---- "latest active session" (per-tenant when the session has an owner) ----

  /**
   * Lets an agent point at one stable URL ("/agent/latest/...") instead of
   * having to be reconfigured with a fresh session ID every ~30-minute
   * session. SessionDO calls this once, on `hello`, to claim "latest" —
   * scoped under `latest:<userId>` for a tenant's session, or the bare
   * `latest` key for an operator/self-host session (unchanged from before
   * tenancy existed, so a single-tenant deployment behaves identically).
   */
  private async setActive(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { session_id?: string; owner_user_id?: string };
    if (!body.session_id) return Response.json({ error: "missing_session_id" }, { status: 400 });
    const key = body.owner_user_id ? `latest:${body.owner_user_id}` : "latest";
    await this.ctx.storage.put(key, { session_id: body.session_id, started_at: Date.now() });
    return Response.json({ ok: true });
  }

  /**
   * Record that the user's app is active right now (presence contract,
   * Phase 4). The client POSTs this on foreground/launch when an agent is
   * reachable; a connected agent reads it back through `/agent/latest` and stays
   * warm instead of backing off, so the first idle question doesn't wait out the
   * agent's poll backoff. Presence is a bare timestamp — no content, no session,
   * just "someone's here." Scoped exactly like `latest:` so a tenant only ever
   * warms their own agent.
   */
  private async setPresence(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { owner_user_id?: string };
    const key = body.owner_user_id ? `presence:${body.owner_user_id}` : "presence";
    await this.ctx.storage.put(key, { at: Date.now() });
    return Response.json({ ok: true });
  }

  private async getLatest(url: URL): Promise<Response> {
    const ownerUserId = url.searchParams.get("owner_user_id");
    const key = ownerUserId ? `latest:${ownerUserId}` : "latest";
    const presenceKey = ownerUserId ? `presence:${ownerUserId}` : "presence";
    const latest = await this.ctx.storage.get<{ session_id: string; started_at: number }>(key);
    // Presence rides along on the same read the agent already makes for the
    // latest session, so warming the agent costs no extra round trip: when
    // there is no live session yet, `presence_at` tells the agent whether the
    // user is around and context may be imminent.
    const presence = await this.ctx.storage.get<{ at: number }>(presenceKey);
    const presenceAt = presence?.at ?? null;
    if (!latest) return Response.json({ session_id: null, presence_at: presenceAt });
    return Response.json({ ...latest, presence_at: presenceAt });
  }

  // ---- per-user LLM cost meter (paid hosted tier) ----

  private async findUserEntry(
    userId: string,
  ): Promise<StoredUser | null> {
    const label = await this.ctx.storage.get<string>(`${USER_ID_INDEX_PREFIX}${userId}`);
    if (!label) return null;
    return (await this.getUserByLabel(label)) ?? null;
  }

  /**
   * SessionDO reports OUR LLM spend here (micro-dollars) keyed by the session's
   * `owner_user_id`, so per-session budgets aggregate into a per-user,
   * per-period total. Returns the ceiling verdict so the caller can degrade the
   * smart layer. A session with no owner (operator / self-host) never calls
   * this — those spend against the operator's own account, not a tenant meter.
   *
   * The body carries a `legs` breakdown (provider+model+basis) and a
   * `byok_calls` count alongside `delta_micros`. Both are optional: a body
   * without them meters exactly as it did before the breakdown existed, and a
   * body with `byok_calls` but no spend is a legitimate report — it says this
   * subject made calls on their OWN key, which costs us nothing and is not the
   * same thing as making no calls (defect D5).
   */
  private async recordUsage(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      user_id?: string;
      delta_micros?: number;
    };
    if (!body.user_id) return Response.json({ error: "missing_user_id" }, { status: 400 });

    const found = await this.findUserEntry(body.user_id);
    if (!found) return Response.json({ found: false, over_ceiling: false });

    const now = Date.now();
    const usage = applyUsage(found.usage, usageDeltaFromWire(body), now);
    await this.putUser({ ...found, usage });

    const view = usageView(usage, now);
    return Response.json({
      found: true,
      spend_micros: view.spendMicros,
      lifetime_micros: view.lifetimeMicros,
      period_start: view.periodStart,
      over_ceiling: view.overCeiling,
      plan: found.plan ?? null,
      sub_status: found.subStatus ?? null,
    });
  }

  private async readUsage(url: URL): Promise<Response> {
    const userId = url.searchParams.get("user_id");
    if (!userId) return Response.json({ error: "missing_user_id" }, { status: 400 });

    const found = await this.findUserEntry(userId);
    if (!found) return Response.json({ found: false });

    const view = usageView(found.usage, Date.now());
    return Response.json({
      found: true,
      spend_micros: view.spendMicros,
      lifetime_micros: view.lifetimeMicros,
      period_start: view.periodStart,
      over_ceiling: view.overCeiling,
      ceiling_micros: view.ceilingMicros,
      plan: found.plan ?? null,
      sub_status: found.subStatus ?? null,
      // Why this subject costs what it costs (defect D3): one row per
      // provider+model with calls, tokens, micro-dollars and the basis the
      // figure was priced on. `exact_fraction` is how much of the attributed
      // spend is a published list price rather than a configured or estimated
      // rate. `byok_calls` distinguishes a cheap subject from one bringing
      // their own key (defect D5).
      legs: view.legs.map((l) => ({
        provider: l.provider,
        model: l.model,
        calls: l.calls,
        input_tokens: l.inputTokens,
        output_tokens: l.outputTokens,
        micros: l.micros,
        basis: l.basis,
      })),
      byok_calls: view.byokCalls,
      lifetime_byok_calls: view.lifetimeByokCalls,
      attributed_micros: view.attributedMicros,
      basis_micros: view.basisMicros,
      // NULL, not 1, when nothing is attributed: an honesty number must not
      // read best when the least is known (every pre-breakdown record is in
      // exactly that state — spend, no legs — for the rest of its period).
      exact_fraction: view.exactFraction,
      // SHADOW SPEND: our dollars on this subject's traffic that the subject
      // never asked for and is NOT charged for — today the PRICE_TEST_TARGETS
      // fan-out. Excluded from spend_micros and from over_ceiling on purpose;
      // reported here so a cost report can say what a subject really cost us
      // (`total_cost_micros`) instead of understating it.
      shadow_micros: view.shadowMicros,
      lifetime_shadow_micros: view.lifetimeShadowMicros,
      shadow_legs: view.shadowLegs.map((l) => ({
        provider: l.provider,
        model: l.model,
        calls: l.calls,
        input_tokens: l.inputTokens,
        output_tokens: l.outputTokens,
        micros: l.micros,
        basis: l.basis,
      })),
      total_cost_micros: view.totalCostMicros,
    });
  }

  // ---- Stripe subscriptions (paid hosted tier) ----

  private async findUserBySubscription(
    subscriptionId: string,
  ): Promise<StoredUser | null> {
    const label = await this.ctx.storage.get<string>(`${USER_SUBSCRIPTION_INDEX_PREFIX}${subscriptionId}`);
    if (!label) return null;
    return (await this.getUserByLabel(label)) ?? null;
  }

  /** Aligns the meter period to the Stripe billing period so per-user spend
   * resets on renewal, not on a rolling 30-day window. Keeps lifetime totals.
   * The provider+model breakdown and the BYOK count are period-scoped — they
   * explain THIS period's bill — so they reset with the spend they explain. */
  private static alignedUsage(prev: UsageState | undefined, periodStartMs: number): UsageState {
    return {
      periodStart: periodStartMs,
      spendMicros: 0,
      lifetimeSpendMicros: prev?.lifetimeSpendMicros ?? 0,
      legs: [],
      byokCalls: 0,
      lifetimeByokCalls: prev?.lifetimeByokCalls ?? 0,
      // Period-scoped like the spend it sits beside; lifetime total kept.
      shadowMicros: 0,
      lifetimeShadowMicros: prev?.lifetimeShadowMicros ?? 0,
    };
  }

  /**
   * A paid `checkout.session.completed` or
   * `checkout.session.async_payment_succeeded`: mint a tenant token for a brand-new
   * subscriber, or reuse the existing one on a Stripe redelivery. Idempotent
   * by `stripe_subscription_id` — Stripe re-sends webhook events, and this must
   * never mint two tokens (two bills' worth of access) for one subscription.
   *
   * A newly minted token is stashed under `claim:<cs_id>` for one-time pickup
   * by the success page (only the hash lands on the user record). A reuse
   * normally returns no token — the subscriber already has one. If the same
   * checkout still has an unconsumed claim stash, return that original token
   * so the success-page fallback cannot lose a race with the webhook.
   */
  private async provisionSubscriber(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as {
      stripe_subscription_id?: string;
      stripe_customer_id?: string;
      plan?: string;
      sub_status?: string;
      period_start?: number;
      cs_id?: string;
    };
    if (!b.stripe_subscription_id) {
      return Response.json({ error: "missing_subscription_id" }, { status: 400 });
    }

    // Prepare the candidate outside the transaction: Web Crypto is external
    // async work and must not sit between the uniqueness check and writes.
    const label = `stripe_${b.stripe_subscription_id}`;
    const token = randomToken("cyrano_user");
    const userId = crypto.randomUUID();
    const candidate: StoredUser = {
      userId,
      label,
      hash: await sha256Hex(token),
      createdAt: Date.now(),
      plan: b.plan,
      subStatus: b.sub_status ?? "active",
      stripeCustomerId: b.stripe_customer_id,
      stripeSubscriptionId: b.stripe_subscription_id,
      usage: b.period_start ? RegistryDO.alignedUsage(undefined, b.period_start) : undefined,
    };

    const result = await this.ctx.storage.transaction(async (txn) => {
      const subscriptionKey = `${USER_SUBSCRIPTION_INDEX_PREFIX}${b.stripe_subscription_id}`;
      const existingLabel = await txn.get<string>(subscriptionKey);
      const existing = existingLabel
        ? await txn.get<StoredUser>(RegistryDO.userKey(existingLabel))
        : undefined;

      if (existing) {
        // Reuse: refresh subscription state, never rotate the live token.
        const updated: StoredUser = {
          ...existing,
          plan: b.plan ?? existing.plan,
          subStatus: b.sub_status ?? existing.subStatus,
          stripeCustomerId: b.stripe_customer_id ?? existing.stripeCustomerId,
          usage: b.period_start ? RegistryDO.alignedUsage(existing.usage, b.period_start) : existing.usage,
        };
        await txn.put(RegistryDO.userKey(updated.label), updated);
        await txn.put(`${USER_ID_INDEX_PREFIX}${updated.userId}`, updated.label);
        await txn.put(`${USER_HASH_INDEX_PREFIX}${updated.hash}`, updated.label);
        await txn.put(subscriptionKey, updated.label);

        const claim = b.cs_id
          ? await txn.get<ClaimStash>(`claim:${b.cs_id}`)
          : undefined;
        return { reused: true as const, userId: updated.userId, token: claim?.token };
      }

      // The subscription lookup and every user/index/claim write commit as one
      // unit, so completed + async-succeeded webhook deliveries cannot mint
      // two credentials for the same Stripe subscription.
      await txn.put(RegistryDO.userKey(candidate.label), candidate);
      await txn.put(`${USER_ID_INDEX_PREFIX}${candidate.userId}`, candidate.label);
      await txn.put(`${USER_HASH_INDEX_PREFIX}${candidate.hash}`, candidate.label);
      await txn.put(subscriptionKey, candidate.label);
      if (b.cs_id) {
        const stash: ClaimStash = { token, userId: candidate.userId, createdAt: Date.now() };
        await txn.put(`claim:${b.cs_id}`, stash);
      }
      return { reused: false as const, userId: candidate.userId, token };
    });

    return Response.json({
      reused: result.reused,
      user_id: result.userId,
      ...(result.token ? { token: result.token } : {}),
    });
  }

  /**
   * `customer.subscription.updated|deleted` / `invoice.payment_failed`: update
   * an existing subscriber's plan/status (degrade, never delete — the token
   * keeps working through a grace window; a canceled sub just flips the flag).
   * A no-op when the subscription isn't one we minted for. Keyed by
   * subscription id (webhook events) or user_id (the handoff's direct form).
   */
  private async setSubscription(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as {
      stripe_subscription_id?: string;
      user_id?: string;
      plan?: string;
      sub_status?: string;
      period_start?: number;
      period_end?: number;
      stripe_customer_id?: string;
    };
    const found = b.stripe_subscription_id
      ? await this.findUserBySubscription(b.stripe_subscription_id)
      : b.user_id
        ? await this.findUserEntry(b.user_id)
        : null;
    if (!found) return Response.json({ found: false });

    await this.putUser({
      ...found,
      plan: b.plan ?? found.plan,
      subStatus: b.sub_status ?? found.subStatus,
      stripeCustomerId: b.stripe_customer_id ?? found.stripeCustomerId,
      // A renewal notification carries the NEW paid-through date, and moving it
      // forward is the whole point: entitlement.ts treats an `active` record
      // stuck behind its expiry as one nobody ever told us about. Stripe never
      // sends the field, so its subscribers keep whatever they had (nothing).
      subExpiresAt: b.period_end ?? found.subExpiresAt,
      usage: b.period_start ? RegistryDO.alignedUsage(found.usage, b.period_start) : found.usage,
    });
    return Response.json({ found: true, user_id: found.userId });
  }

  /**
   * One-time token delivery for the post-checkout page. The first read returns
   * the stashed token and marks it consumed; later reads (a reload) return
   * `consumed` with no token, so a working credential is never re-issued or
   * rotated out from under an already-activated app.
   */
  private async claim(url: URL): Promise<Response> {
    const csId = url.searchParams.get("cs_id");
    if (!csId) return Response.json({ error: "missing_cs_id" }, { status: 400 });

    const key = `claim:${csId}`;
    const stash = await this.ctx.storage.get<ClaimStash>(key);
    if (!stash) return Response.json({ found: false });
    if (stash.consumed || !stash.token) {
      return Response.json({ found: true, consumed: true });
    }

    await this.ctx.storage.put(key, { userId: stash.userId, createdAt: stash.createdAt, consumed: true });
    return Response.json({ found: true, token: stash.token, user_id: stash.userId });
  }

  /**
   * Whether a tenant is entitled to hosted analysis right now (SessionDO asks
   * at hello for owned, hosted-key sessions). A lapsed subscription degrades to
   * on-device — see entitlement.ts. Unknown user fails OPEN (entitled) so a
   * lookup miss never wrongly kills a session; a canceled subscriber's record
   * still exists (we degrade-don't-delete) and reads `subStatus: "canceled"`.
   */
  private async readEntitlement(url: URL): Promise<Response> {
    const userId = url.searchParams.get("user_id");
    if (!userId) return Response.json({ error: "missing_user_id" }, { status: 400 });
    const found = await this.findUserEntry(userId);
    if (!found) return Response.json({ found: false, entitled: true });
    return Response.json({
      found: true,
      entitled: isEntitled(found, Date.now()),
      // SessionDO needs the plan to spot `pro-relay` identities — isEntitled
      // default-allows them (no sub, no promo), and the "never spend our LLM
      // key on a relay session" guard keys on the plan, not the flag.
      plan: found.plan ?? null,
      sub_status: found.subStatus ?? null,
      promo_expires_at: found.promoExpiresAt ?? null,
    });
  }

  /**
   * Mint a promotional / test key (operator-gated at the router). The returned
   * `code` (CYRANO-XXXX-XXXX-XXXX) IS the tenant token — stored hashed like any
   * other, so a tester pastes it into "Activate subscription" and it works for
   * `months` months, then the entitlement gate degrades it to on-device.
   * `months <= 0` mints an unlimited (never-expiring) comp key.
   */
  private async mintPromo(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as { months?: number; label?: string };
    const now = Date.now();
    const code = generatePromoCode();
    const months = Math.max(0, Math.floor(b.months ?? 1));
    const promoExpiresAt = promoExpiryFromMonths(months, now);

    const label = (b.label ?? "").trim() || `promo_${code}`;
    if (await this.getUserByLabel(label)) {
      return Response.json({ error: "label_already_exists" }, { status: 409 });
    }

    const userId = crypto.randomUUID();
    const user: StoredUser = {
      userId,
      label,
      hash: await sha256Hex(code),
      createdAt: now,
      ...(promoExpiresAt != null ? { promoExpiresAt } : {}),
    };
    await this.putUser(user);

    return Response.json({
      code,
      user_id: userId,
      label,
      months,
      expires_at: promoExpiresAt,
      created_at: now,
    });
  }

  // ---- Lifetime Pro licenses (A4) ----
  //
  // These run inside this single, serialized Durable Object, so the device
  // binding in `activateLicense` is atomically consistent — none of the
  // cross-colo compare-and-swap dance a KV-backed license server needs. The
  // request/response shapes preserve the established client contract so the
  // LicenseManager port speaks to both identically.

  private async licenseStorageKey(key: string): Promise<string> {
    return `${LICENSE_PREFIX}${await sha256Hex(key.trim())}`;
  }

  /**
   * The optional adoption fields off a licensing/trial body (adoption.ts).
   *
   * Returns a partial to SPREAD over the record, never a pair of values to
   * assign: a client that sends nothing — an older build, or one that sends
   * junk — must leave whatever the record already knows intact rather than
   * blanking it, or every pre-upgrade heartbeat would erase the version its
   * own last activate reported.
   */
  private adoptionFields(body: { app_version?: unknown; platform?: unknown }): {
    app_version?: string;
    platform?: string;
  } {
    const version = normalizeAppVersion(body.app_version);
    const platform = normalizePlatform(body.platform);
    return {
      ...(version ? { app_version: version } : {}),
      ...(platform ? { platform } : {}),
    };
  }

  /** Mint a device-bindable license key (operator-only upstream). A future
   *  Stripe `mode:"payment"` webhook writes this same record. */
  private async mintLicense(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as { email?: string };
    const now = new Date().toISOString();
    const key = generateLicenseKey();
    const record: LicenseRecord = {
      customer_email: (b.email ?? "").trim() || null,
      created_at: now,
      device_id: null,
      device_name: null,
      activated_at: null,
      last_seen_at: null,
    };
    await this.ctx.storage.put(await this.licenseStorageKey(key), record);
    return Response.json({ license_key: key, customer_email: record.customer_email, created_at: now });
  }

  /** Bind a license to a device. If it is already bound elsewhere, refuse with
   *  the existing device name so the app can prompt to deactivate it first. */
  private async activateLicense(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as {
      license_key?: string;
      device_id?: string;
      device_name?: string;
      app_version?: string;
      platform?: string;
    };
    const key = b.license_key?.trim();
    const deviceId = b.device_id?.trim();
    const deviceName = b.device_name?.trim() || "unknown device";
    if (!key || !deviceId) {
      return Response.json({ valid: false, reason: "missing license_key or device_id" }, { status: 400 });
    }

    const storageKey = await this.licenseStorageKey(key);
    const record = await this.ctx.storage.get<LicenseRecord>(storageKey);
    if (!record) {
      return Response.json({ valid: false, reason: "unknown license key" }, { status: 404 });
    }
    if (record.revoked_at) {
      return Response.json({ valid: false, reason: "license revoked" }, { status: 410 });
    }
    if (record.device_id && record.device_id !== deviceId) {
      return Response.json({
        valid: false,
        reason: "already activated on another device",
        existing_device_name: record.device_name,
        customer_email: record.customer_email,
      });
    }

    const now = new Date().toISOString();
    const updated: LicenseRecord = {
      ...record,
      device_id: deviceId,
      device_name: deviceName,
      activated_at: record.activated_at ?? now,
      last_seen_at: now,
      ...this.adoptionFields(b),
    };
    await this.ctx.storage.put(storageKey, updated);
    return Response.json({ valid: true, customer_email: updated.customer_email });
  }

  /** Periodic re-check from the app. Only ever returns {valid:false} when the
   *  license is actively known-bad (revoked / re-bound elsewhere); the client
   *  treats any non-2xx as "offline" and coasts on its grace window. */
  private async validateLicense(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as {
      license_key?: string;
      device_id?: string;
      app_version?: string;
      platform?: string;
    };
    const key = b.license_key?.trim();
    const deviceId = b.device_id?.trim();
    if (!key || !deviceId) {
      return Response.json({ valid: false }, { status: 400 });
    }
    const storageKey = await this.licenseStorageKey(key);
    const record = await this.ctx.storage.get<LicenseRecord>(storageKey);
    if (!record || record.revoked_at || record.device_id !== deviceId) {
      return Response.json({ valid: false });
    }
    await this.ctx.storage.put(storageKey, {
      ...record,
      last_seen_at: new Date().toISOString(),
      ...this.adoptionFields(b),
    });
    return Response.json({ valid: true });
  }

  /** Free the device slot so the key can be re-bound on another machine.
   *  Also severs the license's relay credential, if one exists — the relay
   *  token's authority derives from an ACTIVE binding on THIS device, so it
   *  must not outlive the binding. */
  private async deactivateLicense(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as { license_key?: string; device_id?: string };
    const key = b.license_key?.trim();
    const deviceId = b.device_id?.trim();
    if (!key || !deviceId) {
      return Response.json({ valid: false }, { status: 400 });
    }
    const storageKey = await this.licenseStorageKey(key);
    const record = await this.ctx.storage.get<LicenseRecord>(storageKey);
    if (!record) {
      return Response.json({ valid: false }, { status: 404 });
    }
    if (record.device_id && record.device_id !== deviceId) {
      return Response.json({ valid: false, reason: "bound to another device" }, { status: 409 });
    }
    await this.invalidateRelayCredential(record);
    await this.ctx.storage.put(storageKey, {
      ...record,
      device_id: null,
      device_name: null,
      activated_at: null,
      last_seen_at: null,
    });
    return Response.json({ valid: true });
  }

  // ---- Pro live relay ----

  /**
   * Exchange an ACTIVE, device-bound Pro license for a `pro-relay` tenant
   * token — the credential a Pro user's live session presents to transit the
   * Worker for the agent loop. Idempotent per license (same discipline as
   * Stripe's `/_provision`): the identity is minted once and reused forever;
   * a re-request ROTATES the token (new secret, old one dead) rather than
   * minting a second identity, which is also how a lost token is recovered —
   * the license is re-presented, so only the raw token's hash ever persists.
   *
   * The identity carries `plan: "pro-relay"`, which SessionDO's hello turns
   * into "no hosted analysis, ever" (see entitlement.sessionAnalysisAccess) —
   * relay grants transit, never LLM spend on the operator's key.
   */
  /**
   * Exchange a verified App Store subscription for a tenant token.
   *
   * Structurally `relayTokenForLicense`, not `provisionSubscriber`, and that
   * choice is the whole design: `provisionSubscriber` returns the token only on
   * first mint, because Stripe hands it to a web page once. Apple has no such
   * page. The client asks for this directly after purchase, after a restore on
   * a second device, and after every renewal — and each of those needs a usable
   * token in the response. So this ROTATES on re-request, like the relay path,
   * and the old secret dies with it.
   *
   * The caller has already verified Apple's signature (appstore.ts). Nothing
   * here re-checks entitlement: by the time it runs, the transaction is proven.
   *
   * `stripeSubscriptionId` carries the `apple:<originalTransactionId>` id so the
   * existing `user-subscription:` index — and therefore `_subscription`, which
   * Apple's notifications write through — finds this record with no new index
   * and no changes to putUser/revokeUser. The field name is Stripe's; the index
   * it feeds is not.
   *
   * Both the id and the label are namespaced by Apple's environment
   * (appstore.ts owns the rule, so the two can never drift apart). A sandbox
   * purchase — TestFlight, App Review, any sandbox tester — therefore lands on
   * its OWN identity: separately countable, separately revocable, and priced
   * at zero by the cost report instead of at the plan's list price. Sandbox
   * transaction ids are also minted from a different sequence to production
   * ones and nothing promises the two never coincide, which matters more here
   * than anywhere else because this route ROTATES: an unnamespaced collision
   * would hand a paying customer's tenant a new token and 401 every device
   * they own.
   */
  private async appStoreLink(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as {
      original_transaction_id?: string;
      environment?: string;
      plan?: string;
      sub_status?: string;
      period_start?: number;
      period_end?: number;
    };
    const originalTransactionId = b.original_transaction_id?.trim();
    if (!originalTransactionId) {
      return Response.json({ error: "missing_transaction_id" }, { status: 400 });
    }

    // The caller has already verified the environment against the deployment's
    // allow-list; an absent one can only be a caller that predates the field,
    // and defaulting it to Production preserves that caller's identities.
    const environment = b.environment?.trim() || "Production";
    const subscriptionId = appleSubscriptionId(originalTransactionId, environment);
    const label = appleUserLabel(originalTransactionId, environment);
    // Prepared outside the transaction: Web Crypto is external async work, the
    // same rule provisionSubscriber and relayTokenForLicense follow.
    const token = randomToken("cyrano_user");
    const tokenHash = await sha256Hex(token);
    const freshUserId = crypto.randomUUID();

    const result = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<StoredUser>(RegistryDO.userKey(label));
      const user: StoredUser = existing
        ? {
            ...existing,
            hash: tokenHash,
            plan: b.plan ?? existing.plan,
            subStatus: b.sub_status ?? existing.subStatus,
            stripeSubscriptionId: subscriptionId,
            // The freshly verified paid-through date replaces the stored one:
            // a relink after a renewal is the newer truth. `??` and not a bare
            // assignment so a payload without one leaves the record alone.
            subExpiresAt: b.period_end ?? existing.subExpiresAt,
            usage: b.period_start
              ? RegistryDO.alignedUsage(existing.usage, b.period_start)
              : existing.usage,
          }
        : {
            userId: freshUserId,
            label,
            hash: tokenHash,
            createdAt: Date.now(),
            plan: b.plan,
            subStatus: b.sub_status ?? "active",
            stripeSubscriptionId: subscriptionId,
            subExpiresAt: b.period_end,
            usage: b.period_start ? RegistryDO.alignedUsage(undefined, b.period_start) : undefined,
          };

      // Rotation kills the old secret before the new one is indexed.
      if (existing) await txn.delete(`${USER_HASH_INDEX_PREFIX}${existing.hash}`);
      await txn.put(RegistryDO.userKey(label), user);
      await txn.put(`${USER_ID_INDEX_PREFIX}${user.userId}`, label);
      await txn.put(`${USER_HASH_INDEX_PREFIX}${user.hash}`, label);
      await txn.put(`${USER_SUBSCRIPTION_INDEX_PREFIX}${subscriptionId}`, label);
      return { userId: user.userId, rotated: Boolean(existing) } as const;
    });

    return Response.json({ token, user_id: result.userId, rotated: result.rotated });
  }

  private async relayTokenForLicense(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as { license_key?: string; device_id?: string };
    const key = b.license_key?.trim();
    const deviceId = b.device_id?.trim();
    if (!key || !deviceId) {
      return Response.json({ valid: false, reason: "missing license_key or device_id" }, { status: 400 });
    }

    const storageKey = await this.licenseStorageKey(key);
    // The label is derived from the license hash, so the license itself is the
    // idempotency key — no scan, and deactivate can find the identity the same
    // way. Token prepared outside the transaction (Web Crypto is external
    // async work, same rule as provisionSubscriber).
    const licenseHash = storageKey.slice(LICENSE_PREFIX.length);
    const label = `relay_${licenseHash}`;
    const token = randomToken("cyrano_relay");
    const tokenHash = await sha256Hex(token);
    const freshUserId = crypto.randomUUID();

    const result = await this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<LicenseRecord>(storageKey);
      if (!record) return { status: 404, reason: "unknown license key" } as const;
      if (record.revoked_at) return { status: 410, reason: "license revoked" } as const;
      if (!record.device_id || record.device_id !== deviceId) {
        return { status: 403, reason: "license not activated on this device" } as const;
      }

      const existing = await txn.get<StoredUser>(RegistryDO.userKey(label));
      const user: StoredUser = existing
        ? { ...existing, hash: tokenHash, plan: RELAY_PLAN }
        : { userId: freshUserId, label, hash: tokenHash, createdAt: Date.now(), plan: RELAY_PLAN };

      // Rotation kills the old secret; a severed (deactivated) identity has no
      // hash index at all — either way, write the new one fresh.
      if (existing) await txn.delete(`${USER_HASH_INDEX_PREFIX}${existing.hash}`);
      await txn.put(RegistryDO.userKey(label), user);
      await txn.put(`${USER_ID_INDEX_PREFIX}${user.userId}`, label);
      await txn.put(`${USER_HASH_INDEX_PREFIX}${user.hash}`, label);
      if (record.relay_user_id !== user.userId) {
        await txn.put(storageKey, { ...record, relay_user_id: user.userId });
      }
      return { status: 200, userId: user.userId, rotated: Boolean(existing) } as const;
    });

    if (result.status !== 200) {
      return Response.json({ valid: false, reason: result.reason }, { status: result.status });
    }
    return Response.json({ valid: true, token, user_id: result.userId, rotated: result.rotated });
  }

  /**
   * Kill a license's relay token without destroying the identity: the hash
   * index is the only path a bearer token resolves through (`/_validate_user`),
   * so deleting it makes the token inert immediately, while the user record
   * and id index survive — session ownership and any future re-arm keep the
   * same `userId`. Called by `deactivateLicense`; a future revocation route
   * (refund/chargeback sets `revoked_at`) must call this too.
   */
  private async invalidateRelayCredential(record: LicenseRecord): Promise<void> {
    if (!record.relay_user_id) return;
    const user = await this.findUserEntry(record.relay_user_id);
    if (!user || user.plan !== RELAY_PLAN) return;
    await this.ctx.storage.delete(`${USER_HASH_INDEX_PREFIX}${user.hash}`);
  }

  // ---- free cold relay ----

  /** New free-cold identities minted per UTC day, across all devices. A junk
   * backstop, not a meter: real adoption is one mint per device EVER (re-enroll
   * rotates the same identity and doesn't count), so this cap only bites a
   * script minting identities in bulk to grow snapshot storage. */
  private static readonly FREE_COLD_MINTS_PER_DAY = 2000;

  /**
   * Exchange a device id for a `free-cold` tenant identity + token
   * (free-cold relay contract). The label is derived from the device-id
   * hash, so the device is the idempotency key — the same device re-enrolling
   * ROTATES its token (recovers a lost one, kills the old one) rather than
   * minting a second identity, exactly the `relayTokenForLicense` shape. The
   * token authorizes only connector pairing and snapshot push; every other
   * route refuses the plan (router allowlist + RELAY_ONLY_PLANS).
   */
  private async enrollFreeCold(request: Request): Promise<Response> {
    const b = (await request.json().catch(() => ({}))) as { device_id?: string };
    const deviceId = b.device_id?.trim();
    // A UUID-shaped floor keeps junk ("x", empty, a megabyte of noise) from
    // becoming storage keys; real callers send UUID().uuidString (122 random
    // bits — see FreeColdRelay.swift:80).
    if (!deviceId || deviceId.length < 16 || deviceId.length > 128) {
      return Response.json({ valid: false, reason: "missing or malformed device_id" }, { status: 400 });
    }

    const deviceHash = await sha256Hex(deviceId);
    const label = `freecold_${deviceHash}`;
    const token = randomToken("cyrano_freecold");
    const tokenHash = await sha256Hex(token);
    const freshUserId = crypto.randomUUID();
    const dayKey = `freecold-mints:${utcDayBucket(Date.now())}`;

    const result = await this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<StoredUser>(RegistryDO.userKey(label));
      if (!existing) {
        // Only a FIRST mint counts against the daily backstop; rotation is the
        // legitimate steady state and must never be capacity-refused.
        const minted = (await txn.get<number>(dayKey)) ?? 0;
        if (minted >= RegistryDO.FREE_COLD_MINTS_PER_DAY) {
          return { status: 429, reason: "enrollment capacity reached — try again tomorrow" } as const;
        }
        await txn.put(dayKey, minted + 1);
      }
      const user: StoredUser = existing
        ? { ...existing, hash: tokenHash, plan: FREE_COLD_PLAN }
        : { userId: freshUserId, label, hash: tokenHash, createdAt: Date.now(), plan: FREE_COLD_PLAN };

      if (existing) await txn.delete(`${USER_HASH_INDEX_PREFIX}${existing.hash}`);
      await txn.put(RegistryDO.userKey(label), user);
      await txn.put(`${USER_ID_INDEX_PREFIX}${user.userId}`, label);
      await txn.put(`${USER_HASH_INDEX_PREFIX}${user.hash}`, label);
      return { status: 200, userId: user.userId, rotated: Boolean(existing) } as const;
    });

    if (result.status !== 200) {
      return Response.json({ valid: false, reason: result.reason }, { status: result.status });
    }
    return Response.json({ valid: true, token, user_id: result.userId, rotated: result.rotated });
  }

  // ---- free trial ----
  //
  // Request/response shapes preserve the established client contract so the
  // Swift TrialManager port speaks to both identically. State is server-owned and
  // keyed by the hash of the client's hardware fingerprint; the client only ever
  // holds a signed, verifiable snapshot of it.

  private async trialStorageKey(fingerprint: string): Promise<string> {
    return `${TRIAL_PREFIX}${await sha256Hex(fingerprint.trim())}`;
  }

  /** Mint an Ed25519-signed token for a fingerprint's (immutable) expiresAt. */
  private async buildTrialToken(
    fingerprint: string,
    expiresAt: string,
  ): Promise<{ token: string; expiresAt: string; heartbeatBy: string }> {
    const nowMs = Date.now();
    const heartbeatBy = new Date(nowMs + HEARTBEAT_GRACE_HOURS * 3600 * 1000).toISOString();
    const token = await signTrialToken(this.env, {
      fingerprint,
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt,
      heartbeatBy,
      nonce: crypto.randomUUID(),
    });
    return { token, expiresAt, heartbeatBy };
  }

  /**
   * Start (or re-issue) a trial for a fingerprint. Issues a fresh 3-day trial
   * IFF this fingerprint has never started one; otherwise re-issues a token for
   * the EXISTING expiresAt (so a reinstall mid-trial doesn't lock the user out)
   * — but never extends it, and refuses outright once revoked. Once-per-machine.
   */
  private async startTrial(request: Request): Promise<Response> {
    if (!trialSigningConfigured(this.env)) {
      return Response.json({ ok: false, reason: "trials unavailable" }, { status: 503 });
    }
    const b = (await request.json().catch(() => ({}))) as {
      fingerprint?: string;
      device_name?: string;
      app_version?: string;
      platform?: string;
    };
    const fingerprint = b.fingerprint?.trim();
    const deviceName = b.device_name?.trim() || "unknown Mac";
    // The client fingerprint is a SHA-256 hex (64 chars); accept a small range
    // so a format tweak doesn't hard-break, but reject obviously-bogus input.
    if (!fingerprint || fingerprint.length < 32 || fingerprint.length > 128) {
      return Response.json({ ok: false, reason: "invalid fingerprint" }, { status: 400 });
    }

    const storageKey = await this.trialStorageKey(fingerprint);
    const existing = await this.ctx.storage.get<TrialRecord>(storageKey);
    if (existing) {
      if (existing.revoked_at) {
        return Response.json({ ok: false, reason: "revoked", expired: true }, { status: 410 });
      }
      await this.ctx.storage.put(storageKey, {
        ...existing,
        last_seen_at: new Date().toISOString(),
        ...this.adoptionFields(b),
      });
      const minted = await this.buildTrialToken(fingerprint, existing.expires_at);
      return Response.json({
        ok: true,
        token: minted.token,
        expires_at: minted.expiresAt,
        heartbeat_by: minted.heartbeatBy,
        heartbeat_interval_seconds: HEARTBEAT_INTERVAL_HOURS * 3600,
        already_started: true,
      });
    }

    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + TRIAL_DAYS * 24 * 3600 * 1000).toISOString();
    const record: TrialRecord = {
      fingerprint,
      device_name: deviceName,
      started_at: startedAt.toISOString(),
      expires_at: expiresAt,
      last_seen_at: startedAt.toISOString(),
      revoked_at: null,
      ...this.adoptionFields(b),
    };
    await this.ctx.storage.put(storageKey, record);
    const minted = await this.buildTrialToken(fingerprint, expiresAt);
    return Response.json({
      ok: true,
      token: minted.token,
      expires_at: minted.expiresAt,
      heartbeat_by: minted.heartbeatBy,
      heartbeat_interval_seconds: HEARTBEAT_INTERVAL_HOURS * 3600,
      already_started: false,
    });
  }

  /**
   * Refresh the token if the trial is still alive. The client calls this hourly;
   * it proves reachability (feeding the client's offline-grace clock) but never
   * extends the trial — the server always returns the original, immutable
   * expiresAt. Past expiry it returns `{expired:true}` and the client locks Pro.
   */
  private async heartbeatTrial(request: Request): Promise<Response> {
    if (!trialSigningConfigured(this.env)) {
      return Response.json({ ok: false, reason: "trials unavailable" }, { status: 503 });
    }
    const b = (await request.json().catch(() => ({}))) as {
      fingerprint?: string;
      app_version?: string;
      platform?: string;
    };
    const fingerprint = b.fingerprint?.trim();
    if (!fingerprint) {
      return Response.json({ ok: false, reason: "missing fingerprint" }, { status: 400 });
    }
    const storageKey = await this.trialStorageKey(fingerprint);
    const record = await this.ctx.storage.get<TrialRecord>(storageKey);
    if (!record) {
      return Response.json({ ok: false, reason: "no trial started" }, { status: 404 });
    }
    if (record.revoked_at) {
      return Response.json({ ok: false, reason: "revoked", expired: true }, { status: 410 });
    }
    if (Date.now() >= Date.parse(record.expires_at)) {
      return Response.json({ ok: false, expired: true, expires_at: record.expires_at });
    }
    await this.ctx.storage.put(storageKey, {
      ...record,
      last_seen_at: new Date().toISOString(),
      ...this.adoptionFields(b),
    });
    const minted = await this.buildTrialToken(fingerprint, record.expires_at);
    return Response.json({
      ok: true,
      token: minted.token,
      expires_at: minted.expiresAt,
      heartbeat_by: minted.heartbeatBy,
      heartbeat_interval_seconds: HEARTBEAT_INTERVAL_HOURS * 3600,
    });
  }

  // ---- release adoption (adoption.ts) ----

  /**
   * Device counts per shipped version, read off the license and trial records
   * that already exist. Operator-only upstream; internal-only here.
   *
   * Reads every license and trial record, so it is a scan — fine at this scale
   * (thousands), and it is an operator command run by hand, not a hot path. If
   * the record count ever makes that untrue, the fix is a rolled-up counter
   * written on each check-in, not a cached scan.
   */
  private async adoptionStats(url: URL): Promise<Response> {
    const requested = Number.parseInt(url.searchParams.get("days") ?? "", 10);
    const windowDays = Number.isFinite(requested) ? requested : 30;

    const sightings: AdoptionSighting[] = [];
    for (const record of await this.listAll<LicenseRecord>(LICENSE_PREFIX)) {
      // An unbound key is a purchase, not a running install — activate() is
      // what makes it a device, and deactivate() takes it back out.
      if (!record.device_id) continue;
      sightings.push({
        version: record.app_version,
        platform: record.platform,
        lastSeenAt: record.last_seen_at,
        source: "license",
      });
    }
    for (const record of await this.listAll<TrialRecord>(TRIAL_PREFIX)) {
      sightings.push({
        version: record.app_version,
        platform: record.platform,
        lastSeenAt: record.last_seen_at,
        source: "trial",
      });
    }

    return Response.json(summarizeAdoption(sightings, { now: Date.now(), windowDays }));
  }

  // ---- per-subject cost report (costs.ts) ----

  /**
   * Every subject with what they cost us, ranked, with the provider+model
   * breakdown, the purchase record already on their user record, and a device
   * count where licensing keeps one. Operator-only upstream; internal-only here.
   *
   * THE BOUND, AND WHAT HAPPENS PAST IT. Unlike `/_adoption` this deliberately
   * does NOT scan everything: the user space is unbounded and grows with every
   * subscriber, and a report that must load all of it to rank it fails exactly
   * when it starts to matter. One request reads at most `scan` user records
   * (default {@link DEFAULT_COST_SCAN}, hard cap {@link MAX_COST_SCAN}) in
   * 1000-key pages, holds at most 2x`limit` rows in memory
   * ({@link createCostCollector}), and performs at most `limit` extra
   * point-reads for device linkage — never a second full scan of the license
   * space. When the scan stops on its bound rather than on the end of the
   * registry, the reply carries `truncated: true` and a `next_cursor` (the last
   * storage key read); callers can walk it and re-rank the
   * merged pages, which reproduces the exact global ranking because a globally
   * top-N subject is necessarily in its own page's top-N.
   *
   * Totals cover every record SCANNED, not the rows returned, so "what does
   * this cohort cost" is not silently "what do the top 50 cost".
   */
  private async costReport(url: URL): Promise<Response> {
    const limit = clampCostParam(url.searchParams.get("limit"), DEFAULT_COST_ROWS, MAX_COST_ROWS);
    const scanLimit = clampCostParam(url.searchParams.get("scan"), DEFAULT_COST_SCAN, MAX_COST_SCAN);
    const cursor = url.searchParams.get("cursor") || undefined;
    const now = Date.now();

    const collector = createCostCollector({
      now,
      limit,
      revenueUsdPerMonth: planRevenueFromEnv(this.env),
      ceilingMicros: USER_SAFETY_CEILING_MICROS,
      // Left undefined so a free-cold identity self-reports its one device and
      // a license identity stays null until the point-read below.
      devices: undefined,
    });

    const PAGE = 1000;
    let startAfter = cursor;
    let remaining = scanLimit;
    let scanned = 0;
    let exhausted = false;
    while (remaining > 0) {
      const want = Math.min(PAGE, remaining);
      const page = await this.ctx.storage.list<StoredUser>({
        prefix: USER_PREFIX,
        limit: want,
        ...(startAfter ? { startAfter } : {}),
      });
      for (const [key, user] of page) {
        collector.add(user);
        startAfter = key;
        scanned += 1;
      }
      remaining -= page.size;
      // A short page is the end of the prefix. A full one may or may not be, so
      // an exactly-exhausted budget still hands back a cursor: one extra empty
      // request is cheaper than under-reporting a cohort.
      if (page.size < want) {
        exhausted = true;
        break;
      }
    }

    const subjects = collector.rows();
    // Device linkage for the RETURNED rows only: at most `limit` point-reads,
    // and none at all for the subscribers (who have no device-bearing record
    // to join to — see costs.ts deviceJoinFor).
    for (const row of subjects) {
      const join = deviceJoinFor(row.label);
      if (join.kind !== "license") continue;
      const record = await this.ctx.storage.get<LicenseRecord>(`${LICENSE_PREFIX}${join.licenseHash}`);
      // A license with no device bound is a purchase, not an install — the same
      // rule adoptionStats applies. An unknown key (the identity outlived its
      // license) is 0 devices, not null: we looked, and there is none.
      row.devices = record?.device_id ? 1 : 0;
    }

    const report: CostReport = {
      generated_at: new Date(now).toISOString(),
      period_days: Math.round(USAGE_PERIOD_MS / 86_400_000),
      ceiling_micros: USER_SAFETY_CEILING_MICROS,
      scanned,
      returned: subjects.length,
      limit,
      scan_limit: scanLimit,
      truncated: !exhausted,
      next_cursor: exhausted ? null : (startAfter ?? null),
      totals: collector.totals,
      subjects,
    };
    return Response.json(report);
  }

  /** Every value under a prefix, paged. `storage.list` caps at 1000 entries per
   *  call, so the one-shot form silently truncates once a prefix outgrows that
   *  — which for a count is a wrong answer rather than an error. */
  private async listAll<T>(prefix: string): Promise<T[]> {
    const PAGE = 1000;
    const out: T[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.ctx.storage.list<T>({
        prefix,
        limit: PAGE,
        ...(startAfter ? { startAfter } : {}),
      });
      if (page.size === 0) break;
      for (const [key, value] of page) {
        out.push(value);
        startAfter = key;
      }
      if (page.size < PAGE) break;
    }
    return out;
  }

  // ---- bug reports (in-app Settings → Support; bugreport.ts) ----

  private async submitBugReport(request: Request): Promise<Response> {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return Response.json({ error: "too_large" }, { status: 413 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const report = sanitizeBugReport(parsed);
    if (!report) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }

    // Per-client daily cap. The client is the hashed connecting IP; the hash
    // lives only in today's counter bucket, never on the stored report, so the
    // queue holds nothing correlatable beyond what the user typed.
    const now = Date.now();
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const clientHash = (await sha256Hex(ip)).slice(0, 16);
    const rlKey = rateLimitKey(clientHash, now);
    const count = (await this.ctx.storage.get<number>(rlKey)) ?? 0;
    if (count >= RATE_LIMIT_PER_DAY) {
      return Response.json({ error: "rate_limited" }, { status: 429 });
    }
    await this.ctx.storage.put(rlKey, count + 1);

    // Opportunistic prune: counter buckets from previous days are dead weight.
    // Day-first key layout makes "not today" a single prefix comparison.
    const todayPrefix = `${RATE_LIMIT_PREFIX}${utcDayBucket(now)}:`;
    const buckets = await this.ctx.storage.list({ prefix: RATE_LIMIT_PREFIX });
    const stale = [...buckets.keys()].filter((key) => !key.startsWith(todayPrefix));
    if (stale.length > 0) {
      // delete() takes at most 128 keys per call.
      for (let i = 0; i < stale.length; i += 128) {
        await this.ctx.storage.delete(stale.slice(i, i + 128));
      }
    }

    const nonce = [...crypto.getRandomValues(new Uint8Array(4))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const storageKey = bugReportKey(now, nonce);
    const id = storageKey.slice(BUG_REPORT_PREFIX.length);
    await this.ctx.storage.put(storageKey, { id, createdAt: now, ...report });

    // Ring buffer: keys are chronological, so capping is delete-from-the-front.
    const all = await this.ctx.storage.list({ prefix: BUG_REPORT_PREFIX });
    if (all.size > MAX_STORED_REPORTS) {
      const excess = [...all.keys()].slice(0, all.size - MAX_STORED_REPORTS);
      await this.ctx.storage.delete(excess);
    }

    return Response.json({ ok: true, id });
  }

  private async listBugReports(url: URL): Promise<Response> {
    const limitParam = Number(url.searchParams.get("limit"));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), MAX_STORED_REPORTS)
        : 200;
    const stored = await this.ctx.storage.list<SanitizedBugReport & { id: string; createdAt: number }>({
      prefix: BUG_REPORT_PREFIX,
      reverse: true,
      limit,
    });
    return Response.json({ reports: [...stored.values()] });
  }

  private async deleteBugReport(id: string): Promise<Response> {
    if (!/^[0-9]+-[0-9a-f]+$/.test(id)) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const deleted = await this.ctx.storage.delete(`${BUG_REPORT_PREFIX}${id}`);
    return Response.json({ ok: true, deleted });
  }
}

export const chatGPTRegistryTesting = {
  base64URL,
  decodeBase64URL,
  hmacBase64URL,
  constantTimeEqual,
  randomPairingCode,
  chatGPTPairingFailure,
  pairTombstoneTTLMs: CHATGPT_PAIR_TOMBSTONE_TTL_MS,
};

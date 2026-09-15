// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Two credential kinds share this file:
//   - The operator's AUTH_TOKEN — the deployer's own secret, full access to
//     every session on this Worker. This is the entire auth model for the
//     single-tenant self-host case and is UNCHANGED
//     from the prototype: same secret, same behavior, same shared bearer.
//   - Tenant tokens (added 2026-07-13) — minted by the operator for a
//     specific end user, when an operator wants to host Cyrano for more
//     than just themselves. A tenant token resolves to a stable `userId`
//     that SessionMeta.owner_user_id gets checked against (see
//     session-do.ts) — the operator's own AUTH_TOKEN still bypasses that
//     check, same as a superuser/debug credential always has.
// See DECISIONS.md for why this is additive, not a replacement: an existing
// self-host deployment with only AUTH_TOKEN set keeps working identically —
// nobody sends a tenant token, so `Identity.kind` is always "operator" and
// every ownership check short-circuits to "allowed", exactly like today.

import type { Env } from "./env.js";

export type Identity =
  | { kind: "operator" }
  | {
      kind: "user";
      userId: string;
      /** The tenant's plan, when the registry knows one — rides along from
       * `_validate_user` so the router can scope narrow plans (free-cold's
       * allowlist) without a second registry
       * round-trip. Router-side only: `encodeIdentity` deliberately drops it,
       * so a DO that cares about plan still asks `_entitlement` — one
       * authority, not a cached copy that can drift. */
      plan?: string;
    };

/**
 * An authenticated agent key. More than one agent can hold a key to the same
 * account, and they all poll the same `/agent/latest` — so a request needs to
 * carry not just WHOSE key it is (the identity) but WHICH key, and what that
 * key is allowed to read.
 */
export type AgentAuth = {
  identity: Identity;
  /** The key's label: its name in Settings, and the address a directed
   * question can be aimed at. */
  label: string;
  /** False only when the user turned this key's context read off. */
  receivesContext: boolean;
};

/** Marker embedded in the URL when index.ts forwards an already-authorized
 * request to a Durable Object stub. Only index.ts ever sets this — Durable
 * Objects are reachable solely via their binding, never directly from the
 * public Internet, so a raw request can't forge this parameter into
 * existence; there is no path from an external HTTP request to a DO that
 * skips index.ts's fetch handler. */
const IDENTITY_QUERY_PARAM = "_identity";

/** Which agent key a forwarded request came in on, attached by index.ts the
 * same way (and with the same trust argument) as the identity marker. Lets a
 * DO answer "is this the agent that question was addressed to?". */
const AGENT_LABEL_QUERY_PARAM = "_agent";

export function encodeIdentity(identity: Identity): string {
  return identity.kind === "operator" ? "operator" : `user:${identity.userId}`;
}

function decodeIdentity(raw: string | null): Identity {
  if (raw === "operator" || raw === null) return { kind: "operator" };
  const match = raw.match(/^user:(.+)$/);
  return match ? { kind: "user", userId: match[1]! } : { kind: "operator" };
}

/** Reads the identity index.ts attached to a request forwarded to a DO. */
export function identityFromUrl(url: URL): Identity {
  return decodeIdentity(url.searchParams.get(IDENTITY_QUERY_PARAM));
}

/**
 * Clones `request` with the identity query param set, preserving method,
 * headers, and body via the Request-as-init constructor form — the same
 * shape already used for the `/agent/latest/...` forwarding below, just
 * changing the URL instead of the path.
 */
export function forwardWithIdentity(request: Request, identity: Identity): Request {
  const url = new URL(request.url);
  url.searchParams.set(IDENTITY_QUERY_PARAM, encodeIdentity(identity));
  // A client credential is not an agent key: drop any `_agent` the caller
  // put in its own URL so the DO can't be told a request came in on one.
  url.searchParams.delete(AGENT_LABEL_QUERY_PARAM);
  return new Request(url, request);
}

/** `forwardWithIdentity` plus which agent key the request arrived on. */
export function forwardWithAgent(request: Request, auth: AgentAuth): Request {
  const url = new URL(request.url);
  url.searchParams.set(IDENTITY_QUERY_PARAM, encodeIdentity(auth.identity));
  url.searchParams.set(AGENT_LABEL_QUERY_PARAM, auth.label);
  return new Request(url, request);
}

/** Reads the agent key label index.ts attached to a forwarded request. Null
 * for a request that didn't come in on an agent key. */
export function agentLabelFromUrl(url: URL): string | null {
  return url.searchParams.get(AGENT_LABEL_QUERY_PARAM);
}

function bearerToken(request: Request): string | null {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer (.+)$/);
  return match?.[1] ?? null;
}

/** True if `meta`'s owner (if any) doesn't conflict with `identity` — the
 * one rule every session-scoped request is gated by.
 *
 * Three owner states:
 *  - a tenant owner (`ownerUserId` set): that tenant or the operator;
 *  - operator-owned (`operatorOwned`, stamped since 2026-09-14 on sessions
 *    created under AUTH_TOKEN): the operator only. On a hosted deployment
 *    the operator's own live sessions are exactly the ones a paying tenant
 *    must never reach, and before this flag they were reachable by any
 *    tenant who learned the session id;
 *  - neither (a session stored before the flag existed): open to anyone who
 *    already cleared resolveIdentity, exactly as before tenant users existed.
 *    A self-host deployment has no tenants, so this is unchanged for it. */
export function sessionAccessAllowed(
  identity: Identity,
  ownerUserId: string | undefined,
  operatorOwned = false,
): boolean {
  if (identity.kind === "operator") return true;
  if (operatorOwned) return false;
  if (!ownerUserId) return true;
  return identity.userId === ownerUserId;
}

/**
 * Resolves a request's bearer token to an Identity: the operator's own
 * AUTH_TOKEN first (cheap, no DO round trip), then a tenant token via the
 * registry. Returns null when neither matches.
 */
export async function resolveIdentity(request: Request, env: Env): Promise<Identity | null> {
  const token = bearerToken(request);
  if (!token) return null;
  if (timingSafeEqual(token, env.AUTH_TOKEN)) return { kind: "operator" };

  const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
  const res = await registry.fetch("https://registry/_validate_user", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { valid: boolean; userId?: string; plan?: string };
  return body.valid && body.userId
    ? { kind: "user", userId: body.userId, ...(body.plan ? { plan: body.plan } : {}) }
    : null;
}

/**
 * Agent routes (`/agent/...`) accept a separate, revocable "agent key"
 * instead of the app's own AUTH_TOKEN — see RegistryDO. Validated by asking
 * the registry singleton, since only it holds the key hashes.
 */
export async function isAuthorizedAgent(request: Request, env: Env): Promise<boolean> {
  return (await resolveAgentAuth(request, env)) !== null;
}

/**
 * Like isAuthorizedAgent, but also returns which key this is and the identity
 * it should act as for session-ownership purposes: the tenant who minted it,
 * or "operator" for keys minted with no owner (unscoped — the pre-tenancy
 * default, and what every key minted on a single-tenant self-host still is).
 *
 * Validating is also what stamps the key's last-seen (registry side), so this
 * call is what makes a running agent visible to the app that connected it.
 */
export async function resolveAgentAuth(request: Request, env: Env): Promise<AgentAuth | null> {
  const key = bearerToken(request);
  if (!key) return null;

  const stub = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
  const res = await stub.fetch("https://registry/_validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    valid: boolean;
    label?: string;
    ownerUserId?: string;
    receivesContext?: boolean;
  };
  if (!body.valid) return null;
  return {
    identity: body.ownerUserId ? { kind: "user", userId: body.ownerUserId } : { kind: "operator" },
    label: body.label ?? "",
    receivesContext: body.receivesContext !== false,
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

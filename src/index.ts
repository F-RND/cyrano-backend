// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import type { Env } from "./env.js";
import type { Identity } from "./auth.js";
import { forwardWithAgent, forwardWithIdentity, resolveAgentAuth, resolveIdentity } from "./auth.js";
import { pingLlm, type LlmConfig } from "./llm/client.js";
import { resolveAnalysisLlmConfig, resolveStatelessLlmConfig } from "./llm/hosted-config.js";
import { createSpendLedger, isEmptyDelta, spendDeltaToWire } from "./llm/spend.js";
import { pricingOptionsFromEnv } from "./llm/pricing.js";
import type { UsageDelta } from "./usage.js";
import { FREE_COLD_PLAN, sessionAnalysisAccess } from "./entitlement.js";
import {
  MAX_REANALYZE_CHARS,
  MAX_REANALYZE_LINES,
  reanalyzeCharCount,
  reanalyzeTranscript,
  sanitizeReanalyzeLines,
} from "./analysis/reanalyze.js";
import { generateDictationPolish, sanitizeModes } from "./analysis/dictation-polish.js";
import {
  answerQuestion,
  MAX_ASK_CONTEXT_BYTES,
  MAX_ASK_QUESTION_BYTES,
  type AskScope,
} from "./analysis/ask.js";
import {
  byteLength,
  generateDayContextRefine,
  sanitizeScope,
  MAX_REFINE_INPUT_BYTES,
} from "./analysis/context-refine.js";
import { handleActivated, handleBuy, handleStripeWebhook } from "./stripe.js";
import { handleAppStoreLink, handleAppStoreNotifications } from "./appstore.js";
import {
  handleChatGPTManagementRequest,
  handleChatGPTPublicRequest,
} from "./chatgpt-mcp.js";

export { SessionDO } from "./session-do.js";
export { RegistryDO } from "./registry-do.js";
export { AccountInboxDO } from "./account-inbox-do.js";

/** The account-inbox DO instance name for an identity (account-inbox contract,
 * Phase 3): a tenant/relay account gets its own inbox by userId; an operator /
 * self-host deployment has a single account, so both the agent push and the
 * client stream meet at one fixed "operator" inbox. */
// Moved to ./inbox-key.ts (2026-08-04) so the remote MCP surface can derive the
// same key for origin-pull without importing the router. Re-exported here
// because both the existing call sites below and account-inbox.test.ts import
// it from this module.
import { inboxKeyFor } from "./inbox-key.js";
export { inboxKeyFor };

/** How long a presence stamp keeps
 * the agent warm after the user's last "I'm active" ping. The client re-pings on
 * foreground (throttled ~60s), so this stays fresh while the app is up front and
 * lapses a few minutes after it's backgrounded — at which point the agent is
 * free to back off again. */
export const PRESENCE_WARM_WINDOW_MS = 5 * 60 * 1000;

/** Decide what a session-less `/agent/latest` poll should return given the
 * account's last presence stamp.
 * A recent stamp yields a warm-up hint the agent stays awake on; a stale or
 * absent one yields null → the caller 404s exactly as it did before presence
 * existed. Pure so the window logic is unit-tested without a DO. */
export function presenceWarmHint(
  presenceAt: number | null | undefined,
  now: number,
): { session_id: null; presence: "active"; since: number } | null {
  if (typeof presenceAt === "number" && now - presenceAt <= PRESENCE_WARM_WINDOW_MS) {
    return { session_id: null, presence: "active", since: presenceAt };
  }
  return null;
}

/**
 * The query string GET /costs forwards to the registry's internal `_costs`.
 *
 * An ALLOWLIST, and re-encoded rather than passed through: the caller's URL is
 * attacker-influenced input that is about to be concatenated into the URL of an
 * internal, unauthenticated-by-construction DO route, and `url.search` would
 * carry along anything at all — including a second `?`, a `#`, or a parameter a
 * future `_costs` learns to read. Three params exist and three params travel.
 * Values are clamped inside the DO (costs.ts clampCostParam), so junk here is
 * safe as well as bounded; `cursor` is length-capped because it is the only one
 * that is not a number.
 *
 * Exported so test/costs.test.ts can assert the allowlist directly — a route's
 * forwarding rule that can only be tested through a live DO is a rule nobody
 * tests.
 */
export function costsQuery(url: URL): string {
  const out = new URLSearchParams();
  for (const key of ["limit", "scan"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) out.set(key, value.slice(0, 16));
  }
  const cursor = url.searchParams.get("cursor");
  // A registry storage key: "user:" + a label. Labels are operator- or
  // provider-supplied and short; 512 is far above any real one and far below
  // anything worth forwarding.
  if (cursor !== null && cursor.length > 0) out.set("cursor", cursor.slice(0, 512));
  const query = out.toString();
  return query ? `?${query}` : "";
}

/** The only operations an agent key may perform, on either agent route form. */
export function isAllowedAgentOperation(request: Request, suffix: string): boolean {
  if (request.method === "GET" && suffix === "/context") return true;
  if (request.method === "POST" && suffix === "/results") return true;
  return false;
}

/** True when this operation is the live-context READ — the half of an agent
 * key a user can switch off per key ("this agent answers when I ask it, but
 * doesn't follow along"). Pushing results back stays available either way:
 * silencing a reader shouldn't silently drop work it already did. */
export function isAgentContextRead(request: Request, suffix: string): boolean {
  return request.method === "GET" && suffix === "/context";
}

/** What a key whose context read was switched off gets back. 403 with a named
 * reason, never an empty payload or a 404: an agent that reads "no session"
 * will keep polling forever and its operator will debug the wrong thing. */
function contextDisabledResponse(): Response {
  return Response.json(
    {
      error: "context_disabled",
      message:
        "This agent key is connected but not receiving context. Turn it back on in Cyrano under Settings → Connect an Agent.",
    },
    { status: 403 },
  );
}

/**
 * Report one request's LLM spend to the per-user, per-period meter.
 *
 * Four stateless routes (/dictation/polish, /context/refine, /analyze, /ask)
 * used to carry four copies of this block, each with its own running
 * `spendMicros` integer. They now share one ledger shape and one reporter,
 * because there are three things to send and not one: the total, the
 * provider+model breakdown that explains it (defect D3), and the count of calls
 * that ran on the caller's OWN key (defect D5 — zero of our dollars, but the
 * fact of them is what separates a cheap subject from a BYOK one).
 *
 * Rules preserved exactly from the four copies:
 *  - only a tenant identity meters (operator / self-host spend against their
 *    own account, never a per-user meter);
 *  - metering must never break the pass, so any registry hiccup drops the delta.
 * New: a BYOK-only delta (zero micros, non-zero calls) is still reported, which
 * is the whole point of D5. It cannot raise anyone's spend — `micros` is the
 * sum of the priced legs, and a BYOK call never produces one.
 */
async function reportSpend(env: Env, identity: Identity, delta: UsageDelta): Promise<void> {
  if (identity.kind !== "user") return;
  if (isEmptyDelta(delta)) return;
  try {
    const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
    await registry.fetch("https://registry/_usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: identity.userId, ...spendDeltaToWire(delta) }),
    });
  } catch {
    // ignore
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // ChatGPT's MCP client runs remotely: unlike Claude Desktop / Codex it
    // cannot spawn Cyrano's bundled stdio helper. Discovery, OAuth/PKCE, and
    // the OAuth-protected HTTPS MCP endpoint must therefore sit before the
    // app's ordinary bearer-token gate. Settings-facing pairing/revoke routes
    // remain behind that gate below.
    const chatGPTPublicResponse = await handleChatGPTPublicRequest(request, env);
    if (chatGPTPublicResponse) return chatGPTPublicResponse;

    // Stripe subscription funnel (paid hosted tier).
    // These are the ONLY routes reachable without a Cyrano bearer token, so
    // they sit ahead of resolveIdentity: /buy is a public checkout link,
    // /stripe/webhook is authenticated by Stripe's signature, and
    // /stripe/activated is authenticated by possession of a real, paid Stripe
    // Checkout Session id (verified against Stripe inside the handler).
    if (request.method === "GET" && url.pathname === "/buy") {
      return handleBuy(request, env);
    }
    if (request.method === "POST" && url.pathname === "/stripe/webhook") {
      return handleStripeWebhook(request, env);
    }
    if (request.method === "GET" && url.pathname === "/stripe/activated") {
      return handleActivated(request, env);
    }

    // App Store subscriptions for the same hosted tier (appstore.ts). Token-less
    // for the same reason the Stripe routes are: the signed transaction (or
    // Apple's signed notification) IS the credential, verified against Apple's
    // pinned root before anything is written. /link is what turns a StoreKit
    // purchase into a usable Pro+ — without it the subscription buys nothing.
    if (request.method === "POST" && url.pathname === "/appstore/link") {
      if (env.APP_STORE_ENABLED !== "true") {
        return new Response("app store integration disabled", { status: 503 });
      }
      return handleAppStoreLink(request, env);
    }
    if (request.method === "POST" && url.pathname === "/appstore/notifications") {
      if (env.APP_STORE_ENABLED !== "true") {
        return new Response("app store integration disabled", { status: 503 });
      }
      return handleAppStoreNotifications(request, env);
    }

    // Lifetime Pro license lifecycle. Token-less
    // like the Stripe routes and for the same reason: the credential IS the
    // license key + device id in the body, and a license grants nothing
    // server-side (it only flips the client's proUnlocked — Pro processing is
    // entirely on-device), so there is no tenant to authenticate. Forwarded to
    // the singleton registry's internal _license routes (unreachable directly).
    // The one exception to "grants nothing server-side" is /license/relay-token
    // Under the live-relay contract, an ACTIVE, device-bound license can be
    // exchanged for a `pro-relay` tenant token so a Pro user's live session
    // may opt into transiting the Worker for the agent loop — transit only,
    // never hosted analysis (SessionDO refuses LLM spend for that plan).
    if (
      request.method === "POST" &&
      (url.pathname === "/license/activate" ||
        url.pathname === "/license/validate" ||
        url.pathname === "/license/deactivate" ||
        url.pathname === "/license/relay-token")
    ) {
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      const inner = url.pathname.replace("/license/", "/_license/");
      return registry.fetch(new Request(`https://registry${inner}`, request));
    }

    // Free cold relay enrollment. Token-less
    // like /license/* and for the same reason: the credential is minted BY this
    // call. What it grants is deliberately almost nothing — connector pairing
    // and finished-session snapshot push, allowlisted below and refused
    // everywhere else — and minting is idempotent per device (re-enrolling
    // rotates the same identity's token) with a daily junk backstop in the
    // registry.
    if (request.method === "POST" && url.pathname === "/free-cold/enroll") {
      if (env.FREE_COLD_ENROLLMENT_ENABLED !== "true") {
        return new Response("free-cold enrollment disabled", { status: 503 });
      }
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      return registry.fetch(new Request("https://registry/_freecold/enroll", request));
    }

    // Free 3-day Pro trial lifecycle. Token-less for
    // the same reason as /license/*: the credential is the hardware fingerprint
    // in the body, and a trial grants nothing server-side (it only lets the
    // client flip proUnlocked — Pro processing is entirely on-device). Forwarded
    // to the singleton registry's internal _trial routes (unreachable directly).
    if (
      request.method === "POST" &&
      (url.pathname === "/trial/start" || url.pathname === "/trial/heartbeat")
    ) {
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      const inner = url.pathname.replace("/trial/", "/_trial/");
      return registry.fetch(new Request(`https://registry${inner}`, request));
    }

    // In-app bug reports (Settings → Support on both platforms). Token-less
    // like /license/* and for the same reason: the reporter may be a Free or
    // local-only user holding no backend credential, and a report grants
    // nothing server-side — it is a one-way note into the operator's queue.
    // Shape/size clamps live in bugreport.ts; the per-IP daily cap lives in
    // the registry (which reads CF-Connecting-IP off this forwarded request).
    if (request.method === "POST" && url.pathname === "/bug-report") {
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      return registry.fetch(new Request("https://registry/_bugreport", request));
    }

    // Agent-facing routes: a separate, revocable credential (not AUTH_TOKEN,
    // not a tenant's own bearer token) — see RegistryDO / DECISIONS.md for
    // why the integration is pull-then-push rather than Cyrano calling an
    // agent directly.
    const agentMatch = url.pathname.match(/^\/agent\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (agentMatch) {
      const agentAuth = await resolveAgentAuth(request, env);
      if (!agentAuth) {
        return new Response("unauthorized", { status: 401 });
      }
      // Agent keys are pull/push credentials, nothing more. The DO's own
      // fetch() dispatches on method + path suffix with no notion of which
      // credential got the request there — without this allowlist an agent
      // key could hit /review (the FULL transcript), DELETE (purge any
      // session), /redact, or upgrade a WebSocket and inject transcript
      // segments and whispers.
      const suffix = agentMatch[2] ?? "";
      if (!isAllowedAgentOperation(request, suffix)) {
        return new Response("forbidden", { status: 403 });
      }
      if (isAgentContextRead(request, suffix) && !agentAuth.receivesContext) {
        return contextDisabledResponse();
      }
      const sessionId = agentMatch[1]!;
      const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
      return stub.fetch(forwardWithAgent(request, agentAuth));
    }

    // /agent/latest/... — stable URL, resolves to whichever session most
    // recently said `hello` UNDER THE SAME IDENTITY as this agent key (a
    // tenant's key only ever resolves to that tenant's own latest session;
    // an unscoped/operator key keeps resolving the single global pointer,
    // identical to before tenant users existed).
    const agentLatestMatch = url.pathname.match(/^\/agent\/latest(\/.*)?$/);
    if (agentLatestMatch) {
      const agentAuth = await resolveAgentAuth(request, env);
      if (!agentAuth) {
        return new Response("unauthorized", { status: 401 });
      }
      const agentIdentity = agentAuth.identity;
      // Checked before the latest-session lookup so a muted key learns why it
      // is getting nothing, rather than a 404 it reads as "no session".
      if (isAgentContextRead(request, agentLatestMatch[1] ?? "/context") && !agentAuth.receivesContext) {
        return contextDisabledResponse();
      }
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      const latestUrl = new URL("https://registry/_latest");
      if (agentIdentity.kind === "user") latestUrl.searchParams.set("owner_user_id", agentIdentity.userId);
      const latestRes = await registry.fetch(latestUrl);
      const latest = (await latestRes.json()) as { session_id: string | null; presence_at?: number | null };
      if (!latest.session_id) {
        // No live session — but if the user's app said "I'm active" recently
        // (the presence contract), tell the agent so it can
        // stay warm/pre-connect instead of 404-backing-off. A stale or absent
        // presence stamp still 404s exactly as before, so an idle-forever agent
        // is unaffected. This response is a hint, not a session: it carries no
        // context and the agent should keep polling.
        const warm = presenceWarmHint(latest.presence_at, Date.now());
        if (warm) return Response.json(warm);
        return Response.json({ error: "no_active_session" }, { status: 404 });
      }
      const suffix = agentLatestMatch[1] ?? "/context";
      if (!isAllowedAgentOperation(request, suffix)) {
        return new Response("forbidden", { status: 403 });
      }
      const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(latest.session_id));
      const forwardUrl = new URL(`/agent/sessions/${latest.session_id}${suffix}`, url);
      // Carry the query string through — pathname matching above drops it,
      // and the context endpoint's ?wait_ms= long-poll rides on it.
      forwardUrl.search = url.search;
      return stub.fetch(forwardWithAgent(new Request(forwardUrl, request), agentAuth));
    }

    // POST /agent/inbox — a connected agent pings the user proactively, no
    // session required. Authenticated
    // by an agent key; the ping targets THAT key's account inbox, so a tenant's
    // agent can only ever reach its own owner. Body: { text, tier?, url?, id? }.
    if (request.method === "POST" && url.pathname === "/agent/inbox") {
      const agentAuth = await resolveAgentAuth(request, env);
      if (!agentAuth) {
        return new Response("unauthorized", { status: 401 });
      }
      const inbox = env.ACCOUNT_INBOX_DO.get(
        env.ACCOUNT_INBOX_DO.idFromName(inboxKeyFor(agentAuth.identity)),
      );
      const pushUrl = new URL("https://inbox/push");
      return inbox.fetch(new Request(pushUrl, request));
    }

    // GET /account/inbox — the idle client holds this WebSocket open to receive
    // proactive pings for its own account (account-inbox contract,
    // Phase 3). Authenticated by the client's own worker credential (bearer or
    // relay token); it can only ever reach its own inbox.
    if (url.pathname === "/account/inbox") {
      const clientIdentity = await resolveIdentity(request, env);
      if (!clientIdentity) {
        return new Response("unauthorized", { status: 401 });
      }
      // A free-cold identity pushes snapshots over HTTP and never holds a
      // socket — refusing here keeps a leaked token from parking WebSockets.
      if (clientIdentity.kind === "user" && clientIdentity.plan === FREE_COLD_PLAN) {
        return Response.json({ error: "free_cold_scope" }, { status: 403 });
      }
      const inbox = env.ACCOUNT_INBOX_DO.get(
        env.ACCOUNT_INBOX_DO.idFromName(inboxKeyFor(clientIdentity)),
      );
      const streamUrl = new URL("https://inbox/stream", url);
      return inbox.fetch(new Request(streamUrl, request));
    }

    const identity = await resolveIdentity(request, env);

    // POST /presence — the client says "my app is active" when an agent is
    // reachable. Recorded per account
    // in RegistryDO and read back by the agent through /agent/latest so it can
    // warm up before the first idle question, collapsing the poll-backoff gap.
    // Authenticated by the caller's own worker credential; only ever stamps
    // their own account. No body, no content — a bare presence timestamp.
    if (request.method === "POST" && url.pathname === "/presence") {
      if (!identity) return new Response("unauthorized", { status: 401 });
      const stub = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      const innerUrl = new URL("https://registry/_presence");
      return stub.fetch(
        new Request(innerUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(identity.kind === "user" ? { owner_user_id: identity.userId } : {}),
        }),
      );
    }

    // Settings "Test connection" probe. Any resolved identity (operator or
    // tenant) may call it. GET tests the operator's own env.LLM_API_KEY (the
    // single-tenant self-host case); POST with {llm_api_key} in the body
    // tests a client-supplied key instead (the multi-tenant case, where each
    // person's own Anthropic key never touches the Worker's secrets at all).
    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/health/llm") {
      if (!identity) return new Response("unauthorized", { status: 401 });
      let clientKey: string | undefined;
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { llm_api_key?: string };
        clientKey = body.llm_api_key;
      }
      // The probe spends OUR key unless the caller supplied one, so it is
      // metered like every other our-key call site (~$0.00002 a call, but the
      // objective says every dollar is attributed to a subject, and this was
      // the last unmetered our-key egress in the Worker). A client-supplied key
      // is counted as BYOK: zero of our dollars, still a fact.
      const probeLedger = createSpendLedger(pricingOptionsFromEnv(env));
      const probe = await pingLlm({
        baseUrl: env.LLM_BASE_URL,
        apiKey: clientKey || env.LLM_API_KEY,
        model: env.LLM_MODEL,
        onUsage: (usage, leg) => {
          if (clientKey) probeLedger.recordByok();
          else probeLedger.recordServed(usage, leg);
        },
      });
      await reportSpend(env, identity, probeLedger.take());
      if (probe.ok) {
        return Response.json({ ok: true, model: env.LLM_MODEL });
      }
      return Response.json({
        ok: false,
        error: probe.kind === "auth" ? "llm_auth_error" : "llm_error",
        status: probe.status ?? null,
        message: probe.message,
      });
    }

    if (!identity) {
      return new Response("unauthorized", { status: 401 });
    }

    // Free cold relay: a `free-cold` identity
    // exists ONLY to pair remote assistants and push finished-session
    // snapshots. An ALLOWLIST, not per-route refusals, so a route added next
    // month is closed to this plan by default rather than open by omission.
    if (identity.kind === "user" && identity.plan === FREE_COLD_PLAN) {
      const allowed =
        url.pathname.startsWith("/free-cold/") ||
        url.pathname.startsWith("/chatgpt/") ||
        url.pathname.startsWith("/connector/");
      if (!allowed) {
        return Response.json(
          {
            error: "free_cold_scope",
            detail:
              "This credential only pairs remote assistants and uploads finished sessions for cold reads.",
          },
          { status: 403 },
        );
      }
    }

    // POST /free-cold/session — a phone pushes one finished session's curated
    // snapshot to its own account inbox so an assistant can read it once cold.
    // DELETE /free-cold/session/:id and /free-cold/sessions drop the copies —
    // the revocation half every narrowing (delete, hide, opt-out) calls.
    if (url.pathname.startsWith("/free-cold/session")) {
      if (identity.kind !== "user" || identity.plan !== FREE_COLD_PLAN) {
        return Response.json({ error: "free_cold_only" }, { status: 403 });
      }
      const inbox = env.ACCOUNT_INBOX_DO.get(
        env.ACCOUNT_INBOX_DO.idFromName(inboxKeyFor(identity)),
      );
      if (request.method === "POST" && url.pathname === "/free-cold/session") {
        return inbox.fetch(new Request("https://inbox/snap", request));
      }
      if (request.method === "DELETE" && url.pathname === "/free-cold/sessions") {
        return inbox.fetch(
          new Request("https://inbox/snap-delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ all: true }),
          }),
        );
      }
      const deleteMatch = url.pathname.match(/^\/free-cold\/session\/([A-Za-z0-9._:-]{1,64})$/);
      if (request.method === "DELETE" && deleteMatch) {
        return inbox.fetch(
          new Request("https://inbox/snap-delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: deleteMatch[1] }),
          }),
        );
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const chatGPTManagementResponse = await handleChatGPTManagementRequest(request, env, identity);
    if (chatGPTManagementResponse) return chatGPTManagementResponse;

    // Dictation polish. A stateless,
    // text-only cleanup pass for first-party dictation — NOT routed through a
    // Session DO (no session exists) and carrying NO audio. Any authed identity
    // may call it; a client may pass its own {llm_api_key} in-body (BYOK, like
    // /health/llm) or fall back to the operator key. The client races a
    // deadline against this and has its own deterministic floor, so a slow or
    // failed call degrades to raw client-side.
    if (request.method === "POST" && url.pathname === "/dictation/polish") {
      const body = (await request.json().catch(() => ({}))) as {
        text?: string;
        modes?: unknown;
        llm_api_key?: string;
      };
      const text = typeof body.text === "string" ? body.text : "";
      const modes = sanitizeModes(body.modes);
      if (text.trim().length === 0) {
        return Response.json({ polished_text: "" });
      }
      // Report OUR real-$ spend to the per-user meter, exactly like a session
      // tick — priced at whatever provider+model actually served each call, and
      // broken down by it. Only a tenant identity meters; operator/self-host
      // spend against their own account, and a BYOK call contributes zero
      // dollars (it is still counted, so BYOK stays visible as a fact).
      const ledger = createSpendLedger(pricingOptionsFromEnv(env));
      const { text: polished } = await generateDictationPolish(
        resolveStatelessLlmConfig(env, body.llm_api_key, ledger),
        text,
        modes,
      );
      await reportSpend(env, identity, ledger.take());
      return Response.json({ polished_text: polished });
    }

    // Day-context refinement. Structurally
    // the same animal as /dictation/polish: stateless, text-only, NOT routed
    // through a Session DO (no session exists), no audio, same auth, same
    // in-body BYOK escape hatch, same metering rule.
    //
    // NOTHING HERE IS RETAINED. The fragment and the revision are held only for
    // the life of this request — no logging of `text` or `revised_text`, no DO
    // storage, no analytics. A day document is the most concentrated artifact
    // Cyrano ever handles (a whole day's extractions in one payload), and the
    // in-app privacy claim in DataFlowView says exactly this. Do not add a log
    // line here.
    if (request.method === "POST" && url.pathname === "/context/refine") {
      const body = (await request.json().catch(() => null)) as {
        text?: string;
        instruction?: string;
        scope?: unknown;
        section_title?: string;
        llm_api_key?: string;
      } | null;
      if (!body || typeof body.text !== "string" || typeof body.instruction !== "string") {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      const text = body.text;
      const instruction = body.instruction;
      if (text.trim().length === 0 || instruction.trim().length === 0) {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      // Reject rather than truncate — see MAX_REFINE_INPUT_BYTES.
      if (byteLength(text) > MAX_REFINE_INPUT_BYTES) {
        return Response.json(
          { error: "too_large", max_bytes: MAX_REFINE_INPUT_BYTES },
          { status: 413 },
        );
      }

      const ledger = createSpendLedger(pricingOptionsFromEnv(env));
      let refined;
      try {
        // Same rule as /dictation/polish: BYOK resolves no fallback leg, and we
        // price the provider+model that served the block.
        refined = await generateDayContextRefine(
          resolveStatelessLlmConfig(env, body.llm_api_key, ledger),
          {
            text,
            instruction,
            scope: sanitizeScope(body.scope),
            sectionTitle: typeof body.section_title === "string" ? body.section_title : undefined,
          },
        );
      } catch {
        // An unusable result is an error, never a silent no-op: returning the
        // input unchanged would read as "the refinement worked and did
        // nothing". Deliberately unlike polish, which has a deterministic floor.
        //
        // Meter FIRST. A failed pass still burned tokens, and the comment below
        // has always said so, but the metering block sat after this `return` and
        // so never ran on the failure path — our own spend was silently
        // under-counted on exactly the calls most likely to be expensive (a
        // truncated or refused pass pays for every output token it produced).
        await reportSpend(env, identity, ledger.take());
        return Response.json({ error: "refine_failed" }, { status: 502 });
      }
      // A failed pass still burned tokens; meter what was actually spent, on the
      // same rule as polish (our key + a tenant identity only). Metering must
      // never break the pass, so any registry hiccup drops the delta.
      await reportSpend(env, identity, ledger.take());
      return Response.json({
        revised_text: refined.revisedText,
        changed: refined.changed,
        note: refined.note,
      });
    }

    // Full-transcript reanalysis ("Reanalyze with Copilot"). Structurally like
    // /context/refine — stateless, no Session DO, NOTHING RETAINED (the
    // transcript and results live only for this request; no logging of either)
    // — but it runs the SAME combined analysis pass live sessions do, windowed
    // over a stored transcript the device chose to send back. Because this
    // spends real LLM money on our key for hosted tenants, it applies the same
    // entitlement gate as a live session hello: a lapsed subscription or a
    // relay-only (pro-relay) identity is refused unless the call carries its
    // own BYOK key. Operator/self-host is never gated, same as live.
    if (request.method === "POST" && url.pathname === "/analyze") {
      const body = (await request.json().catch(() => null)) as {
        transcript?: unknown;
        llm_api_key?: string;
        llm_provider?: string;
        llm_model?: string;
      } | null;
      const lines = body ? sanitizeReanalyzeLines(body.transcript) : null;
      if (!lines || lines.length === 0) {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      // Reject rather than truncate — a silent trim would read as "the whole
      // session was reanalyzed" when it wasn't.
      if (lines.length > MAX_REANALYZE_LINES || reanalyzeCharCount(lines) > MAX_REANALYZE_CHARS) {
        return Response.json(
          { error: "too_large", max_lines: MAX_REANALYZE_LINES, max_chars: MAX_REANALYZE_CHARS },
          { status: 413 },
        );
      }

      const usingOwnKey = !body?.llm_api_key;
      if (usingOwnKey && identity.kind === "user") {
        const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
        const ent = (await registry
          .fetch(`https://registry/_entitlement?user_id=${encodeURIComponent(identity.userId)}`)
          .then((r) => r.json())
          .catch(() => ({ entitled: true }))) as { entitled?: boolean; plan?: string | null };
        const access = sessionAnalysisAccess(ent);
        if (access.relayOnly) {
          return Response.json({ error: "relay_only" }, { status: 403 });
        }
        if (!access.userEntitled) {
          return Response.json({ error: "subscription_inactive" }, { status: 403 });
        }
      }

      // Resolve provider/key/model exactly as a live session's llmConfig()
      // would: BYOK wins and is never metered; the hosted path runs the paid
      // model for tenants when configured and meters real-$ per usage block.
      // The resolution itself lives in llm/hosted-config.ts so the I3 verdict
      // it passes to fallbackLegFor is directly testable — see the file header.
      const ledger = createSpendLedger(pricingOptionsFromEnv(env));
      const config: LlmConfig = resolveAnalysisLlmConfig(env, body, identity, ledger);

      const outcome = await reanalyzeTranscript(config, lines);

      // Meter what was actually spent on the same rule as polish/refine (our
      // key + a tenant identity only); metering must never break the pass. A
      // reanalysis windows a whole transcript, so this delta can legitimately
      // carry several legs — including two providers, if the fallback picked up
      // partway through an outage.
      await reportSpend(env, identity, ledger.take());

      if (outcome.failure && outcome.windowsRun === 0) {
        return Response.json(
          {
            error: "analysis_failed",
            status: outcome.failure.status ?? null,
            message: outcome.failure.message,
          },
          { status: 502 },
        );
      }
      return Response.json({
        commitments: outcome.result.commitments,
        asks: outcome.result.asks,
        subtext: outcome.result.subtext,
        suggestions: outcome.result.suggestions,
        decisions: outcome.result.decisions,
        windows_run: outcome.windowsRun,
        model: config.model,
        // Partial means "do not treat zeros as authoritative": a window
        // failed, or a category never came back from the model at all (an
        // engine gap the OpenAI leg has hit). missing_categories names the
        // suspect ones so the client can flag instead of overwrite.
        partial: Boolean(outcome.failure) || (outcome.missingCategories?.length ?? 0) > 0,
        missing_categories: outcome.missingCategories ?? [],
      });
    }

    // Free-form Q&A about a session or the day ("ask a question in the note
    // field"). Structurally identical to /analyze — stateless, no Session DO,
    // NOTHING RETAINED, same entitlement gate + BYOK bypass + real-$ metering —
    // but it makes ONE grounded call over a client-rendered context block
    // instead of windowing a transcript, and returns prose, not extractions.
    if (request.method === "POST" && url.pathname === "/ask") {
      const body = (await request.json().catch(() => null)) as {
        context?: unknown;
        question?: unknown;
        scope?: unknown;
        llm_api_key?: string;
        llm_provider?: string;
        llm_model?: string;
      } | null;
      const context = typeof body?.context === "string" ? body.context : "";
      const question = typeof body?.question === "string" ? body.question.trim() : "";
      const scope: AskScope = body?.scope === "day" ? "day" : "conversation";
      if (!question) {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      // Reject rather than truncate — a silently-trimmed context would produce
      // a confidently-wrong answer that read as grounded in the whole session.
      if (byteLength(context) > MAX_ASK_CONTEXT_BYTES || byteLength(question) > MAX_ASK_QUESTION_BYTES) {
        return Response.json(
          { error: "too_large", max_context_bytes: MAX_ASK_CONTEXT_BYTES, max_question_bytes: MAX_ASK_QUESTION_BYTES },
          { status: 413 },
        );
      }

      const usingOwnKey = !body?.llm_api_key;
      if (usingOwnKey && identity.kind === "user") {
        const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
        const ent = (await registry
          .fetch(`https://registry/_entitlement?user_id=${encodeURIComponent(identity.userId)}`)
          .then((r) => r.json())
          .catch(() => ({ entitled: true }))) as { entitled?: boolean; plan?: string | null };
        const access = sessionAnalysisAccess(ent);
        if (access.relayOnly) {
          return Response.json({ error: "relay_only" }, { status: 403 });
        }
        if (!access.userEntitled) {
          return Response.json({ error: "subscription_inactive" }, { status: 403 });
        }
      }

      // Resolve provider/key/model exactly as /analyze does — the same function,
      // which is the point: one place decides the I3 verdict for both routes.
      const ledger = createSpendLedger(pricingOptionsFromEnv(env));
      const config: LlmConfig = resolveAnalysisLlmConfig(env, body, identity, ledger);

      let answer: string;
      try {
        answer = (await answerQuestion(config, { scope, context, question })).answer;
      } catch (err) {
        // Same reason as /context/refine: a call that threw on protocol grounds
        // (refusal, truncation, unparseable tool call) has already been billed
        // for its output tokens, so the delta is reported before the error goes
        // out rather than discarded with it.
        await reportSpend(env, identity, ledger.take());
        return Response.json(
          { error: "ask_failed", message: err instanceof Error ? err.message : String(err) },
          { status: 502 },
        );
      }

      await reportSpend(env, identity, ledger.take());

      return Response.json({ answer, model: config.model });
    }

    // Tenant user management: mint/list/revoke the tokens an operator hands
    // to other people who want to use THIS deployment instead of running
    // their own Worker.
    // Operator-only — a tenant may not mint or manage other tenants.
    const tenantUsersMatch = url.pathname.match(/^\/tenant-users(\/(.+))?$/);
    if (tenantUsersMatch) {
      if (identity.kind !== "operator") {
        return new Response("forbidden", { status: 403 });
      }
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      const label = tenantUsersMatch[2];
      if (request.method === "POST" && !label) {
        return registry.fetch(new Request("https://registry/users", request));
      }
      if (request.method === "GET" && !label) {
        return registry.fetch("https://registry/users");
      }
      if (request.method === "DELETE" && label) {
        return registry.fetch(`https://registry/users/${encodeURIComponent(label)}`, { method: "DELETE" });
      }
      return new Response("not found", { status: 404 });
    }

    // Promotional / test keys (operator-only). Mints a
    // tenant token entitled for N months — hand the returned CYRANO-XXXX code to
    // a tester, who pastes it into "Activate subscription". Body: {months, label?}.
    if (url.pathname === "/promo-keys") {
      if (identity.kind !== "operator") {
        return new Response("forbidden", { status: 403 });
      }
      if (request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      return registry.fetch(new Request("https://registry/_promo", request));
    }

    // Lifetime Pro license keys (operator-only). Mints a device-bindable license
    // key — hand the returned CYRANO-XXXX-XXXX-XXXX-XXXX to a tester, who enters
    // it in Settings → Unlock Pro. Body: {email?}. Stripe mints these later via
    // a mode:"payment" webhook writing the same record.
    if (url.pathname === "/license-keys") {
      if (identity.kind !== "operator") {
        return new Response("forbidden", { status: 403 });
      }
      if (request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      return registry.fetch(new Request("https://registry/_license/mint", request));
    }

    // Bug-report queue (operator-only): read what users submitted in-app and
    // delete handled ones. Submission itself is the token-less POST
    // /bug-report above — this pair is the operator's side of that mailbox.
    const bugReportsMatch = url.pathname.match(/^\/bug-reports(\/(.+))?$/);
    if (bugReportsMatch) {
      if (identity.kind !== "operator") {
        return new Response("forbidden", { status: 403 });
      }
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      const id = bugReportsMatch[2];
      if (request.method === "GET" && !id) {
        return registry.fetch(`https://registry/_bugreport${url.search}`);
      }
      if (request.method === "DELETE" && id) {
        return registry.fetch(`https://registry/_bugreport/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      }
      return new Response("not found", { status: 404 });
    }

    // Release adoption (operator-only, backend/src/adoption.ts): how many
    // distinct devices are running each shipped version, counted from the
    // license revalidations and trial heartbeats those devices already send
    // hourly. `?days=N` sets the activity window (default 30).
    if (request.method === "GET" && url.pathname === "/adoption") {
      if (identity.kind !== "operator") {
        return new Response("forbidden", { status: 403 });
      }
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      const days = url.searchParams.get("days");
      return registry.fetch(
        `https://registry/_adoption${days ? `?days=${encodeURIComponent(days)}` : ""}`,
      );
    }

    // Per-subject cost report (operator-only, backend/src/costs.ts): every
    // subject with what they cost us this period and all-time, ranked, with the
    // provider+model breakdown, how much of it is a published price, BYOK call
    // counts, plan/subscription state, and the purchase record ALREADY on the
    // user record (Apple's opaque original-transaction id / Stripe's ids /
    // promo / label). Nothing new is collected from any client to make this
    // work — see the header of costs.ts and BAR invariant I7.
    //
    // The complement of GET /usage, which answers for ONE user_id and gives you
    // no way to discover which user_id to ask about (defect D4). Bounded: this
    // is a paged scan with a cursor, never a load-everything-then-sort.
    if (request.method === "GET" && url.pathname === "/costs") {
      if (identity.kind !== "operator") {
        return new Response("forbidden", { status: 403 });
      }
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      return registry.fetch(`https://registry/_costs${costsQuery(url)}`);
    }

    // Per-user usage/cost read (paid hosted tier).
    // A tenant reads their own meter; the operator may read any tenant's via
    // ?user_id=. Forwarded to the registry's internal _usage read (which is
    // blocked from direct external reach, like the other _-prefixed routes).
    if (request.method === "GET" && url.pathname === "/usage") {
      const userId = identity.kind === "user" ? identity.userId : url.searchParams.get("user_id");
      if (!userId) {
        return Response.json({ error: "missing_user_id" }, { status: 400 });
      }
      const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      return registry.fetch(`https://registry/_usage?user_id=${encodeURIComponent(userId)}`);
    }

    // Agent key management: mint/list/update/revoke. Forwarded to the
    // singleton registry DO with the /agent-keys prefix stripped (it only
    // knows "/" and "/:label"). Scoped to the caller's own tenant when they
    // are a tenant (mint stamps ownership; list/update/revoke filter/check
    // it); the operator sees and manages everything, unchanged from before
    // tenancy.
    const agentKeysMatch = url.pathname.match(/^\/agent-keys(\/.*)?$/);
    if (agentKeysMatch) {
      const innerPath = agentKeysMatch[1] ?? "/";
      // The registry's `_`-prefixed routes (_validate/_validate_user/
      // _active/_latest) are DO-to-DO internal — SessionDO and auth reach
      // them via stub.fetch directly, never through this router. Reachable
      // from outside, they would let any bearer-token holder hijack the
      // latest-session pointer, read active session ids, or probe keys.
      if (innerPath.startsWith("/_")) {
        return new Response("not found", { status: 404 });
      }
      const stub = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("registry"));
      const innerUrl = new URL(innerPath, "https://registry");
      if (identity.kind === "user") innerUrl.searchParams.set("owner_user_id", identity.userId);

      if (request.method === "POST" && innerPath === "/") {
        // Mint: stamp ownership onto the request body so RegistryDO can
        // record it (query params don't carry a POST body along).
        const body = (await request.json().catch(() => ({}))) as { label?: string };
        return stub.fetch(
          new Request(innerUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...body,
              ...(identity.kind === "user" ? { owner_user_id: identity.userId } : {}),
            }),
          }),
        );
      }
      return stub.fetch(new Request(innerUrl, request));
    }

    // /session/:id/... — everything after the id is forwarded to the DO's
    // fetch(), with the caller's resolved identity attached so SessionDO can
    // enforce per-session ownership (a session with no owner — self-host /
    // operator-created — stays open to anyone who already cleared
    // resolveIdentity, exactly as before this feature existed).
    const match = url.pathname.match(/^\/session\/([A-Za-z0-9_-]+)(\/.*)?$/);
    if (!match) {
      return new Response("not found", { status: 404 });
    }

    const sessionId = match[1]!;
    const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(sessionId));
    return stub.fetch(forwardWithIdentity(request, identity));
  },
};

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * How a STATELESS route (one that runs no Session DO) resolves the LlmConfig it
 * calls the model with: which provider, whose key, which model, whether the
 * never-default fallback leg applies, and what gets metered.
 *
 * WHY THIS IS A MODULE AND NOT FOUR INLINE BLOCKS IN index.ts
 * ----------------------------------------------------------
 * BAR invariant I3 — "a client-supplied key is never silently replaced by our
 * key on another provider" — is decided by ONE argument at each call site:
 * `fallbackLegFor(env, { usingClientKey: … })`. `fallbackLegFor` itself is
 * heavily tested and refuses correctly; the risk that survives is a call site
 * passing the wrong verdict. A structural grep over the sources can see that
 * `fallbackLegFor` was called and CANNOT see what it was called with, so the
 * verdict has to live somewhere a test can call directly and assert on.
 *
 * These two functions are that somewhere. They are pure (env in, config out —
 * no fetch, no DO, no request), so `test/llm-fallback.test.ts` can build the
 * exact config each of the four routes builds and assert both that BYOK
 * resolves NO fallback and that the hosted path resolves one. Before the
 * extraction the same 30 lines appeared verbatim in `/analyze` and `/ask`, so
 * this removes a duplicate rather than adding an indirection.
 *
 * Callers: index.ts `/analyze`, `/ask` (analysis shape — BYOK may name its own
 * provider/model) and `/dictation/polish`, `/context/refine` (stateless shape —
 * always the operator's endpoint and model, BYOK only swaps the key).
 * The Session DO has its own equivalent seam, `sessionLlmConfig` in
 * session-do.ts, for the same reason.
 */

import type { Env } from "../env.js";
import { fallbackLegFor, transcriptContentLoggingEnabled } from "../env.js";
import type { Identity } from "../auth.js";
import {
  ANTHROPIC_BASE_URL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  asProvider,
  defaultBaseUrlFor,
  type LlmConfig,
  type LlmProvider,
} from "./client.js";
import type { SpendLedger } from "./spend.js";

/**
 * Read the Env field an operator NAMED (HOSTED_PAID_KEY_ENV), returning a
 * value only when it really is a string.
 *
 * Env is a plain object, so an operator naming an Object.prototype member
 * ("constructor", "toString", "valueOf") gets an inherited function back — and
 * a function is non-nullish, so `?? env.LLM_API_KEY` would NOT fall through and
 * we would put a function on the wire as a bearer token. Same guard env.ts
 * applies to FALLBACK_KEY_ENV.
 */
export function namedEnvKey(env: Env, keyEnv: string): string | undefined {
  if (!Object.hasOwn(env as object, keyEnv)) return undefined;
  const v = (env as unknown as Record<string, unknown>)[keyEnv];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The PRIMARY leg: what an operator / self-host session — and, on the
 * stateless routes, every non-owned identity — runs on. LLM_API_KEY at
 * LLM_BASE_URL, speaking whatever LLM_PROVIDER names (default native
 * Anthropic). The ONLY place that env triple is turned into a leg, so the
 * WebSocket path (SessionDO.hostedLeg) and the HTTP path
 * (resolveAnalysisLlmConfig) cannot disagree about which wire they speak.
 *
 * `baseUrl` is LLM_BASE_URL verbatim for every provider: unlike the fallback
 * and BYOK legs there is no per-provider default here, because the operator
 * chose the URL deliberately and a tag must not redirect it (env.ts).
 */
export function primaryLeg(env: Env): { provider: LlmProvider; baseUrl: string; apiKey: string; model: string } {
  return {
    provider: asProvider(env.LLM_PROVIDER) ?? "anthropic",
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
  };
}

/**
 * Where a call on the native Anthropic wire goes when it is NOT the primary
 * leg: an Anthropic client key, or a paid tier pinned to "anthropic".
 *
 * LLM_BASE_URL used to be an Anthropic root by definition, so Anthropic BYOK
 * simply followed it — which is what lets a deployment on an AI Gateway route
 * client keys through the gateway too. With LLM_PROVIDER that URL can be an
 * OpenAI-compatible endpoint, and an Anthropic key POSTed to
 * api.openai.com/v1/messages is a user secret handed to the wrong company (and
 * a failed call). So: follow LLM_BASE_URL only while the primary actually
 * speaks Anthropic; otherwise go to Anthropic's own root.
 */
export function anthropicBaseUrl(env: Env): string {
  return primaryLeg(env).provider === "anthropic" ? env.LLM_BASE_URL : ANTHROPIC_BASE_URL;
}

/**
 * The wire and host a CLIENT-supplied key is sent to, from the client's
 * `llm_provider` value. The counterpart of primaryLeg() for the BYOK branch,
 * and the ONLY place a client tag becomes a base URL, so the WebSocket path
 * (sessionLlmConfig) and the HTTP routes (below) cannot disagree.
 *
 *   "anthropic"  → native Messages API at anthropicBaseUrl(): the operator's
 *                  LLM_BASE_URL while the primary is Anthropic (a BYOK key
 *                  follows the operator's gateway, as it always has), and
 *                  Anthropic's own root once the primary is on the other wire;
 *   "openrouter" → Chat Completions at openrouter.ai;
 *   "openai"     → Chat Completions at api.openai.com.
 *
 * Anything else (older clients, typos) is "anthropic", unchanged. Deliberately
 * not asProvider(): that parser's "openai" alias means the WIRE, and applying
 * it here would send an OpenAI key to OpenRouter.
 */
export function clientLeg(env: Env, raw: unknown): { provider: LlmProvider; baseUrl: string } {
  if (raw === "openrouter") return { provider: "openrouter", baseUrl: OPENROUTER_BASE_URL };
  if (raw === "openai") return { provider: "openrouter", baseUrl: OPENAI_BASE_URL };
  return { provider: "anthropic", baseUrl: anthropicBaseUrl(env) };
}

/**
 * The HOSTED leg for a session that has an owning (paid) user, and the ONLY
 * place HOSTED_PAID_* is turned into one — SessionDO.hostedLeg and
 * resolveAnalysisLlmConfig both call this, so the WebSocket and HTTP paths
 * cannot disagree about where paid traffic goes.
 *
 * Not owned, or no HOSTED_PAID_MODEL → the primary leg, unchanged.
 *
 * HOSTED_PAID_PROVIDER unset (or unknown) → the primary leg with the paid
 * model: LLM_PROVIDER's wire at LLM_BASE_URL with LLM_API_KEY. That is the
 * only thing that can work at that URL, so it follows the primary's wire
 * rather than pinning "anthropic" — an Anthropic request to an OpenAI
 * endpoint is not a safer default, just a broken one.
 *
 * HOSTED_PAID_PROVIDER set → that wire, at HOSTED_PAID_BASE_URL or the RAW
 * tag's own root ("openai" → api.openai.com, "openrouter" → openrouter.ai —
 * never the alias folded onto the other company's host; "anthropic" →
 * anthropicBaseUrl()), with the key HOSTED_PAID_KEY_ENV names (default
 * LLM_API_KEY). An explicit tag is honoured even when it names the primary's
 * wire, so HOSTED_PAID_PROVIDER=anthropic keeps paid traffic on Anthropic
 * after the primary moves.
 */
export function hostedPaidLeg(
  env: Env,
  owned: boolean,
): { provider: LlmProvider; baseUrl: string; apiKey: string; model: string } {
  const primary = primaryLeg(env);
  if (!owned || !env.HOSTED_PAID_MODEL) return primary;
  const model = env.HOSTED_PAID_MODEL;
  const raw = env.HOSTED_PAID_PROVIDER;
  const provider = asProvider(raw);
  if (!provider) return { ...primary, model };
  // `namedEnvKey` and not a bare index: HOSTED_PAID_KEY_ENV is operator-
  // supplied, and an Object.prototype name ("constructor") resolves to an
  // inherited FUNCTION, which is non-nullish — `??` would not fall through and
  // a function would go out as the bearer token. Same guard as env.ts's
  // FALLBACK_KEY_ENV lookup.
  const keyEnv = env.HOSTED_PAID_KEY_ENV ?? "LLM_API_KEY";
  return {
    provider,
    baseUrl:
      env.HOSTED_PAID_BASE_URL ??
      (provider === "anthropic" ? anthropicBaseUrl(env) : defaultBaseUrlFor(raw)!),
    apiKey: namedEnvKey(env, keyEnv) ?? primary.apiKey,
    model,
  };
}

/** A client-supplied selection the server cannot honour. `code` is the wire
 * value: the HTTP routes return it as `{error: code}` with 400, the session
 * path as an `llm_error` status detail. */
export class ClientLlmSelectionError extends Error {
  constructor(public readonly code: "llm_model_required", message: string) {
    super(message);
    this.name = "ClientLlmSelectionError";
  }
}

/**
 * clientLeg() plus the model, with the one rule the contract states: an
 * OpenAI-compatible client key (openrouter / openai) MUST name its model.
 * Falling back to the operator's LLM_MODEL there would send an Anthropic
 * model id to /chat/completions — a confusing provider-side 4xx on the
 * user's own bill, instead of a clear refusal here. Anthropic BYOK keeps
 * its long-standing default (the operator's model), unchanged.
 *
 * `fallbackModel` is what an Anthropic client key runs when it names none:
 * env.LLM_MODEL on the HTTP routes, the hosted leg's model in a session.
 */
export function clientSelection(
  env: Env,
  raw: unknown,
  model: string | null | undefined,
  fallbackModel: string,
): { provider: LlmProvider; baseUrl: string; model: string } {
  const leg = clientLeg(env, raw);
  const named = (model ?? "").trim();
  if (named) return { ...leg, model: named };
  if (leg.provider === "openrouter") {
    throw new ClientLlmSelectionError(
      "llm_model_required",
      `llm_model is required with llm_provider "${String(raw)}" — there is no server-side default model for an OpenAI-compatible key.`,
    );
  }
  return { ...leg, model: fallbackModel };
}

/** The BYOK fields a client may put in an /analyze or /ask body. */
export interface ClientLlmSelection {
  llm_api_key?: string;
  llm_provider?: string;
  llm_model?: string;
}

/**
 * `/analyze` and `/ask`: BYOK wins and is never metered and never failed over;
 * the hosted path runs the paid model for owned tenants when configured, is
 * metered in real dollars, and is eligible for the fallback leg.
 *
 * `ledger.recordServed` is wired ONLY on the hosted branch and
 * `ledger.recordByok` ONLY on the BYOK branch, so a BYOK call contributes
 * exactly zero micro-dollars to the per-user meter no matter what the provider
 * reports — while still being counted, so a subject who brings their own key is
 * distinguishable from one who barely used the product (defect D5).
 */
export function resolveAnalysisLlmConfig(
  env: Env,
  body: ClientLlmSelection | null | undefined,
  identity: Identity,
  ledger: SpendLedger,
): LlmConfig {
  const clientKey = body?.llm_api_key;
  if (!clientKey) {
    return {
      // Paid tier for an owned identity, else the primary — one resolver,
      // shared with SessionDO.hostedLeg (see hostedPaidLeg).
      ...hostedPaidLeg(env, identity.kind === "user"),
      logContent: transcriptContentLoggingEnabled(env),
      fallback: fallbackLegFor(env, { usingClientKey: false }),
      // Priced at the provider AND model that served the block, so a
      // failed-over call is billed at the fallback's account and rate, never at
      // the primary's (BAR I5). `leg.baseUrl` is what separates our OpenAI key
      // from an OpenRouter key on the same `openrouter` wire tag.
      onUsage: (usage, leg, call) => ledger.recordServed(usage, leg, call),
    };
  }
  return {
    ...clientSelection(env, body?.llm_provider, body?.llm_model, env.LLM_MODEL),
    apiKey: clientKey,
    logContent: transcriptContentLoggingEnabled(env),
    // Always undefined — a BYOK call is never failed over onto our key
    // (BAR invariant I3). Stated, not omitted, so the rule is visible here.
    fallback: fallbackLegFor(env, { usingClientKey: true }),
    // BYOK spends the user's key, so our meter must not move by a single
    // micro-dollar (BAR I6) — `recordByok` takes no usage and no rate, so
    // there is no code path here that can produce a cost. What it DOES do is
    // count the call, so a bring-your-own-key subject stops looking identical
    // to a subject who never used the product (defect D5).
    onUsage: (_usage, _leg, call) => ledger.recordByok(call),
  };
}

/**
 * `/dictation/polish` and `/context/refine`: text-only passes on the operator's
 * own endpoint and model, where a client key (if present) only swaps the
 * credential. Same I3 rule — a call spending the client's key resolves no
 * fallback leg — and the same metering rule: our key + a tenant identity only,
 * which the caller enforces by ignoring a zero delta.
 */
export function resolveStatelessLlmConfig(
  env: Env,
  clientKey: string | undefined,
  ledger: SpendLedger,
): LlmConfig {
  const usingClientKey = Boolean(clientKey);
  // Hosted: the primary leg — its wire too, not just its URL, or an
  // OpenAI-wire primary would be spoken to in Anthropic here. BYOK: these
  // routes carry no `llm_provider`, and the client contract sends only an
  // Anthropic key on them, so the key goes where an Anthropic client key goes
  // (clientLeg "anthropic": LLM_BASE_URL while the primary is Anthropic, else
  // Anthropic's own root — never an OpenAI-compatible LLM_BASE_URL).
  const leg = clientKey
    ? { ...clientLeg(env, "anthropic"), apiKey: clientKey }
    : primaryLeg(env);
  return {
    provider: leg.provider,
    baseUrl: leg.baseUrl,
    apiKey: leg.apiKey,
    model: env.LLM_MODEL,
    fallback: fallbackLegFor(env, { usingClientKey }),
    // Priced at the provider+model that ACTUALLY served the block, not at
    // env.LLM_MODEL: with a fallback configured, the served leg can be a
    // different account on a different rate card. (Identical to env.LLM_MODEL
    // on the default path — this is defect D6, fixed at the source rather than
    // by passing a better guess.)
    onUsage: (usage, leg, call) => {
      if (usingClientKey) ledger.recordByok(call);
      else ledger.recordServed(usage, leg, call);
    },
  };
}

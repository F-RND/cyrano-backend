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
import { OPENROUTER_BASE_URL, asProvider, type LlmConfig, type LlmProvider } from "./client.js";
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
    const owned = identity.kind === "user" && Boolean(env.HOSTED_PAID_MODEL);
    const primary = primaryLeg(env);
    const model = owned ? env.HOSTED_PAID_MODEL! : primary.model;
    const openrouter = owned && asProvider(env.HOSTED_PAID_PROVIDER) === "openrouter";
    const keyEnv = env.HOSTED_PAID_KEY_ENV ?? "LLM_API_KEY";
    return {
      provider: openrouter ? "openrouter" : primary.provider,
      baseUrl: openrouter ? (env.HOSTED_PAID_BASE_URL ?? OPENROUTER_BASE_URL) : primary.baseUrl,
      // `typeof … === "string"` and not `??`: `keyEnv` is operator-supplied, so
      // HOSTED_PAID_KEY_ENV="constructor" (or any Object.prototype name)
      // resolves to an inherited FUNCTION, which is non-nullish — `??` would
      // never fall through and a function would be sent as the API key. env.ts
      // guards its own key lookup exactly this way; this one did not.
      apiKey: openrouter ? namedEnvKey(env, keyEnv) ?? primary.apiKey : primary.apiKey,
      model,
      logContent: transcriptContentLoggingEnabled(env),
      fallback: fallbackLegFor(env, { usingClientKey: false }),
      // Priced at the provider AND model that served the block, so a
      // failed-over call is billed at the fallback's account and rate, never at
      // the primary's (BAR I5). `leg.baseUrl` is what separates our OpenAI key
      // from an OpenRouter key on the same `openrouter` wire tag.
      onUsage: (usage, leg) => ledger.recordServed(usage, leg),
    };
  }
  const provider = body?.llm_provider === "openrouter" ? "openrouter" : "anthropic";
  return {
    provider,
    baseUrl: provider === "openrouter" ? OPENROUTER_BASE_URL : env.LLM_BASE_URL,
    apiKey: clientKey,
    model: body?.llm_model || env.LLM_MODEL,
    logContent: transcriptContentLoggingEnabled(env),
    // Always undefined — a BYOK call is never failed over onto our key
    // (BAR invariant I3). Stated, not omitted, so the rule is visible here.
    fallback: fallbackLegFor(env, { usingClientKey: true }),
    // BYOK spends the user's key, so our meter must not move by a single
    // micro-dollar (BAR I6) — `recordByok` takes no usage and no rate, so
    // there is no code path here that can produce a cost. What it DOES do is
    // count the call, so a bring-your-own-key subject stops looking identical
    // to a subject who never used the product (defect D5).
    onUsage: () => ledger.recordByok(),
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
  return {
    baseUrl: env.LLM_BASE_URL,
    apiKey: clientKey || env.LLM_API_KEY,
    model: env.LLM_MODEL,
    fallback: fallbackLegFor(env, { usingClientKey }),
    // Priced at the provider+model that ACTUALLY served the block, not at
    // env.LLM_MODEL: with a fallback configured, the served leg can be a
    // different account on a different rate card. (Identical to env.LLM_MODEL
    // on the default path — this is defect D6, fixed at the source rather than
    // by passing a better guess.)
    onUsage: (usage, leg) => {
      if (usingClientKey) ledger.recordByok();
      else ledger.recordServed(usage, leg);
    },
  };
}

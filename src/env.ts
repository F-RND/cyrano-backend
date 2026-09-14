// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import {
  FALLBACK_TIMEOUT_MS,
  OPENROUTER_BASE_URL,
  asProvider,
  type FallbackLeg,
  type LlmProvider,
} from "./llm/client.js";

export interface Env {
  SESSION_DO: DurableObjectNamespace;
  REGISTRY_DO: DurableObjectNamespace;
  // Per-account standing inbox for proactive agent -> user pings
  // (account-inbox contract). One instance per account,
  // keyed by the caller's identity.
  ACCOUNT_INBOX_DO: DurableObjectNamespace;

  // Secrets — set with `wrangler secret put`, never committed.
  AUTH_TOKEN: string;
  LLM_API_KEY: string;
  // Vars — see wrangler.jsonc. LLM_BASE_URL is the /v1 root of whichever
  // provider LLM_PROVIDER names.
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  // Which wire protocol the primary path speaks to LLM_BASE_URL with LLM_API_KEY.
  // "anthropic" (default; native Messages API) or "openrouter" (OpenAI-
  // compatible Chat Completions — OpenAI itself, OpenRouter, or any compatible
  // server; "openai" is accepted as an alias). The tag names the wire, not a
  // company: an operator choosing "openrouter" sets LLM_BASE_URL to the
  // endpoint they mean (https://api.openai.com/v1, https://openrouter.ai/api/v1,
  // …) themselves. There is deliberately no per-provider base-URL default on
  // the primary path — the operator set the URL once, on purpose, and a tag
  // must never silently redirect it. Unset/unknown → "anthropic".
  LLM_PROVIDER?: string;

  // --- Free 3-day Pro trial (src/trial.ts) ---
  // Base64 (PKCS8 DER) of the Ed25519 private key the Worker signs trial tokens
  // with. Set with `wrangler secret put TRIAL_SIGNING_PRIVATE_KEY`; generate the
  // keypair with any standard Ed25519 key-generation tool. Optional: unset → the
  // /trial/* routes return 503 and the app simply never offers a trial (the
  // matching public key is compiled into the client). The private key never
  // leaves the Worker; a leaked public key is harmless.
  TRIAL_SIGNING_PRIVATE_KEY?: string;

  // --- Paid hosted tier (Stripe subscriptions) ---
  // All optional so an existing self-host deployment that sets none of them
  // typechecks and runs unchanged — the Stripe routes simply refuse (503)
  // when the secrets aren't present, and hosted sessions fall back to
  // LLM_MODEL when HOSTED_PAID_MODEL is unset.
  //
  // Secrets (`wrangler secret put`): the Stripe API key + webhook signing secret.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  // Vars (wrangler.jsonc): the two recurring Price ids + the marketing origin
  // used for Checkout cancel/return URLs.
  STRIPE_PRICE_ANNUAL?: string;
  STRIPE_PRICE_MONTHLY?: string;
  LANDING_BASE_URL?: string;
  // --- Paid hosted tier, App Store side (appstore.ts) ---
  // These token-less routes are inert unless this literal opt-in is set.
  APP_STORE_ENABLED?: string;
  // Comma-separated App Store bundle identifiers permitted to link. There is
  // deliberately no source default; an enabled deployment must supply its own.
  APPLE_BUNDLE_IDS?: string;
  // Exact Apple transaction environment accepted by this deployment (normally
  // "Production" or "Sandbox"). Unset accepts none.
  APPLE_ENVIRONMENT?: string;
  // Token-less free-cold enrollment is also an explicit operator opt-in.
  FREE_COLD_ENROLLMENT_ENABLED?: string;
  // The model owned (hosted-tier) sessions run on — Haiku 4.5, ~3× cheaper than
  // Sonnet, which is what makes the subscription price viable. Operator /
  // self-host sessions (no owner) keep using LLM_MODEL.
  HOSTED_PAID_MODEL?: string;
  // Optional: run the paid hosted model on a non-Anthropic provider. When
  // HOSTED_PAID_PROVIDER === "openrouter", owned sessions speak the
  // OpenAI-compatible Chat Completions API at HOSTED_PAID_BASE_URL using the
  // key named by HOSTED_PAID_KEY_ENV (a secret) — e.g. GPT-5.6 Luna via OpenAI.
  // Unset → the hosted path stays native Anthropic on LLM_BASE_URL/LLM_API_KEY.
  HOSTED_PAID_PROVIDER?: string;
  HOSTED_PAID_BASE_URL?: string;
  HOSTED_PAID_KEY_ENV?: string;

  // --- Never-default LLM fallback leg (backend/src/llm/client.ts) ---
  // A SECOND provider that is tried exactly once, and only after the primary
  // hosted call has already failed in a way that another key could plausibly
  // fix (see `shouldFailOver` for the exact trigger list). It is never the
  // default: with the primary healthy, the outbound request is byte-identical
  // to a deployment that has none of these set.
  //
  // ENTIRELY INERT UNLESS CONFIGURED. `fallbackLegFor()` returns undefined
  // unless FALLBACK_PROVIDER names a provider AND the key it points at resolves
  // to a non-empty string. That is also the kill switch: clear FALLBACK_PROVIDER
  // and the feature is gone, no code change.
  //
  // NEVER APPLIES TO BYOK. A client-supplied key must not be silently swapped
  // for ours on a provider the user did not choose — it bills us and moves their
  // transcript. `fallbackLegFor()` refuses when `usingClientKey` is true, and it
  // is the ONLY place a fallback leg may be constructed.
  //
  // "anthropic" | "openrouter". Unset/empty/unknown → no fallback.
  FALLBACK_PROVIDER?: string;
  // /v1 root. Unset → OpenRouter's public API root. Required for "anthropic", which has no
  // safe default here (LLM_BASE_URL is the primary and would fail over to itself).
  FALLBACK_BASE_URL?: string;
  // Model on the fallback provider. Required for every provider.
  FALLBACK_MODEL?: string;
  // NAME of the Env field holding the fallback key — never the key itself.
  // Required. Set the key with `wrangler secret put <name>`.
  FALLBACK_KEY_ENV?: string;
  // Timeout budget for the fallback attempt alone, ms. Unset → 15s, tighter than
  // the primary's 30s so primary-timeout + fallback still fits a caller's
  // patience. Non-numeric or <= 0 → the default.
  FALLBACK_TIMEOUT_MS?: string;

  // --- Configured LLM rates (backend/src/llm/pricing.ts) ---
  // Rates for providers that do NOT publish a per-model list price, so the
  // per-user meter has a real number instead of an unmarked Sonnet guess.
  // Both are USD per 1,000,000 tokens, flat across input and output. A priced
  // usage from either records basis "configured" — never "exact", because
  // there is no published per-model price to be exact about.
  //

  // Flat rate for whatever provider FALLBACK_PROVIDER names, resolved to the
  // billing account its base URL points at. Exists so configuring the fallback
  // on OpenRouter (no per-model card is maintained for its ~300 models) is not
  // silently metered at the defensive estimate. An unpriced provider without
  // this setting prices "estimated" and says so.
  FALLBACK_RATE_USD_PER_M?: string;

  // --- Operator cost report (backend/src/costs.ts, GET /costs) ---
  // What a plan is worth to us per 30 days, as JSON: plan id → USD.
  //   PLAN_REVENUE_USD_PER_MONTH = {"annual":1.85,"monthly":4.24}
  // Merged over the defaults in costs.ts (the LIST prices from
  // checked-in reporting defaults: $1.99 annual-billed, $4.99 monthly), so naming
  // one plan leaves the others alone. It exists because the default is GROSS —
  // before Apple's 15–30%, before Stripe's ~3% + 30¢, before tax and refunds —
  // and an operator who wants the NET column to mean net sets the net figures
  // here. Purely a reporting knob: nothing bills, gates, or meters on it.
  PLAN_REVENUE_USD_PER_MONTH?: string;

  // --- Shadow price-testing (backend/src/analysis/price-test.ts) ---
  // A market-testing mode: when enabled, each hosted analysis window ALSO fans
  // out to every target in PRICE_TEST_TARGETS (on OUR keys, measurement-only —
  // the live copilot keeps running its normal canonical path), and the session
  // emits a per-target cost/conformance/latency report at session end. Off and
  // zero-cost unless PRICE_TEST_ENABLED === "true". Never runs on BYOK sessions
  // (that would bill the user and leak their key across providers).
  PRICE_TEST_ENABLED?: string;
  // Fraction of windows to shadow, "0".."1" (default "1" — every window). Lower
  // it to bound the extra spend on long sessions.
  PRICE_TEST_SAMPLE_RATE?: string;
  // JSON array of targets. Each: { label, provider ("anthropic"|"openrouter"),
  // baseUrl, model, keyEnv (name of the secret/var holding the API key),
  // inputPerM, outputPerM }. `openrouter` speaks OpenAI-compatible Chat
  // Completions, so it reaches OpenRouter or any OpenAI-compatible
  // endpoint via baseUrl. Example:
  //   [{"label":"or-gpt-oss","provider":"openrouter",
  //     "baseUrl":"https://openrouter.ai/api/v1","model":"openai/gpt-oss-120b",
  //     "keyEnv":"OPENROUTER_API_KEY","inputPerM":0.1,"outputPerM":0.5}]
  PRICE_TEST_TARGETS?: string;
  // API keys referenced by a target's `keyEnv`. Declared here for typing; any
  // secret name a target names is resolved dynamically off the Env at runtime.
  OPENROUTER_API_KEY?: string;

  OPENAI_API_KEY?: string;

  // Explicit, test-only escape hatch for logs that contain transcript-derived
  // text. Unset/anything except the literal string "true" is OFF. Production
  // keeps this absent/false; a developer may opt a disposable test deployment
  // in while diagnosing model attribution or comparing shadow outputs.
  TRANSCRIPT_CONTENT_LOGGING?: string;
}

/** Fail-closed gate for any log or diagnostic artifact containing user text. */
export function transcriptContentLoggingEnabled(env: Pick<Env, "TRANSCRIPT_CONTENT_LOGGING">): boolean {
  return env.TRANSCRIPT_CONTENT_LOGGING === "true";
}

/** Provider defaults for the fallback leg. "anthropic" has no
 * default base URL on purpose: the only sensible value would be LLM_BASE_URL,
 * i.e. failing over to the provider that just failed. */
const FALLBACK_DEFAULTS: Partial<Record<LlmProvider, { baseUrl?: string; model?: string }>> = {

  openrouter: { baseUrl: OPENROUTER_BASE_URL },
  anthropic: {},
};

/**
 * THE ONLY PLACE AN `LlmConfig.fallback` MAY BE BUILT.
 *
 * Every LLM call site (session-do `llmConfig()`, and /dictation/polish,
 * /context/refine, /analyze, /ask in index.ts) already knows whether it is
 * spending the user's key or ours; each passes that verdict here rather than
 * deciding for itself whether failover is allowed. Centralising it means the
 * BYOK rule (BAR invariant I3) is one testable branch instead of five.
 *
 * Returns undefined — feature entirely inert — when ANY of these hold:
 *  - `usingClientKey` (BYOK): failing a user's key over to ours would bill us
 *    and hand their transcript to a provider they never chose.
 *  - FALLBACK_PROVIDER is unset, empty, or not a provider we speak.
 *  - the key named by FALLBACK_KEY_ENV is missing or empty.
 *  - no base URL / model could be resolved for that provider.
 */
export function fallbackLegFor(
  env: Env,
  opts: { usingClientKey: boolean },
): FallbackLeg | undefined {
  // I3. Checked first and unconditionally: no env configuration can enable
  // failover for a call that is spending the client's own key.
  if (opts.usingClientKey) return undefined;

  const provider = asProvider(env.FALLBACK_PROVIDER);
  if (!provider) return undefined;

  const keyEnv = env.FALLBACK_KEY_ENV;
  if (!keyEnv) return undefined;
  const apiKey = (env as unknown as Record<string, unknown>)[keyEnv];
  if (typeof apiKey !== "string" || apiKey.length === 0) return undefined;

  const defaults = FALLBACK_DEFAULTS[provider] ?? {};
  const baseUrl = env.FALLBACK_BASE_URL || defaults.baseUrl;
  const model = env.FALLBACK_MODEL || defaults.model;
  if (!baseUrl || !model) return undefined;

  const parsedTimeout = Number(env.FALLBACK_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : FALLBACK_TIMEOUT_MS;

  return { provider, baseUrl, apiKey, model, timeoutMs };
}

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider-aware pricing for the per-user real-$ meter.
 *
 * WHAT THIS FIXES
 * ---------------
 * The meter used to key rates on the MODEL NAME alone and silently price
 * anything it didn't recognise at Sonnet's $3/$15. These are real money problems:
 * the same model can have different prices at
 * different providers, while an unrecognised model must never look exact.
 *
 * THE THREE KINDS OF RATE, AS TYPES AND NOT AS COMMENTS
 * ----------------------------------------------------
 * Every priced usage carries a BASIS, enforced by the shape of {@link RateCard}:
 *
 *   published  → has a per-model map whose entries each declare their own basis
 *                and cite a source ({@link ListedRate}), so a rate nobody
 *                verified cannot wear `exact`. An unlisted model prices at an
 *                operator-configured flat rate if one exists, else `estimated`
 *                at {@link ESTIMATE_RATE}. The lookup uses own-property
 *                semantics — a model named `constructor` or `toString` is
 *                UNLISTED, not an inherited function priced as a bill.

 *   unpriced   → we maintain no rate card for this account. An operator can
 *                supply a flat rate (→ `configured`); with none, it prices
 *                `estimated`.
 *
 * WHY "BILLING PROVIDER" IS NOT `LlmProvider`
 * -------------------------------------------
 * `LlmProvider` names a WIRE PROTOCOL, and the tag "openrouter" means
 * "OpenAI-compatible Chat Completions", not "the OpenRouter account". An
 * operator can set `HOSTED_PAID_PROVIDER: "openrouter"` and point it at
 * `https://api.openai.com/v1` — the tag says openrouter, the invoice comes from
 * OpenAI. Keying rates on the tag would reproduce D1 one level up. So the rate
 * key is the account that actually bills us, resolved from the tag AND the base
 * URL host by {@link billingProviderFor}.
 */

import {
  OPENROUTER_BASE_URL,
  usageMicrosAt,
  type LlmProvider,
  type LlmUsage,
  asProvider,
} from "./client.js";
import type { Env } from "../env.js";

/**
 * The account that receives the invoice — the thing a rate card belongs to.
 * Distinct from `LlmProvider` (a wire protocol); see the file header.
 * "unknown" is a real, reachable value (a base URL we don't recognise), never a
 * placeholder: it prices `estimated` and says so, which is the whole point.
 */
export type BillingProvider = "anthropic" | "openai" | "openrouter" | "unknown";

/**
 * How much to trust a priced figure. Recorded on every priced usage and carried
 * all the way into the per-user record, so a report can say what fraction of a
 * subject's spend is a real published price (BAR: "no silent mispricing", I4).
 *  - `exact`      — the provider publishes a per-model rate and this model is on it.
 *  - `configured` — an operator-supplied rate.
 *  - `estimated`  — no rate known for this provider+model; priced defensively
 *                   at {@link ESTIMATE_RATE} so we never under-count, and
 *                   MARKED so nobody mistakes it for a bill.
 */
export type PriceBasis = "exact" | "configured" | "estimated";

/**
 * A per-1,000,000-token price. `inputPerM` is quoted per 1M tokens, so it is
 * also exactly micro-dollars per token. Cache tokens are priced as multiples of
 * the input rate, which is how Anthropic quotes them.
 */
export interface TokenRate {
  inputPerM: number;
  outputPerM: number;
  /** x inputPerM for cache_creation_input_tokens. */
  cacheWriteMultiplier: number;
  /** x inputPerM for cache_read_input_tokens. */
  cacheReadMultiplier: number;
}

/**
 * One entry on a `published` card. A listed model is a number SOMEBODY CHOSE,
 * and this type forces them to say which kind of number it is:
 *  - `exact`      — the provider's published list price, cited in `source`.
 *  - `configured` — a rate WE maintain that is not verified against a published
 *                   price (carried forward, inferred, or partly guessed). The
 *                   dollars are the best we have; the basis says do not read
 *                   them as a bill.
 * `source` is REQUIRED and is the reason this shape exists: an uncited rate is
 * exactly how a guess gets promoted to a bill (see gpt-5.6-luna below, which the
 * previous version of this file labelled `exact` in code while disclaiming it in
 * a comment three lines away).
 */
interface ListedRate {
  rate: TokenRate;
  basis: "exact" | "configured";
  source: string;
}

/** See the file header: the three variants ARE the three bases. */
type RateCard =
  | { kind: "published"; models: Record<string, ListedRate> }
  | { kind: "unpriced"; note: string };

/** Anthropic's published cache ratios: write 1.25x input, read 0.1x input. */
const ANTHROPIC_CACHE = { cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 };

/**
 * The rate used when nothing better is known — deliberately the same Sonnet
 * $3/$15 the old `DEFAULT_RATE` used. The number was never the defect: pricing
 * an unknown model high is the safe direction for an anti-abuse ceiling, and
 * lowering it would let a runaway on an unknown model under-count. The defect
 * (D2) was that the guess was SILENT. It is now returned with
 * `basis: "estimated"` and stored that way, so a report can separate a bill
 * from a guess.
 */
export const ESTIMATE_RATE: TokenRate = { inputPerM: 3, outputPerM: 15, ...ANTHROPIC_CACHE };


/**
 * The rate cards, keyed by BILLING PROVIDER (never by model name alone — D1).
 *
 * Anthropic and OpenAI publish per-model list prices, so they get `published`
 * cards and their listed models price `exact`. OpenRouter is
 * `unpriced` — a per-model card for the ~300 models it proxies is not
 * maintainable, and the only way an OpenRouter leg reaches OUR meter is if an
 * operator configures it as the hosted or fallback leg, in which case they can
 * supply a flat rate (see {@link pricingOptionsFromEnv}).
 */
const RATE_CARDS: Record<BillingProvider, RateCard> = {
  anthropic: {
    kind: "published",
    // Anthropic's public per-model list prices, re-verified 2026-08-19 against
    // the model/pricing reference bundled with the `claude-api` skill
    // (shared model table, cached 2026-06-24): haiku-4-5 $1/$5, sonnet-5 $3/$15,
    // opus-4-8 $5/$25 per 1M tokens. Cache ratios are Anthropic's published
    // 5-minute-TTL ones (write 1.25x input, read 0.1x input) — see
    // ANTHROPIC_CACHE. These three are `exact`: a published number, a named
    // source, and a date.
    models: {
      "claude-haiku-4-5": {
        rate: { inputPerM: 1, outputPerM: 5, ...ANTHROPIC_CACHE },
        basis: "exact",
        source: "Anthropic published list price $1/$5 per 1M (verified 2026-08-19)",
      },
      "claude-sonnet-5": {
        rate: { inputPerM: 3, outputPerM: 15, ...ANTHROPIC_CACHE },
        basis: "exact",
        // Standard list price. Anthropic is running an introductory $2/$10
        // through 2026-08-31, so during that window this OVER-counts by 1.5x.
        // Left at list deliberately: over-counting our own spend is the safe
        // direction for an anti-abuse ceiling, and the intro rate expires.
        source:
          "Anthropic published list price $3/$15 per 1M (verified 2026-08-19; intro $2/$10 runs to 2026-08-31, so this over-counts until then)",
      },
      "claude-opus-4-8": {
        rate: { inputPerM: 5, outputPerM: 25, ...ANTHROPIC_CACHE },
        basis: "exact",
        source: "Anthropic published list price $5/$25 per 1M (verified 2026-08-19)",
      },
    },
  },
  openai: {
    kind: "published",
    models: {
      // GPT-5.6 Luna — an example hosted paid model (HOSTED_PAID_MODEL),
      // reached over the OpenAI-compat wire at api.openai.com.
      //
      // `configured`, NOT `exact`, and that is the whole point of ListedRate.
      // The DOLLARS are carried forward unchanged from the old MODEL_RATES so
      // this work does not move the live hosted meter by a micro-dollar — but
      // the cacheRead multiplier (0.1x) is Anthropic's ratio, not OpenAI's, and
      // OpenAI's own cached-input discount is shallower, so a cache-heavy hosted
      // call can UNDER-count here. A rate we cannot cite must not carry the
      // basis that means "this is a bill": it is an operator-maintained number,
      // which is exactly what `configured` means. Promote it to `exact` only
      // together with a cited source and a verified cache multiplier.
      "gpt-5.6-luna": {
        rate: { inputPerM: 1, outputPerM: 6, cacheWriteMultiplier: 1, cacheReadMultiplier: 0.1 },
        basis: "configured",
        source:
          "carried forward from the pre-2026-08-19 MODEL_RATES table; input/output never verified against OpenAI's price list and cacheRead 0.1x is Anthropic's ratio, not OpenAI's",
      },
    },
  },

  openrouter: {
    kind: "unpriced",
    note: "per-model prices vary across ~300 proxied models; set FALLBACK_RATE_USD_PER_M to price an OpenRouter leg",
  },
  unknown: {
    kind: "unpriced",
    note: "base URL not recognised as an account we hold",
  },
};

/** Hostnames that identify a billing account on the OpenAI-compatible wire. */
function billingProviderForHost(host: string): BillingProvider {
  if (host === "api.openai.com" || host.endsWith(".openai.com")) return "openai";
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";

  return "unknown";
}

/**
 * Which account this leg bills. The `anthropic` tag is unambiguous — a
 * deployment that points LLM_BASE_URL at an Anthropic-speaking
 * gateway is still paying Anthropic's per-token list price through it, so the
 * tag is kept and the host ignored. The `openrouter` tag is NOT unambiguous: it
 * means "OpenAI-compatible", and this deployment uses it for OpenAI proper. For
 * that tag only, the host decides.
 */
export function billingProviderFor(leg: { provider?: LlmProvider; baseUrl?: string }): BillingProvider {
  if (leg.provider === "anthropic" || leg.provider === undefined) return "anthropic";

  // provider === "openrouter": OpenAI-compatible wire, account decided by host.
  if (!leg.baseUrl) return "unknown";
  try {
    return billingProviderForHost(new URL(leg.baseUrl).hostname.toLowerCase());
  } catch {
    return "unknown";
  }
}

/** Operator-supplied rates, resolved from env once per request/session. */
export interface PricingOptions {
  /**
   * USD per 1,000,000 tokens, flat across input and output, keyed by billing
   * provider. Overrides a `flat` card's default, supplies a rate for an
   * `unpriced` one, and prices the UNLISTED models of a `published` one (a
   * listed model keeps its own card entry — an operator-wide flat rate must not
   * silently overwrite a cited list price).
   */
  configuredFlatPerM?: Partial<Record<BillingProvider, number>>;
}

/** A flat card: one number for every token, no cache discount. */
function flatRate(perM: number): TokenRate {
  return { inputPerM: perM, outputPerM: perM, cacheWriteMultiplier: 1, cacheReadMultiplier: 1 };
}

function configuredPerM(provider: BillingProvider, opts: PricingOptions | undefined): number | undefined {
  const v = opts?.configuredFlatPerM?.[provider];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * The rate and basis for one provider+model. Exported for the report side and
 * for tests that want to assert the basis without a usage block.
 */
export function rateFor(
  provider: BillingProvider,
  model: string,
  opts?: PricingOptions,
): { rate: TokenRate; basis: PriceBasis } {
  // TOTAL over any string, not just the five keys of the map. Both callers
  // today route through `billingProviderFor`, which is total over the five — but
  // this map is an object literal, so a provider string that is not on it
  // (including an Object.prototype name like "constructor", and including one
  // read back off a persisted usage leg) used to resolve to `undefined` or to
  // an inherited function and THROW a TypeError on `.kind`, taking the meter
  // down rather than degrading it. An unknown provider is exactly what the
  // `unpriced` arm below is for: honour an operator rate if there is one, else
  // price defensively and record the basis as `estimated`.
  const card: RateCard = Object.hasOwn(RATE_CARDS, provider)
    ? RATE_CARDS[provider]
    : { kind: "unpriced", note: "no rate card for this provider" };
  if (card.kind === "published") {
    // OWN PROPERTIES ONLY. `card.models` is an object literal, so a plain
    // `card.models[model]` walks Object.prototype: a model named "constructor",
    // "toString", "valueOf", "__proto__", "hasOwnProperty" … resolved to an
    // inherited function, which is truthy, so the model was reported as LISTED
    // and `basis: "exact"` with a rate object that has no inputPerM/outputPerM.
    // The arithmetic then produced NaN, and the wire/clamp layer turned NaN into
    // 0 — an unknown model priced as a $0.00 bill with exact_fraction 1.0, the
    // precise failure I4 exists to forbid. `Object.hasOwn` is the fix; the
    // finite guard in `priceUsage` is the belt to this pair of braces.
    const listed = Object.hasOwn(card.models, model) ? card.models[model] : undefined;
    if (listed) return { rate: listed.rate, basis: listed.basis };
    // Unlisted on a published card. An operator who supplied a flat rate for
    // this provider (FALLBACK_RATE_USD_PER_M aimed at an Anthropic-compatible
    // gateway, say) gets it honoured here rather than silently dropped — before
    // this, that knob did nothing on a `published` provider and said so nowhere.
    const configured = configuredPerM(provider, opts);
    if (configured !== undefined) return { rate: flatRate(configured), basis: "configured" };
    return { rate: ESTIMATE_RATE, basis: "estimated" };
  }

  const configured = configuredPerM(provider, opts);
  if (configured !== undefined) return { rate: flatRate(configured), basis: "configured" };
  return { rate: ESTIMATE_RATE, basis: "estimated" };
}

/** One usage block, priced. */
export interface PricedUsage {
  provider: BillingProvider;
  model: string;
  /** Integer micro-dollars (1e-6 USD) — the storage unit for the meter. */
  micros: number;
  basis: PriceBasis;
  /** All prompt-side tokens: fresh input + cache writes + cache reads. */
  inputTokens: number;
  outputTokens: number;
}

/**
 * Price one usage block at the provider+model that ACTUALLY served it (BAR I5).
 * Callers pass the {@link import("./client.js").ServedLeg} handed to `onUsage`,
 * which on a failed-over call is the FALLBACK's leg, not the primary's.
 */
export function priceUsage(
  usage: LlmUsage,
  leg: { provider?: LlmProvider; model: string; baseUrl?: string },
  opts?: PricingOptions,
): PricedUsage {
  const provider = billingProviderFor(leg);
  const { rate, basis } = rateFor(provider, leg.model, opts);
  return priceUsageWithRate(usage, { ...leg, provider }, rate, basis);
}

/** Non-finite token counts (a malformed provider body, a NaN out of a bad
 * parse) must not reach the arithmetic — `Math.round(NaN)` is NaN, and the
 * clamp at the storage layer turns NaN into 0, which reads as a $0.00 BILL. */
function finiteTokens(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Price one usage block at an EXPLICIT rate, bypassing the rate cards. The one
 * place the micro-dollar arithmetic happens; {@link priceUsage} is this plus a
 * card lookup. Exported for the shadow price-test harness, whose targets may
 * declare their own operator-supplied rate for a candidate provider we maintain
 * no card for — that used to be a second, provenance-free cost model living in
 * analysis/price-test.ts.
 */
export function priceUsageWithRate(
  usage: LlmUsage,
  leg: { provider: BillingProvider; model: string },
  rate: TokenRate,
  basis: PriceBasis,
): PricedUsage {
  const input = finiteTokens(usage.input_tokens);
  const cacheWrite = finiteTokens(usage.cache_creation_input_tokens);
  const cacheRead = finiteTokens(usage.cache_read_input_tokens);
  const output = finiteTokens(usage.output_tokens);
  const clean: LlmUsage = {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  };
  let micros = usageMicrosAt(
    clean,
    rate.inputPerM,
    rate.outputPerM,
    rate.cacheWriteMultiplier,
    rate.cacheReadMultiplier,
  );
  let finalBasis = basis;
  if (!Number.isFinite(micros)) {
    // Belt and braces for I4: a rate object missing a field (or carrying a NaN)
    // would otherwise yield NaN micros, which the storage clamp silently turns
    // into 0 — an unpriceable call recorded as a $0.00 bill. Re-price
    // defensively and, above all, stop calling it exact.
    micros = usageMicrosAt(
      clean,
      ESTIMATE_RATE.inputPerM,
      ESTIMATE_RATE.outputPerM,
      ESTIMATE_RATE.cacheWriteMultiplier,
      ESTIMATE_RATE.cacheReadMultiplier,
    );
    finalBasis = "estimated";
    if (!Number.isFinite(micros)) micros = 0;
  }
  return {
    provider: leg.provider,
    model: leg.model,
    micros,
    basis: finalBasis,
    inputTokens: input + cacheWrite + cacheRead,
    outputTokens: output,
  };
}

/** Least-trustworthy of two bases, for folding several legs into one bucket:
 * one estimate in the pile makes the pile an estimate. */
export function worseBasis(a: PriceBasis, b: PriceBasis): PriceBasis {
  if (a === "estimated" || b === "estimated") return "estimated";
  if (a === "configured" || b === "configured") return "configured";
  return "exact";
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Operator-configured rates from env. FALLBACK_RATE_USD_PER_M optionally
 * supplies a flat rate for whatever provider
 *    FALLBACK_PROVIDER names. This exists so configuring the fallback leg on
 *    OpenRouter (an `unpriced` card) does not silently meter it at the Sonnet
 *    ESTIMATE_RATE. With it set, that leg prices `configured` instead.
 * Anything unparseable or negative is ignored in favour of the default.
 */
export function pricingOptionsFromEnv(
  env: Pick<Env, "FALLBACK_RATE_USD_PER_M" | "FALLBACK_PROVIDER" | "FALLBACK_BASE_URL">,
): PricingOptions {
  const configuredFlatPerM: Partial<Record<BillingProvider, number>> = {};

  const fallbackRate = positiveNumber(env.FALLBACK_RATE_USD_PER_M);
  if (fallbackRate !== undefined) {
    // Same parser as fallbackLegFor, so an alias the leg accepts ("openai")
    // prices the same account the leg bills.
    const tag = asProvider(env.FALLBACK_PROVIDER);
    if (tag) {
      // Resolve the same way a served leg will, so the configured rate lands on
      // the account the leg actually bills rather than on the wire-protocol tag.
      // The base-URL defaults mirror env.ts's FALLBACK_DEFAULTS: a deployment
      // that sets only FALLBACK_PROVIDER still resolves the same host the leg
      // will call, so its configured rate is not quietly attached to "unknown".
      const defaultBase = tag === "openrouter" ? OPENROUTER_BASE_URL : undefined;
      const provider = billingProviderFor({ provider: tag, baseUrl: env.FALLBACK_BASE_URL || defaultBase });
      configuredFlatPerM[provider] = fallbackRate;
    }
  }
  return { configuredFlatPerM };
}

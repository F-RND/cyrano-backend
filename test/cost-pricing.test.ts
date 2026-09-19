// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// The provider-aware cost model (llm/pricing.ts + llm/spend.ts + usage.ts),
// the cost-pricing contract. What is pinned here:
//
//   D1 / BAR "rates key on provider AND model" — the SAME model id priced
//      through two accounts must produce two different numbers.
//   D2 / I4  NO SILENT MISPRICING — an unknown model still prices defensively
//      high, but never without `basis: "estimated"` attached; configured
//      fallback rates remain explicitly marked `configured`.
//   D3      per-subject breakdown by provider+model, bounded in size.
//   D5      BYOK is zero dollars AND a non-zero call count.
//
// Every micro-dollar figure below is derived by hand from the rate card in the
// comment above it, never from running the implementation.

import { describe, expect, it } from "vitest";
import {
  ESTIMATE_RATE,
  billingProviderFor,
  priceUsage,
  pricingOptionsFromEnv,
  rateFor,
  worseBasis,
} from "../src/llm/pricing.js";
import { createSpendLedger, spendDeltaToWire, usageDeltaFromWire } from "../src/llm/spend.js";
import {
  MAX_USAGE_LEGS,
  OVERFLOW_MODEL,
  OVERFLOW_PROVIDER,
  applyUsage,
  usageView,
  type UsageLeg,
} from "../src/usage.js";
import type { LlmUsage, ServedLeg } from "../src/llm/client.js";

const ZERO: LlmUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

describe("billingProviderFor — the account that gets the invoice, not the wire tag", () => {
  it("resolves the ambiguous `openrouter` tag by host, because an operator may aim it at OpenAI", () => {
    // An operator can set HOSTED_PAID_PROVIDER "openrouter" with
    // HOSTED_PAID_BASE_URL https://api.openai.com/v1. The tag names the wire
    // protocol; the invoice comes from OpenAI. Keying rates on the tag would be
    // defect D1 one level up.
    expect(billingProviderFor({ provider: "openrouter", baseUrl: "https://api.openai.com/v1" })).toBe("openai");
    expect(billingProviderFor({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" })).toBe("openrouter");

  });

  it("keeps the unambiguous tags, and refuses to guess about a host it does not know", () => {
    expect(billingProviderFor({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" })).toBe("anthropic");
    // A gateway in front of Anthropic still bills Anthropic's per-token prices.
    expect(billingProviderFor({ provider: "anthropic", baseUrl: "https://gateway.example/anthropic" })).toBe("anthropic");

    expect(billingProviderFor({ provider: "openrouter", baseUrl: "https://llm.example.test/v1" })).toBe("unknown");
    expect(billingProviderFor({ provider: "openrouter", baseUrl: "not a url" })).toBe("unknown");
  });
});

describe("D1: configured and unconfigured accounts produce different prices", () => {
  // 1,000 fresh input + 500 output, no cache tokens.
  const usage: LlmUsage = { ...ZERO, input_tokens: 1000, output_tokens: 500 };
  // An OpenRouter model NOT on the card (llm/pricing.ts OPENROUTER_LISTINGS),
  // so the operator's flat rate is what prices it. (`openai/gpt-oss-120b` used
  // to play this part; it is listed now, and a listed model keeps its own
  // rate — see "a listed OpenRouter candidate keeps its listed rate" below.)
  const model = "some-lab/unlisted-model";

  it("prices a configured OpenRouter fallback separately from an unconfigured endpoint", () => {
    const configured = priceUsage(
      usage,
      { provider: "openrouter", model, baseUrl: "https://openrouter.ai/api/v1" },
      { configuredFlatPerM: { openrouter: 0.15 } },
    );
    expect(configured).toEqual({
      provider: "openrouter",
      model,
      micros: 225,
      basis: "configured",
      inputTokens: 1000,
      outputTokens: 500,
    });

    const unconfigured = priceUsage(usage, {
      provider: "openrouter",
      model,
      baseUrl: "https://gateway.example/v1",
    });
    expect(unconfigured.micros).toBe(10_500);
    expect(unconfigured.basis).toBe("estimated");
    expect(unconfigured.micros / configured.micros).toBeCloseTo(46.67, 1);
  });
});

describe("I4: nothing is priced silently", () => {
  it("marks an unknown model on a published card as an estimate, at the same defensive rate as before", () => {
    const usage: LlmUsage = { ...ZERO, input_tokens: 1000, output_tokens: 100 };
    const priced = priceUsage(usage, {
      provider: "anthropic",
      model: "claude-not-a-real-model",
      baseUrl: "https://api.anthropic.com/v1",
    });
    // ESTIMATE_RATE is Sonnet: 3 * 1000 + 15 * 100 = 3000 + 1500 = 4500.
    expect(priced.micros).toBe(4500);
    expect(priced.basis).toBe("estimated");
    expect(ESTIMATE_RATE).toMatchObject({ inputPerM: 3, outputPerM: 15 });
  });

  it("marks every OpenRouter model configured when an operator supplies a flat rate", () => {
    const opts = { configuredFlatPerM: { openrouter: 0.15 } };
    for (const model of ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "claude-sonnet-5", ""]) {
      expect(rateFor("openrouter", model, opts).basis).toBe("configured");
    }
    expect(rateFor("openrouter", "anything", opts).rate).toEqual({
      inputPerM: 0.15,
      outputPerM: 0.15,
      cacheWriteMultiplier: 1,
      cacheReadMultiplier: 1,
    });
  });

  it("prices the models we actually run on our own keys, and only cites `exact` where a source exists", () => {
    // Anthropic's three are published list prices with a cited source and a
    // verification date in the rate card (haiku $1/$5, sonnet-5 $3/$15,
    // opus-4-8 $5/$25 per 1M).
    expect(rateFor("anthropic", "claude-sonnet-5").basis).toBe("exact");
    expect(rateFor("anthropic", "claude-haiku-4-5").basis).toBe("exact");
    expect(rateFor("anthropic", "claude-opus-4-8").basis).toBe("exact");
    // wrangler.jsonc HOSTED_PAID_MODEL, reached over the OpenAI-compat wire.
    // "configured", NOT "exact": the rate card's own comment says the number is
    // carried forward unverified and its cacheRead multiplier is Anthropic's
    // ratio, not OpenAI's. A rate we cannot cite must not wear the basis that
    // means "this is a bill" — it is the single rate that prices essentially
    // all real hosted paid spend, so it is exactly the one that drives
    // exact_fraction toward a number nobody can back up.
    //
    // 2026-09-18: VERIFIED against OpenAI's price list
    // (developers.openai.com/api/docs/pricing): Luna is $0.20 / $1.20 per 1M
    // with cached input at $0.02 (0.1x). The carried-forward $1/$6 was 5x too
    // high — every hosted paid session was over-counted 5x, and every budget
    // candidate would have looked 5x better against it than it is. Now `exact`,
    // with the source cited on the card entry.
    expect(rateFor("openai", "gpt-5.6-luna").basis).toBe("exact");
    expect(rateFor("openai", "gpt-5.6-luna").rate).toEqual({
      inputPerM: 0.2,
      outputPerM: 1.2,
      cacheWriteMultiplier: 1,
      cacheReadMultiplier: 0.1,
    });
    // 1M fresh input + 1M cached input + 1M output at Luna's list price:
    // 200,000 + 20,000 + 1,200,000 = 1,420,000 micro-$ ($1.42).
    expect(
      priceUsage(
        { ...ZERO, input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 1_000_000 },
        { provider: "openrouter", model: "gpt-5.6-luna", baseUrl: "https://api.openai.com/v1" },
      ),
    ).toMatchObject({ provider: "openai", micros: 1_420_000, basis: "exact" });
  });

  it("treats an Object.prototype key as an UNKNOWN model, on every published card", () => {
    // A plain `card.models[model]` lookup walks Object.prototype, so each of
    // these resolved to an inherited FUNCTION — truthy — and was reported as a
    // listed model with `basis: "exact"` and no inputPerM/outputPerM. The
    // arithmetic then produced NaN and the storage clamp turned NaN into 0: a
    // model with no known rate priced as a $0.00 BILL with exact_fraction 1.0,
    // which is the worst possible form of the thing I4 forbids.
    const prototypeKeys = [
      "__proto__",
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
      "__defineGetter__",
    ];
    for (const model of prototypeKeys) {
      for (const provider of ["anthropic", "openai"] as const) {
        const { rate, basis } = rateFor(provider, model);
        expect(basis, `${provider}/${model} must not read as listed`).toBe("estimated");
        expect(rate).toEqual(ESTIMATE_RATE);
        // And end to end, through the arithmetic that used to yield NaN.
        const priced = priceUsage(
          { ...ZERO, input_tokens: 2_000_000 },
          {
            provider: provider === "anthropic" ? "anthropic" : "openrouter",
            model,
            baseUrl: provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1",
          },
        );
        expect(Number.isFinite(priced.micros)).toBe(true);
        // 2M tokens at the Sonnet estimate: 3 * 2,000,000 = 6,000,000 micro-$.
        expect(priced.micros).toBe(6_000_000);
        expect(priced.basis).toBe("estimated");
      }
    }
    // The guard does not change a single real model.
    expect(rateFor("anthropic", "claude-sonnet-5").basis).toBe("exact");
  });

  it("a prototype-key model reaches the STORED meter as an estimate, not a $0.00 bill", () => {
    // The end-to-end shape of the defect: 2,000,000 tokens on model "toString"
    // used to persist as spendMicros 0 with basis_micros.exact 0 and
    // exact_fraction 1.0 — a call we cannot price, recorded as a bill of
    // nothing, reported as fully exact.
    const ledger = createSpendLedger();
    ledger.recordServed(
      { ...ZERO, input_tokens: 2_000_000 },
      { provider: "anthropic", model: "toString", baseUrl: "https://api.anthropic.com/v1", fallback: false },
    );
    const state = applyUsage(undefined, usageDeltaFromWire(spendDeltaToWire(ledger.take())), 1_000);
    const view = usageView(state, 1_000);
    expect(view.spendMicros).toBe(6_000_000);
    expect(view.basisMicros).toEqual({ exact: 0, configured: 0, estimated: 6_000_000 });
    expect(view.exactFraction).toBe(0);
    expect(view.legs[0]).toMatchObject({ provider: "anthropic", model: "toString", basis: "estimated" });
  });

  it("never lets a non-finite figure reach the ledger, whatever the usage block says", () => {
    // Belt to the own-property braces: a NaN anywhere in a usage block used to
    // sail through Math.round into the meter, where the clamp silently turned
    // it into a $0.00 bill. Now the tokens are sanitised and the result is
    // checked for finiteness before it can be recorded.
    const poisoned = {
      input_tokens: Number.NaN,
      output_tokens: Number.POSITIVE_INFINITY,
      cache_creation_input_tokens: Number.NaN,
      cache_read_input_tokens: -5,
    };
    const priced = priceUsage(poisoned, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseUrl: "https://api.anthropic.com/v1",
    });
    expect(Number.isFinite(priced.micros)).toBe(true);
    expect(priced.micros).toBe(0);
    expect(priced.inputTokens).toBe(0);
    expect(priced.outputTokens).toBe(0);
  });

  it("honours an operator's configured rate for an UNLISTED model on a published card", () => {
    // FALLBACK_RATE_USD_PER_M aimed at an Anthropic-compatible gateway used to
    // be silently dropped: `rateFor` never consulted configured rates on a
    // `published` card, so the leg priced at the Sonnet ESTIMATE_RATE — 225x
    // the operator's own figure — and nothing said so.
    const opts = pricingOptionsFromEnv({
      FALLBACK_PROVIDER: "anthropic",
      FALLBACK_RATE_USD_PER_M: "0.02",
    } as never);
    const usage: LlmUsage = { ...ZERO, input_tokens: 1000, output_tokens: 100 };
    // 0.02 * 1000 + 0.02 * 100 = 20 + 2 = 22 micro-dollars.
    const priced = priceUsage(
      usage,
      { provider: "anthropic", model: "some-gateway-model", baseUrl: "https://gateway.example/v1" },
      opts,
    );
    expect(priced).toMatchObject({ provider: "anthropic", micros: 22, basis: "configured" });
    // A LISTED model keeps its cited list price — an operator-wide flat rate
    // must not quietly overwrite a published one.
    expect(rateFor("anthropic", "claude-sonnet-5", opts)).toMatchObject({ basis: "exact" });
    expect(rateFor("anthropic", "claude-sonnet-5", opts).rate.inputPerM).toBe(3);
  });

  it("worseBasis folds a mixed bucket down to its least trustworthy member", () => {
    expect(worseBasis("exact", "exact")).toBe("exact");
    expect(worseBasis("exact", "configured")).toBe("configured");
    expect(worseBasis("configured", "estimated")).toBe("estimated");
    expect(worseBasis("estimated", "exact")).toBe("estimated");
  });
});

describe("configured rates from env", () => {
  it("uses an operator's fallback rate and records it as configured", () => {
    const opts = pricingOptionsFromEnv({
      FALLBACK_PROVIDER: "openrouter",
      FALLBACK_RATE_USD_PER_M: "0.08",
    } as never);
    // 1M input + 1M output at a flat 0.08/1M = 80,000 + 80,000 micro-dollars.
    const priced = priceUsage(
      { ...ZERO, input_tokens: 1_000_000, output_tokens: 1_000_000 },
      { provider: "openrouter", model: "some-lab/unlisted-model", baseUrl: "https://openrouter.ai/api/v1" },
      opts,
    );
    expect(priced.micros).toBe(160_000);
    expect(priced.basis).toBe("configured");
  });

  it("prices an UNLISTED OpenRouter FALLBACK leg at its configured rate instead of the Sonnet estimate", () => {
    // Without this knob, an unlisted model uses the defensive estimate.
    const opts = pricingOptionsFromEnv({
      FALLBACK_PROVIDER: "openrouter",
      FALLBACK_RATE_USD_PER_M: "0.5",
    } as never);
    const usage: LlmUsage = { ...ZERO, input_tokens: 1000, output_tokens: 200 };
    // 0.5 * 1000 + 0.5 * 200 = 500 + 100 = 600 micro-dollars.
    const priced = priceUsage(usage, { provider: "openrouter", model: "some-lab/unlisted-model", baseUrl: "https://openrouter.ai/api/v1" }, opts);
    expect(priced).toMatchObject({ provider: "openrouter", micros: 600, basis: "configured" });
  });

  it("a listed OpenRouter candidate keeps its listed rate even when a flat rate is set", () => {
    // The flat rate is per PROVIDER. An operator who set it at $0.15 for a
    // gpt-oss fallback and then points HOSTED_PAID_MODEL at z-ai/glm-4.6 on the
    // same account must not have GLM priced at $0.15 flat — that would
    // under-count the exact comparison this table exists for by 3–10x. Same
    // rule as the Anthropic/OpenAI cards: a listed model keeps its own entry.
    const opts = pricingOptionsFromEnv({
      FALLBACK_PROVIDER: "openrouter",
      FALLBACK_RATE_USD_PER_M: "0.15",
    } as never);
    const usage: LlmUsage = { ...ZERO, input_tokens: 1000, output_tokens: 200 };
    // z-ai/glm-4.6 listed $0.43/$1.75: 430 + 350 = 780 micro-dollars, not 180.
    const priced = priceUsage(usage, { provider: "openrouter", model: "z-ai/glm-4.6", baseUrl: "https://openrouter.ai/api/v1" }, opts);
    expect(priced).toMatchObject({ provider: "openrouter", micros: 780, basis: "configured" });
  });

  it("ignores junk rather than pricing at NaN", () => {
    for (const raw of ["", "abc", "-1", "NaN"]) {
      const opts = pricingOptionsFromEnv({ FALLBACK_PROVIDER: "openrouter", FALLBACK_RATE_USD_PER_M: raw } as never);
      const priced = priceUsage(
        { ...ZERO, input_tokens: 1_000_000 },
        { provider: "openrouter", model: "m", baseUrl: "https://openrouter.ai/api/v1" },
        opts,
      );
      expect(priced.micros).toBe(3_000_000);
      expect(priced.basis).toBe("estimated");
    }
  });
});

describe("D3/D5: the ledger records why, and records BYOK as a fact", () => {
  const fallbackLeg: ServedLeg = {
    provider: "openrouter",
    model: "openai/gpt-oss-120b",
    baseUrl: "https://openrouter.ai/api/v1",
    fallback: true,
  };
  const anthropicLeg: ServedLeg = {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    baseUrl: "https://api.anthropic.com/v1",
    fallback: false,
  };

  it("buckets by provider+model, keeps the total equal to the buckets, and drains once", () => {
    const ledger = createSpendLedger({ configuredFlatPerM: { openrouter: 0.15 } });
    // Anthropic haiku ($1/$5): 1000 in + 100 out = 1000 + 500 = 1500 micro-$.
    ledger.recordServed({ ...ZERO, input_tokens: 1000, output_tokens: 100 }, anthropicLeg);
    // Again, same leg: another 1500.
    ledger.recordServed({ ...ZERO, input_tokens: 1000, output_tokens: 100 }, anthropicLeg);
    // openai/gpt-oss-120b is LISTED on the OpenRouter card ($0.15/$0.60), and a
    // listed model keeps its entry over the operator's flat 0.15:
    // 2000 in + 200 out = 300 + 120 = 420 micro-$.
    ledger.recordServed({ ...ZERO, input_tokens: 2000, output_tokens: 200 }, fallbackLeg);
    ledger.recordByok();

    const delta = ledger.take();
    expect(delta.byokCalls).toBe(1);
    expect(delta.micros).toBe(1500 + 1500 + 420);
    expect(delta.legs).toEqual([
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        calls: 2,
        inputTokens: 2000,
        outputTokens: 200,
        micros: 3000,
        basis: "exact",
      },
      {
        provider: "openrouter",
        model: "openai/gpt-oss-120b",
        calls: 1,
        inputTokens: 2000,
        outputTokens: 200,
        micros: 420,
        basis: "configured",
      },
    ]);
    // Drained: reporting the same delta twice would double a subject's bill.
    expect(ledger.take()).toEqual({ micros: 0, legs: [], byokCalls: 0, shadowMicros: 0 });
  });

  it("a BYOK-only ledger is zero dollars and non-zero activity", () => {
    const ledger = createSpendLedger();
    ledger.recordByok();
    ledger.recordByok();
    expect(ledger.peek()).toEqual({ micros: 0, legs: [], byokCalls: 2, shadowMicros: 0 });
  });

  it("survives the wire round trip that carries it to the registry DO", () => {
    const ledger = createSpendLedger();
    ledger.recordServed({ ...ZERO, input_tokens: 1000, output_tokens: 100 }, anthropicLeg);
    ledger.recordByok();
    const delta = ledger.take();
    expect(usageDeltaFromWire(JSON.parse(JSON.stringify(spendDeltaToWire(delta))))).toEqual(delta);
  });

  it("still meters a legacy body that carries only delta_micros", () => {
    // An older Worker (or a replayed request) sends no legs. The total must
    // still land; the breakdown is simply empty for it.
    expect(usageDeltaFromWire({ delta_micros: 4242 })).toEqual({ micros: 4242, legs: [], byokCalls: 0, shadowMicros: 0 });
  });

  it("recomputes the total from the legs, so a body cannot claim more than it can explain", () => {
    const inflated = usageDeltaFromWire({
      delta_micros: 999_999,
      legs: [{ provider: "openrouter", model: "m", calls: 1, input_tokens: 10, output_tokens: 1, micros: 7, basis: "configured" }],
    });
    expect(inflated.micros).toBe(7);
  });
});

describe("the stored breakdown is bounded", () => {
  const leg = (i: number, micros: number): UsageLeg => ({
    provider: "openrouter",
    model: `model-${i}`,
    calls: 1,
    inputTokens: 10,
    outputTokens: 1,
    micros,
    basis: i === 0 ? "estimated" : "exact",
  });

  it(`caps at ${MAX_USAGE_LEGS} buckets, folding the cheap tail into one and losing NOTHING`, () => {
    // 40 distinct provider+model buckets, ascending in cost.
    const legs = Array.from({ length: 40 }, (_, i) => leg(i, (i + 1) * 100));
    const total = legs.reduce((s, l) => s + l.micros, 0);

    const state = applyUsage(undefined, { micros: total, legs, byokCalls: 0, shadowMicros: 0 }, 1_000);
    const stored = state.legs!;

    expect(stored).toHaveLength(MAX_USAGE_LEGS);
    // Totals are untouched by the fold — this is what keeps I6 true no matter
    // how many models a subject touches.
    expect(stored.reduce((s, l) => s + l.micros, 0)).toBe(total);
    expect(stored.reduce((s, l) => s + l.calls, 0)).toBe(40);
    expect(state.spendMicros).toBe(total);

    // The most expensive buckets keep their identity…
    expect(stored[0]).toMatchObject({ model: "model-39", micros: 4000 });
    // …and exactly one overflow bucket carries the rest, marked with the worst
    // basis it swallowed (model-0 was an estimate).
    const overflow = stored.filter((l) => l.provider === OVERFLOW_PROVIDER && l.model === OVERFLOW_MODEL);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]!.calls).toBe(40 - (MAX_USAGE_LEGS - 1));
    expect(overflow[0]!.basis).toBe("estimated");
  });

  it("keeps folding into the SAME overflow bucket across many reports", () => {
    let state = applyUsage(undefined, { micros: 0, legs: Array.from({ length: 30 }, (_, i) => leg(i, (i + 1) * 10)), byokCalls: 0, shadowMicros: 0 }, 1_000);
    for (let round = 0; round < 5; round++) {
      state = applyUsage(
        state,
        { micros: 0, legs: Array.from({ length: 30 }, (_, i) => leg(i + 100 * round, i + 1)), byokCalls: 0, shadowMicros: 0 },
        1_000,
      );
      expect(state.legs!.length).toBeLessThanOrEqual(MAX_USAGE_LEGS);
    }
  });
});

describe("usageView reports how much of a subject's spend is a real price", () => {
  it("splits attributed micros by basis and computes the exact fraction", () => {
    const legs: UsageLeg[] = [
      { provider: "anthropic", model: "claude-haiku-4-5", calls: 1, inputTokens: 1, outputTokens: 1, micros: 700, basis: "exact" },
      { provider: "openrouter", model: "openai/gpt-oss-120b", calls: 1, inputTokens: 1, outputTokens: 1, micros: 200, basis: "configured" },
      { provider: "unknown", model: "mystery", calls: 1, inputTokens: 1, outputTokens: 1, micros: 100, basis: "estimated" },
    ];
    const state = applyUsage(undefined, { micros: 1000, legs, byokCalls: 3, shadowMicros: 0 }, 1_000);
    const view = usageView(state, 1_000);
    expect(view.spendMicros).toBe(1000);
    expect(view.attributedMicros).toBe(1000);
    expect(view.basisMicros).toEqual({ exact: 700, configured: 200, estimated: 100 });
    expect(view.exactFraction).toBeCloseTo(0.7, 10);
    expect(view.byokCalls).toBe(3);
  });

  it("reports NO DATA rather than 100% exact when nothing is attributed", () => {
    // This used to return 1 ("vacuously true"). It reads as "every one of this
    // subject's micro-dollars is a published list price" — the most reassuring
    // possible answer — at exactly the moment the least is known.
    expect(usageView(undefined, 1_000).exactFraction).toBeNull();
  });

  it("shows legacy spend as unattributed instead of inventing a breakdown for it", () => {
    // A record written before the breakdown existed: spend, no legs. EVERY
    // production subject is in this state for the remainder of its current
    // period after this ships, so this is the common case, not a corner: real
    // spend with no explanation must not report exact_fraction 1.0 beside it.
    const legacy = { periodStart: 1_000, spendMicros: 5000, lifetimeSpendMicros: 5000 };
    const view = usageView(legacy, 1_000);
    expect(view.spendMicros).toBe(5000);
    expect(view.attributedMicros).toBe(0);
    expect(view.legs).toEqual([]);
    expect(view.exactFraction).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TOTALITY AT THE TWO PLACES A STRING OFF STORAGE MEETS AN OBJECT LITERAL.
//
// Neither of these is reachable through a shipped call path today — every
// caller of `rateFor` goes through `billingProviderFor`, which is total over
// the five providers, and every stored leg was normalized on the way in. Both
// are the SAME CLASS as defect D8 (a prototype-named model priced as a $0.00
// bill at basis `exact`), both are one line, and both sit on the path a future
// caller reading a provider or basis back off persisted usage would take.
// ---------------------------------------------------------------------------

describe("an unrecognised provider or basis degrades, never throws and never fabricates `exact`", () => {
  it("rateFor is total over any string, including Object.prototype names", () => {
    for (const provider of ["prototype", "constructor", "then", "toString", "valueOf", "hasOwnProperty", "nope"]) {
      const { rate, basis } = rateFor(provider as never, "claude-sonnet-5");
      // Priced defensively HIGH and labelled as a guess — the `unpriced` arm.
      expect(basis, provider).toBe("estimated");
      expect(rate, provider).toEqual(ESTIMATE_RATE);
    }
  });

  it("…and still honours an operator's configured rate for such a provider", () => {
    const { rate, basis } = rateFor("constructor" as never, "whatever", {
      configuredFlatPerM: { constructor: 0.5 } as never,
    });
    expect(basis).toBe("configured");
    expect(rate.inputPerM).toBe(0.5);
  });

  it("usageView drops an unrecognised basis out of attributed spend rather than counting it exact", () => {
    const legs = [
      { provider: "anthropic", model: "claude-haiku-4-5", calls: 1, inputTokens: 1, outputTokens: 1, micros: 700, basis: "exact" },
      // A leg written by a build that had a basis this one does not know, or a
      // prototype-named string. It must not land in `exact`.
      { provider: "x", model: "y", calls: 1, inputTokens: 1, outputTokens: 1, micros: 300, basis: "constructor" },
    ] as unknown as UsageLeg[];
    const state = { periodStart: 1_000, spendMicros: 1000, lifetimeSpendMicros: 1000, legs };
    const view = usageView(state, 1_000);
    expect(view.basisMicros).toEqual({ exact: 700, configured: 0, estimated: 0 });
    expect(view.attributedMicros).toBe(700);
    // Spend is still reported in full; only the CLAIM about it is withheld.
    expect(view.spendMicros).toBe(1000);
    expect(view.exactFraction).toBe(1);
    expect(view.attributedMicros).toBeLessThan(view.spendMicros);
  });
});

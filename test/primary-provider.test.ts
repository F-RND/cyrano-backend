// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM_PROVIDER on the primary path.
 *
 * Before this, the primary leg (LLM_API_KEY at LLM_BASE_URL) was hard-wired
 * to the native Anthropic Messages API at two call sites, so a self-hoster
 * could not run on OpenAI even though the OpenAI-compatible client existed
 * and served the paid tier. What is pinned here:
 *
 *  - the default is unchanged (unset / unknown → "anthropic"), so an existing
 *    deployment that never sets LLM_PROVIDER behaves byte-for-byte as before;
 *  - "openrouter" puts the primary on the Chat Completions wire at
 *    LLM_BASE_URL VERBATIM — no per-provider base-URL default, ever;
 *  - "openai" is an alias for "openrouter" at every OPERATOR-supplied tag
 *    (LLM_PROVIDER, FALLBACK_PROVIDER, HOSTED_PAID_PROVIDER, price-test
 *    targets), normalised on input so the internal tag never changes — but
 *    where a tag supplies a DEFAULT base URL (fallback, paid tier), the
 *    default follows the raw spelling: "openai" → api.openai.com, never
 *    OpenRouter's root with an OpenAI key;
 *  - an Anthropic client key follows LLM_BASE_URL only while the primary
 *    speaks Anthropic; once the primary is on the other wire it goes to
 *    Anthropic's own root, never to an OpenAI-compatible LLM_BASE_URL;
 *  - the paid tier is resolved in one place for both paths: unset provider
 *    → the primary leg with the paid model; an explicit tag → that wire at
 *    its own host, even when the primary has moved elsewhere.
 *  - the WebSocket path and the HTTP routes resolve the primary leg through
 *    the same function, so they cannot disagree;
 *  - billing follows the base URL's host, so an OpenAI-wire primary pointed
 *    at api.openai.com prices on the OpenAI card with no extra configuration.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { asProvider, callTool, type ToolSchema } from "../src/llm/client.js";
import {
  anthropicBaseUrl,
  clientLeg,
  hostedPaidLeg,
  primaryLeg,
  resolveAnalysisLlmConfig,
  resolveStatelessLlmConfig,
} from "../src/llm/hosted-config.js";
import { billingProviderFor, pricingOptionsFromEnv } from "../src/llm/pricing.js";
import { parsePriceTargets } from "../src/analysis/price-test.js";
import { createSpendLedger } from "../src/llm/spend.js";
import { fallbackLegFor } from "../src/env.js";
import type { Env } from "../src/env.js";
import type { Identity } from "../src/auth.js";

const tool: ToolSchema = {
  name: "extract_things",
  description: "test tool",
  system_prompt: "You extract things.",
  input_schema: { type: "object" },
  output_schema: { type: "object", properties: { things: { type: "array" } }, required: ["things"] },
};

/** An operator / self-host deployment: no paid tier, no fallback. With no
 * fallback configured a failed call makes exactly ONE request, which is what
 * lets the assertions below read the primary's wire shape off the fetch mock. */
const base = {
  LLM_API_KEY: "sk-PRIMARY",
  LLM_BASE_URL: "https://api.anthropic.com/v1",
  LLM_MODEL: "claude-sonnet-5",
} as Env;

const operator: Identity = { kind: "operator" };

afterEach(() => vi.unstubAllGlobals());

describe("asProvider — the one parser for operator-supplied tags", () => {
  it("accepts the two wire tags, and 'openai' as an alias for the OpenAI-compatible wire", () => {
    expect(asProvider("anthropic")).toBe("anthropic");
    expect(asProvider("openrouter")).toBe("openrouter");
    expect(asProvider("openai")).toBe("openrouter");
  });

  it("returns undefined for anything else, so every caller applies its own safe default", () => {
    for (const v of [undefined, "", "OpenAI", "gemini", "uplink", 0, null, {}]) {
      expect(asProvider(v)).toBeUndefined();
    }
  });
});

describe("primaryLeg — LLM_PROVIDER at LLM_BASE_URL, verbatim", () => {
  it("defaults to native Anthropic when LLM_PROVIDER is unset, empty or unknown", () => {
    for (const LLM_PROVIDER of [undefined, "", "groq"]) {
      expect(primaryLeg({ ...base, LLM_PROVIDER } as Env)).toEqual({
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "sk-PRIMARY",
        model: "claude-sonnet-5",
      });
    }
  });

  it("puts the primary on the OpenAI-compatible wire WITHOUT touching the base URL", () => {
    // The operator chose this URL. Unlike the fallback and BYOK legs there is
    // no per-provider default to fall through to, so an "openrouter" tag with
    // an OpenAI URL must reach OpenAI, not openrouter.ai.
    const leg = primaryLeg({ ...base, LLM_PROVIDER: "openrouter", LLM_BASE_URL: "https://api.openai.com/v1" } as Env);
    expect(leg).toMatchObject({ provider: "openrouter", baseUrl: "https://api.openai.com/v1" });
  });

  it("treats 'openai' exactly as 'openrouter'", () => {
    const openai = primaryLeg({ ...base, LLM_PROVIDER: "openai", LLM_BASE_URL: "https://api.openai.com/v1" } as Env);
    const openrouter = primaryLeg({ ...base, LLM_PROVIDER: "openrouter", LLM_BASE_URL: "https://api.openai.com/v1" } as Env);
    expect(openai).toEqual(openrouter);
    expect(openai.provider).toBe("openrouter");
  });
});

describe("the primary path on the wire, through the real HTTP-route resolver", () => {
  async function firstRequest(env: Env): Promise<{ url: string; headers: Record<string, string> }> {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = resolveAnalysisLlmConfig(env, null, operator, createSpendLedger());
    await expect(callTool(config, tool, {})).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    return { url, headers: init.headers as Record<string, string> };
  }

  it("unset → native Messages API: /messages with x-api-key", async () => {
    const { url, headers } = await firstRequest(base);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe("sk-PRIMARY");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("openrouter → Chat Completions at the operator's URL: /chat/completions with Bearer", async () => {
    const { url, headers } = await firstRequest({
      ...base,
      LLM_PROVIDER: "openrouter",
      LLM_BASE_URL: "https://api.openai.com/v1",
      LLM_MODEL: "gpt-5.6-luna",
    } as Env);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headers["authorization"]).toBe("Bearer sk-PRIMARY");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("'openai' alias → the same request", async () => {
    const { url, headers } = await firstRequest({
      ...base,
      LLM_PROVIDER: "openai",
      LLM_BASE_URL: "https://api.openai.com/v1",
    } as Env);
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headers["authorization"]).toBe("Bearer sk-PRIMARY");
  });

  it("an OpenAI-wire primary pointed at api.openai.com prices on the OpenAI card with no extra config", () => {
    const config = resolveAnalysisLlmConfig(
      { ...base, LLM_PROVIDER: "openrouter", LLM_BASE_URL: "https://api.openai.com/v1" } as Env,
      null,
      operator,
      createSpendLedger(),
    );
    expect(billingProviderFor(config)).toBe("openai");
  });

  it("the paid hosted tier still overrides the primary for an owned identity, and takes the alias too", () => {
    const owner: Identity = { kind: "user", userId: "u_paid" };
    const env = {
      ...base,
      LLM_PROVIDER: "anthropic",
      HOSTED_PAID_MODEL: "gpt-5.6-luna",
      HOSTED_PAID_PROVIDER: "openai",
      HOSTED_PAID_BASE_URL: "https://api.openai.com/v1",
      HOSTED_PAID_KEY_ENV: "OPENAI_API_KEY",
      OPENAI_API_KEY: "sk-PAID",
    } as Env;
    expect(resolveAnalysisLlmConfig(env, null, owner, createSpendLedger())).toMatchObject({
      provider: "openrouter",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-PAID",
      model: "gpt-5.6-luna",
    });
    // …and a non-owned identity on the same deployment is unaffected by it.
    expect(resolveAnalysisLlmConfig(env, null, operator, createSpendLedger())).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-PRIMARY",
      model: "claude-sonnet-5",
    });
  });
});

describe("the alias reaches every other operator-supplied tag", () => {
  it("FALLBACK_PROVIDER=openai builds an openrouter-wire leg — at api.openai.com, not OpenRouter", () => {
    const env = {
      ...base,
      FALLBACK_MODEL: "gpt-5.6-luna",
      FALLBACK_KEY_ENV: "OPENAI_API_KEY",
      OPENAI_API_KEY: "sk-fallback",
    };
    const viaAlias = fallbackLegFor({ ...env, FALLBACK_PROVIDER: "openai" } as Env, { usingClientKey: false });
    const viaTag = fallbackLegFor({ ...env, FALLBACK_PROVIDER: "openrouter" } as Env, { usingClientKey: false });
    // Same wire, same key, same model…
    expect(viaAlias).toMatchObject({ provider: "openrouter", apiKey: "sk-fallback", model: "gpt-5.6-luna" });
    expect(viaTag).toMatchObject({ provider: "openrouter", apiKey: "sk-fallback", model: "gpt-5.6-luna" });
    // …but the default HOST follows the raw tag. Folding the alias onto
    // OpenRouter's root would send the OpenAI key named above to OpenRouter.
    expect(viaAlias!.baseUrl).toBe("https://api.openai.com/v1");
    expect(viaTag!.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("an explicit FALLBACK_BASE_URL still wins over the tag's default under either spelling", () => {
    const env = {
      ...base,
      FALLBACK_PROVIDER: "openai",
      FALLBACK_BASE_URL: "https://gateway.example/openai/v1",
      FALLBACK_MODEL: "gpt-5.6-luna",
      FALLBACK_KEY_ENV: "OPENAI_API_KEY",
      OPENAI_API_KEY: "sk-fallback",
    } as Env;
    expect(fallbackLegFor(env, { usingClientKey: false })!.baseUrl).toBe("https://gateway.example/openai/v1");
  });

  it("a configured fallback rate with only FALLBACK_PROVIDER=openai lands on the OpenAI account", () => {
    // Mirrors the leg above: no base URL, so the pricing side must resolve the
    // same default host the leg will call, or the rate attaches to OpenRouter.
    const opts = pricingOptionsFromEnv({ FALLBACK_PROVIDER: "openai", FALLBACK_RATE_USD_PER_M: "0.5" });
    expect(opts.configuredFlatPerM).toEqual({ openai: 0.5 });
    const viaTag = pricingOptionsFromEnv({ FALLBACK_PROVIDER: "openrouter", FALLBACK_RATE_USD_PER_M: "0.5" });
    expect(viaTag.configuredFlatPerM).toEqual({ openrouter: 0.5 });
  });

  it("a configured fallback rate under the alias lands on the account the leg bills", () => {
    const opts = pricingOptionsFromEnv({
      FALLBACK_PROVIDER: "openai",
      FALLBACK_BASE_URL: "https://api.openai.com/v1",
      FALLBACK_RATE_USD_PER_M: "0.5",
    });
    expect(opts.configuredFlatPerM).toEqual({ openai: 0.5 });
  });

  it("a price-test target may say 'openai'; it is stored under the internal tag", () => {
    const targets = parsePriceTargets({
      PRICE_TEST_TARGETS: JSON.stringify([
        { label: "oai", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-luna", keyEnv: "OPENAI_API_KEY" },
        { label: "bad", provider: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "m", keyEnv: "K" },
      ]),
    } as Env);
    expect(targets.map((t) => [t.label, t.provider])).toEqual([["oai", "openrouter"]]);
  });
});

describe("an Anthropic client key never follows the primary onto the other wire", () => {
  const openaiPrimary = {
    ...base,
    LLM_PROVIDER: "openrouter",
    LLM_BASE_URL: "https://api.openai.com/v1",
    LLM_API_KEY: "sk-OPENAI-PRIMARY",
  } as Env;
  const gatewayPrimary = { ...base, LLM_BASE_URL: "https://gateway.example/anthropic/v1" } as Env;

  it("follows LLM_BASE_URL while the primary is Anthropic (a gateway deployment keeps working)", () => {
    expect(anthropicBaseUrl(gatewayPrimary)).toBe("https://gateway.example/anthropic/v1");
    expect(clientLeg(gatewayPrimary, "anthropic")).toEqual({
      provider: "anthropic",
      baseUrl: "https://gateway.example/anthropic/v1",
    });
    expect(clientLeg(gatewayPrimary, undefined)).toEqual(clientLeg(gatewayPrimary, "anthropic"));
  });

  it("goes to Anthropic's own root once LLM_BASE_URL is an OpenAI-compatible endpoint", () => {
    expect(anthropicBaseUrl(openaiPrimary)).toBe("https://api.anthropic.com/v1");
    for (const raw of ["anthropic", undefined, "", "typo"]) {
      expect(clientLeg(openaiPrimary, raw)).toEqual({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" });
    }
  });

  it("/analyze BYOK with an omitted llm_provider on an OpenAI-wire primary: Anthropic wire, Anthropic host, client key", () => {
    const config = resolveAnalysisLlmConfig(openaiPrimary, { llm_api_key: "sk-ant-CLIENT" }, operator, createSpendLedger());
    expect(config).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-CLIENT",
      model: "claude-sonnet-5",
    });
    expect(config.fallback).toBeUndefined();
  });

  it("the OpenAI-compatible client selections are untouched by where the primary lives", () => {
    expect(clientLeg(openaiPrimary, "openai")).toEqual({ provider: "openrouter", baseUrl: "https://api.openai.com/v1" });
    expect(clientLeg(openaiPrimary, "openrouter")).toEqual({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
  });

  it("the stateless routes: hosted runs the primary's WIRE, BYOK is an Anthropic key on the Anthropic host", () => {
    const hosted = resolveStatelessLlmConfig(openaiPrimary, undefined, createSpendLedger());
    expect(hosted).toMatchObject({
      provider: "openrouter",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-OPENAI-PRIMARY",
      model: "claude-sonnet-5",
    });
    const byok = resolveStatelessLlmConfig(openaiPrimary, "sk-ant-CLIENT", createSpendLedger());
    expect(byok).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-CLIENT",
    });
    expect(byok.fallback).toBeUndefined();
    // And the default deployment is byte-for-byte what it was: Anthropic at
    // LLM_BASE_URL for both, only the key differing.
    expect(resolveStatelessLlmConfig(gatewayPrimary, undefined, createSpendLedger())).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://gateway.example/anthropic/v1",
      apiKey: "sk-PRIMARY",
    });
    expect(resolveStatelessLlmConfig(gatewayPrimary, "sk-ant-CLIENT", createSpendLedger())).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://gateway.example/anthropic/v1",
      apiKey: "sk-ant-CLIENT",
    });
  });
});

describe("hostedPaidLeg — the paid tier, resolved once for the WebSocket and HTTP paths", () => {
  const owner: Identity = { kind: "user", userId: "u_paid" };
  const paid = { ...base, HOSTED_PAID_MODEL: "claude-haiku-4-5-20251001" } as Env;

  it("not owned, or no paid model: the primary leg exactly", () => {
    expect(hostedPaidLeg(paid, false)).toEqual(primaryLeg(paid));
    expect(hostedPaidLeg(base, true)).toEqual(primaryLeg(base));
  });

  it("owned with no HOSTED_PAID_PROVIDER: the primary endpoint and wire, paid model — unchanged on an Anthropic primary", () => {
    expect(hostedPaidLeg(paid, true)).toEqual({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-PRIMARY",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("owned with no HOSTED_PAID_PROVIDER on an OpenAI-wire primary: follows the primary's wire, because that is what LLM_BASE_URL speaks", () => {
    const env = {
      ...paid,
      LLM_PROVIDER: "openrouter",
      LLM_BASE_URL: "https://api.openai.com/v1",
      HOSTED_PAID_MODEL: "gpt-5.6-luna",
    } as Env;
    expect(hostedPaidLeg(env, true)).toEqual({
      provider: "openrouter",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-PRIMARY",
      model: "gpt-5.6-luna",
    });
  });

  it("HOSTED_PAID_PROVIDER=anthropic pins the paid tier to Anthropic after the primary moves", () => {
    const env = {
      ...paid,
      LLM_PROVIDER: "openrouter",
      LLM_BASE_URL: "https://api.openai.com/v1",
      HOSTED_PAID_PROVIDER: "anthropic",
      HOSTED_PAID_KEY_ENV: "ANTHROPIC_API_KEY",
      ANTHROPIC_API_KEY: "sk-ant-PAID",
    } as Env;
    expect(hostedPaidLeg(env, true)).toEqual({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-PAID",
      model: "claude-haiku-4-5-20251001",
    });
    // On an Anthropic primary the explicit tag follows LLM_BASE_URL, as the
    // unset case always has — an AI Gateway deployment sees no change.
    const gateway = { ...paid, LLM_BASE_URL: "https://gateway.example/anthropic/v1", HOSTED_PAID_PROVIDER: "anthropic" } as Env;
    expect(hostedPaidLeg(gateway, true).baseUrl).toBe("https://gateway.example/anthropic/v1");
  });

  it("HOSTED_PAID_PROVIDER=openai with no base URL goes to api.openai.com, not OpenRouter", () => {
    const env = {
      ...paid,
      HOSTED_PAID_MODEL: "gpt-5.6-luna",
      HOSTED_PAID_PROVIDER: "openai",
      HOSTED_PAID_KEY_ENV: "OPENAI_API_KEY",
      OPENAI_API_KEY: "sk-PAID",
    } as Env;
    const expected = {
      provider: "openrouter",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-PAID",
      model: "gpt-5.6-luna",
    };
    expect(hostedPaidLeg(env, true)).toEqual(expected);
    expect(hostedPaidLeg({ ...env, HOSTED_PAID_PROVIDER: "openrouter" } as Env, true).baseUrl).toBe(
      "https://openrouter.ai/api/v1",
    );
    // Both entry points agree, by construction.
    expect(resolveAnalysisLlmConfig(env, null, owner, createSpendLedger())).toMatchObject(expected);
  });

  it("an unknown HOSTED_PAID_PROVIDER is treated as unset, not as a wire", () => {
    expect(hostedPaidLeg({ ...paid, HOSTED_PAID_PROVIDER: "OpenAI" } as Env, true)).toEqual(hostedPaidLeg(paid, true));
  });
});

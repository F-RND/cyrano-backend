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
 *    targets), normalised on input so the internal tag never changes;
 *  - the WebSocket path and the HTTP routes resolve the primary leg through
 *    the same function, so they cannot disagree;
 *  - billing follows the base URL's host, so an OpenAI-wire primary pointed
 *    at api.openai.com prices on the OpenAI card with no extra configuration.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { asProvider, callTool, type ToolSchema } from "../src/llm/client.js";
import { primaryLeg, resolveAnalysisLlmConfig } from "../src/llm/hosted-config.js";
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
  it("FALLBACK_PROVIDER=openai builds the same leg as openrouter", () => {
    const env = {
      ...base,
      FALLBACK_MODEL: "openai/gpt-oss-120b",
      FALLBACK_KEY_ENV: "OPENROUTER_API_KEY",
      OPENROUTER_API_KEY: "sk-fallback",
    };
    const viaAlias = fallbackLegFor({ ...env, FALLBACK_PROVIDER: "openai" } as Env, { usingClientKey: false });
    const viaTag = fallbackLegFor({ ...env, FALLBACK_PROVIDER: "openrouter" } as Env, { usingClientKey: false });
    expect(viaAlias).toBeDefined();
    expect(viaAlias).toEqual(viaTag);
    expect(viaAlias!.provider).toBe("openrouter");
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

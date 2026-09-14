// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * BYOK with an OpenAI key: `llm_provider: "openai"`.
 *
 * Before this a client could bring an Anthropic or an OpenRouter key but not
 * an OpenAI one — "openrouter" was hard-wired to openrouter.ai, and there was
 * no way to say "same wire, OpenAI's host". Pinned here:
 *
 *  - "openai" resolves to Chat Completions at api.openai.com, on BOTH client
 *    paths (WebSocket sessionLlmConfig and the HTTP resolveAnalysisLlmConfig),
 *    through the one function that owns the mapping;
 *  - "openrouter" and "anthropic" resolve exactly as before, and anything
 *    unrecognised is still "anthropic" — an old client is unaffected;
 *  - BYOK invariant I3 (a client key is never failed over onto ours) keys off
 *    the presence of the client key, not the provider — so it holds for
 *    "openai" without any new code, and this says so.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_BASE_URL, OPENROUTER_BASE_URL, callTool, type ToolSchema } from "../src/llm/client.js";
import { clientLeg, resolveAnalysisLlmConfig } from "../src/llm/hosted-config.js";
import { createSpendLedger } from "../src/llm/spend.js";
import { sessionLlmConfig } from "../src/session-do.js";
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

/** A deployment with a fallback leg CONFIGURED, so the I3 assertions below
 * cannot pass vacuously: if the BYOK branch ever consulted the env, this env
 * would hand it a leg. */
const env = {
  LLM_API_KEY: "sk-OURS",
  LLM_BASE_URL: "https://gateway.example/anthropic/v1",
  LLM_MODEL: "claude-sonnet-5",
  FALLBACK_PROVIDER: "openrouter",
  FALLBACK_MODEL: "openai/gpt-oss-120b",
  FALLBACK_KEY_ENV: "OPENROUTER_API_KEY",
  OPENROUTER_API_KEY: "sk-openrouter",
} as Env;

const user: Identity = { kind: "user", userId: "u_1" };
const CLIENT_KEY = "sk-USERS-OPENAI-KEY";
const hostedLeg = { provider: "anthropic" as const, baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY, model: env.LLM_MODEL };
const meters = () => ({ addUnits: () => {}, spend: createSpendLedger(), noteLeg: () => {} });

afterEach(() => vi.unstubAllGlobals());

it("proof the env is armed — otherwise every I3 assertion below is vacuous", () => {
  expect(fallbackLegFor(env, { usingClientKey: false })).toMatchObject({ apiKey: "sk-openrouter" });
});

describe("clientLeg — the one mapping from a client's llm_provider to a destination", () => {
  it("openai → Chat Completions at api.openai.com", () => {
    expect(clientLeg(env, "openai")).toEqual({ provider: "openrouter", baseUrl: OPENAI_BASE_URL });
  });

  it("openrouter → Chat Completions at openrouter.ai, unchanged", () => {
    expect(clientLeg(env, "openrouter")).toEqual({ provider: "openrouter", baseUrl: OPENROUTER_BASE_URL });
  });

  it("anthropic, absent, or unrecognised → native Messages API at the operator's LLM_BASE_URL, unchanged", () => {
    // A BYOK Anthropic key follows the operator's gateway, as it always has.
    for (const raw of ["anthropic", undefined, null, "", "OpenAI", "gemini"]) {
      expect(clientLeg(env, raw)).toEqual({ provider: "anthropic", baseUrl: "https://gateway.example/anthropic/v1" });
    }
  });
});

describe("an OpenAI key on the wire, from both client paths", () => {
  async function firstRequest(config: Parameters<typeof callTool>[0], fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock);
    // 402 is on the failover trigger list: a wrongly-resolved fallback WOULD fire.
    await expect(callTool(config, tool, {})).rejects.toThrow(/402/);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const wire = JSON.stringify(fetchMock.mock.calls);
    expect(wire).not.toContain("sk-OURS");
    expect(wire).not.toContain("sk-openrouter");
    return { url, headers: init.headers as Record<string, string> };
  }

  it("/analyze + /ask: api.openai.com/chat/completions, Bearer <client key>, no fallback, nothing of ours", async () => {
    const config = resolveAnalysisLlmConfig(
      env,
      { llm_api_key: CLIENT_KEY, llm_provider: "openai", llm_model: "gpt-5.6-luna" },
      user,
      createSpendLedger(),
    );
    expect(config).toMatchObject({ provider: "openrouter", baseUrl: OPENAI_BASE_URL, apiKey: CLIENT_KEY, model: "gpt-5.6-luna" });
    expect(config.fallback).toBeUndefined();

    const { url, headers } = await firstRequest(config, vi.fn(async () => new Response("insufficient_quota", { status: 402 })));
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headers["authorization"]).toBe(`Bearer ${CLIENT_KEY}`);
  });

  it("WebSocket session (hello.llm_provider): the same destination, the same invariant", async () => {
    const config = sessionLlmConfig(env, { apiKey: CLIENT_KEY, provider: "openai", model: "gpt-5.6-luna" }, hostedLeg, meters());
    expect(config).toMatchObject({ provider: "openrouter", baseUrl: OPENAI_BASE_URL, apiKey: CLIENT_KEY, model: "gpt-5.6-luna" });
    expect(config.fallback).toBeUndefined();

    const { url, headers } = await firstRequest(config, vi.fn(async () => new Response("insufficient_quota", { status: 402 })));
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headers["authorization"]).toBe(`Bearer ${CLIENT_KEY}`);
  });

  it("an old client that never sends llm_provider still gets Anthropic at the operator's URL", () => {
    const config = sessionLlmConfig(env, { apiKey: CLIENT_KEY, provider: null, model: null }, hostedLeg, meters());
    expect(config).toMatchObject({ provider: "anthropic", baseUrl: "https://gateway.example/anthropic/v1", model: env.LLM_MODEL });
  });
});

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// The never-default OpenRouter fallback leg (llm/client.ts + env.ts
// `fallbackLegFor`). Companion to llm-client.test.ts, which pins the primary
// wire shape; this file pins the three invariants from
// the failover contract that a fallback leg is allowed to exist under:
//
//   I1  DEFAULT UNCHANGED     — fallback configured + primary healthy ⇒ the
//                               outbound primary request is byte-identical.
//   I2  OFF BY DEFAULT        — no FALLBACK_* env ⇒ inert, one attempt, same error.
//   I3  NEVER FAIL OVER BYOK  — a client-supplied key is never swapped for ours.
//
// plus the failover trigger table itself, because a trigger that is too narrow
// (5xx-only) would not have fired for the situation this was built for — an
// Anthropic key out of credit, which arrives as a 400.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_TIMEOUT_MS,
  LlmCallError,
  OPENROUTER_BASE_URL,
  callTool,
  isReasoningBudgetModel,
  isRetryableStatus,
  resetFailoverLogThrottle,
  shouldFailOver,
  type FallbackLeg,
  type LlmConfig,
  type LlmUsage,
  type ServedLeg,
  type ToolSchema,
} from "../src/llm/client.js";
import { namedEnvKey, resolveAnalysisLlmConfig, resolveStatelessLlmConfig } from "../src/llm/hosted-config.js";
import { createSpendLedger } from "../src/llm/spend.js";
import { pricingOptionsFromEnv } from "../src/llm/pricing.js";
import { isRetryableFailure, sessionLlmConfig } from "../src/session-do.js";
import { fallbackLegFor } from "../src/env.js";
import type { Env } from "../src/env.js";
import type { Identity } from "../src/auth.js";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

/** Every .ts file under src/, so a `fallback:` in a module nobody thought to
 * list (a new route file, the MCP surface, a titler) cannot slip past. */
function srcFiles(dir = SRC_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return srcFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** The single `fallback:` in src/ that is a TYPE, not an assignment: the
 * boolean on ServedLeg. Pinned verbatim so it cannot grow into a hiding place
 * for a hand-rolled leg. */
const FALLBACK_TYPE_LINES = new Set(["fallback: boolean;"]);

/** `fallbackLegFor(env, { usingClientKey: <verdict> })` — capturing the verdict,
 * which is the whole invariant and the one thing a callee-name grep is blind
 * to. Also accepts the shorthand `{ usingClientKey }`. */
const FALLBACK_CALL =
  /^fallback:\s*fallbackLegFor\(\s*(?:env|this\.env)\s*,\s*\{\s*usingClientKey(?::\s*([^}]+?))?\s*\}\s*\)\s*,?$/;

interface FallbackSite {
  file: string;
  line: number;
  text: string;
  /** The argument that decides I3, or null if this is not a fallbackLegFor call. */
  verdict: string | null;
}

/** Every `fallback:` assignment in src/, with the verdict it passes. */
function fallbackAssignments(): FallbackSite[] {
  const sites: FallbackSite[] = [];
  for (const file of srcFiles()) {
    const rel = path.relative(SRC_ROOT, file);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((raw, i) => {
        const text = raw.trim();
        if (!/^fallback:/.test(text)) return;
        if (FALLBACK_TYPE_LINES.has(text)) return;
        const m = FALLBACK_CALL.exec(text);
        sites.push({
          file: rel,
          line: i + 1,
          text,
          verdict: m ? (m[1] ?? "usingClientKey").trim() : null,
        });
      });
  }
  return sites;
}

const tool: ToolSchema = {
  name: "extract_things",
  description: "test tool",
  system_prompt: "You extract things.",
  input_schema: { type: "object" },
  output_schema: {
    type: "object",
    properties: { things: { type: "array", items: { type: "string" } } },
    required: ["things"],
  },
};

/** The hosted primary as it is configured today: native Anthropic Messages. */
const primary: LlmConfig = {
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "sk-primary",
  model: "claude-sonnet-5",
};

const FALLBACK_MODEL = "openai/gpt-oss-120b";

/** A fully-formed OpenRouter fallback leg, as `fallbackLegFor` would build it. */
const fallbackLeg: FallbackLeg = {
  provider: "openrouter",
  baseUrl: OPENROUTER_BASE_URL,
  apiKey: "sk-openrouter",
  model: FALLBACK_MODEL,
  timeoutMs: FALLBACK_TIMEOUT_MS,
};

function anthropicOk(input: unknown, usage?: Record<string, number>): Response {
  return new Response(
    JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", name: tool.name, input }], usage }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function openAiCompatOk(input: unknown, usage?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "tool_calls",
          message: { tool_calls: [{ function: { name: tool.name, arguments: JSON.stringify(input) } }] },
        },
      ],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Anthropic's real out-of-credit reply: a 400, not a 402 and not a 5xx. */
function creditExhausted(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** The parts of an outbound request that must not move: URL, method, headers,
 * body. Deliberately excludes `signal`, which is a fresh object per call. */
function wireOf(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0) {
  const [url, init] = fetchMock.mock.calls[callIndex]! as unknown as [string, RequestInit];
  return { url, method: init.method, headers: init.headers, body: init.body };
}

/** The URL of the nth outbound fetch. (`vi.fn(async () => …)` types its own
 * `mock.calls` as zero-arg, so the real arguments need naming here.) */
function urlOf(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): string {
  return (fetchMock.mock.calls[callIndex]! as unknown as [string, RequestInit])[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
  // The failover log line is throttled per isolate; without this one test's
  // log would suppress the next test's and the count assertions would drift.
  resetFailoverLogThrottle();
});

// ---------------------------------------------------------------------------
// I1 — DEFAULT UNCHANGED
// ---------------------------------------------------------------------------

describe("I1: configuring a fallback does not change the primary request", () => {
  it("sends a byte-identical Anthropic request with and without a fallback configured", async () => {
    const bare = vi.fn(async () => anthropicOk({ things: ["a"] }));
    vi.stubGlobal("fetch", bare);
    await callTool(primary, tool, { hello: "world" });

    const withFallback = vi.fn(async () => anthropicOk({ things: ["a"] }));
    vi.stubGlobal("fetch", withFallback);
    await callTool({ ...primary, fallback: fallbackLeg }, tool, { hello: "world" });

    expect(wireOf(withFallback)).toEqual(wireOf(bare));
    // Sanity: the comparison is against the real shape, not two empty objects.
    expect(wireOf(bare).url).toBe("https://api.anthropic.com/v1/messages");
    expect((wireOf(bare).headers as Record<string, string>)["x-api-key"]).toBe("sk-primary");
  });

  it("sends a byte-identical OpenAI-compat request with and without a fallback (the live hosted leg)", async () => {
    // What ships today: HOSTED_PAID_PROVIDER=openrouter pointed at OpenAI.
    const hosted: LlmConfig = {
      provider: "openrouter",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-openai",
      model: "gpt-5.6-luna",
    };
    const bare = vi.fn(async () => openAiCompatOk({ things: ["a"] }));
    vi.stubGlobal("fetch", bare);
    await callTool(hosted, tool, { hello: "world" });

    const withFallback = vi.fn(async () => openAiCompatOk({ things: ["a"] }));
    vi.stubGlobal("fetch", withFallback);
    await callTool({ ...hosted, fallback: fallbackLeg }, tool, { hello: "world" });

    expect(wireOf(withFallback)).toEqual(wireOf(bare));
    // The OpenRouter attribution header must survive: it is part of "today".
    expect((wireOf(bare).headers as Record<string, string>)["x-title"]).toBe("Cyrano");
  });

  it("never touches the fallback while the primary is healthy — exactly one fetch", async () => {
    const fetchMock = vi.fn(async () => anthropicOk({ things: ["a"] }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await callTool<{ things: string[] }>({ ...primary, fallback: fallbackLeg }, tool, {});
    expect(out.things).toEqual(["a"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(urlOf(fetchMock, 0)).toBe("https://api.anthropic.com/v1/messages");
  });

  // The three tests above compare new-code-with-fallback against
  // new-code-WITHOUT-fallback. That can only ever catch a change CONDITIONAL on
  // `fallback` being present — it is blind to an unconditional wire change,
  // which is exactly what "byte-identical to today's" forbids. These two pin
  // the literal bytes instead, so any edit that moves the default request has
  // to move a golden string in a test named I1 and explain itself.
  it("I1 golden: the default Anthropic request is these exact bytes", async () => {
    const fetchMock = vi.fn(async () => anthropicOk({ things: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await callTool({ ...primary, fallback: fallbackLeg }, tool, { hello: "world" }, { maxTokens: 2048 });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "sk-primary",
      "anthropic-version": "2023-06-01",
    });
    expect(init.body).toBe(
      '{"model":"claude-sonnet-5","max_tokens":2048,"system":[{"type":"text","text":"You extract things.","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":"{\\"hello\\":\\"world\\"}"}],"tools":[{"name":"extract_things","description":"test tool","input_schema":{"type":"object","properties":{"things":{"type":"array","items":{"type":"string"}}},"required":["things"]}}],"tool_choice":{"type":"tool","name":"extract_things"}}',
    );
  });

  it("I1 golden: the hosted OpenAI-compat request is these exact bytes", async () => {
    // HOSTED_PAID_PROVIDER=openrouter pointed at OpenAI, model gpt-5.6-luna —
    // what actually ships. Pins the x-title header and the gpt-5 branch's
    // max_completion_tokens/reasoning_effort, so the gpt-oss headroom branch
    // added beside it cannot bleed into this one.
    const hosted: LlmConfig = {
      provider: "openrouter",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-openai",
      model: "gpt-5.6-luna",
    };
    const fetchMock = vi.fn(async () => openAiCompatOk({ things: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await callTool({ ...hosted, fallback: fallbackLeg }, tool, { hello: "world" }, { maxTokens: 2048 });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sk-openai",
      "x-title": "Cyrano",
    });
    expect(init.body).toBe(
      '{"model":"gpt-5.6-luna","messages":[{"role":"system","content":"You extract things."},{"role":"user","content":"{\\"hello\\":\\"world\\"}"}],"tools":[{"type":"function","function":{"name":"extract_things","description":"test tool","parameters":{"type":"object","properties":{"things":{"type":"array","items":{"type":"string"}}},"required":["things"]}}}],"tool_choice":{"type":"function","function":{"name":"extract_things"}},"max_completion_tokens":4096,"reasoning_effort":"none"}',
    );
  });

  it("leaves the primary's own timeout budget alone (the fallback carries its own)", async () => {
    // The fallback's tighter budget must not leak onto the primary attempt: a
    // 15s primary would be a behaviour change on every healthy call.
    vi.stubGlobal("fetch", vi.fn(async () => anthropicOk({ things: [] })));
    const spy = vi.spyOn(AbortSignal, "timeout");
    await callTool({ ...primary, fallback: { ...fallbackLeg, timeoutMs: 1234 } }, tool, {});
    expect((spy.mock.calls as unknown as number[][]).map((c) => c[0])).toEqual([30_000]);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// I2 — OFF BY DEFAULT
// ---------------------------------------------------------------------------

describe("I2: with no FALLBACK_* env, the feature is entirely inert", () => {
  const bare = {} as Env;

  it("fallbackLegFor returns undefined for an env with no FALLBACK_* at all", () => {
    expect(fallbackLegFor(bare, { usingClientKey: false })).toBeUndefined();
  });

  it("returns undefined for every half-configured env (fails closed, never guesses)", () => {
    // Provider named but no key anywhere.
    expect(
      fallbackLegFor({ FALLBACK_PROVIDER: "openrouter" } as Env, { usingClientKey: false }),
    ).toBeUndefined();
    // Key present but no provider named.
    expect(
      fallbackLegFor({ OPENROUTER_API_KEY: "sk-x" } as Env, { usingClientKey: false }),
    ).toBeUndefined();
    // Key present but empty.
    expect(
      fallbackLegFor({ FALLBACK_PROVIDER: "openrouter", OPENROUTER_API_KEY: "" } as Env, {
        usingClientKey: false,
      }),
    ).toBeUndefined();
    // Unknown provider string.
    expect(
      fallbackLegFor({ FALLBACK_PROVIDER: "groq", OPENROUTER_API_KEY: "sk-x" } as Env, {
        usingClientKey: false,
      }),
    ).toBeUndefined();
    // The empty string checked into wrangler.jsonc — the shipped kill switch.
    expect(
      fallbackLegFor({ FALLBACK_PROVIDER: "", OPENROUTER_API_KEY: "sk-x" } as Env, {
        usingClientKey: false,
      }),
    ).toBeUndefined();
    // "anthropic" has no default base URL/model — failing over to LLM_BASE_URL
    // would mean failing over to the provider that just failed.
    expect(
      fallbackLegFor({ FALLBACK_PROVIDER: "anthropic", OPENROUTER_API_KEY: "sk-x" } as Env, {
        usingClientKey: false,
      }),
    ).toBeUndefined();
  });

  it("makes exactly one attempt and preserves status/kind while redacting the provider body when no fallback is set", async () => {
    const fetchMock = vi.fn(async () => creditExhausted());
    vi.stubGlobal("fetch", fetchMock);
    const err = await callTool(primary, tool, {}).catch((e) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).status).toBe(400);
    expect((err as LlmCallError).kind).toBe("http");
    expect((err as LlmCallError).body).toMatch(/credit balance is too low/i);
    expect(String(err)).not.toMatch(/credit balance is too low/i);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(err)).not.toContain("both legs");
  });

  it("does not retry a 5xx either — no fallback means no second attempt of any kind", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(callTool(primary, tool, {})).rejects.toThrow(LlmCallError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// I3 — NEVER FAIL OVER A BYOK SESSION
// ---------------------------------------------------------------------------

describe("I3: a BYOK call is never failed over onto our key", () => {
  /** A deployment with the fallback fully, correctly configured. */
  const configured = {
    FALLBACK_PROVIDER: "openrouter",
    FALLBACK_MODEL,
    FALLBACK_KEY_ENV: "OPENROUTER_API_KEY",
    OPENROUTER_API_KEY: "sk-openrouter",
  } as Env;

  it("fallbackLegFor refuses for usingClientKey even when fully configured", () => {
    // Proof the env really is usable — otherwise the next assertion is vacuous.
    expect(fallbackLegFor(configured, { usingClientKey: false })).toMatchObject({
      provider: "openrouter",
      baseUrl: OPENROUTER_BASE_URL,
      model: FALLBACK_MODEL,
      apiKey: "sk-openrouter",
    });
    expect(fallbackLegFor(configured, { usingClientKey: true })).toBeUndefined();
  });

  it("no env override can re-enable failover for a client key", () => {
    const maximal = {
      ...configured,
      FALLBACK_BASE_URL: "https://openrouter.ai/api/v1",
      FALLBACK_MODEL: "openai/gpt-oss-120b",
      FALLBACK_TIMEOUT_MS: "9000",
    } as Env;
    expect(fallbackLegFor(maximal, { usingClientKey: true })).toBeUndefined();
  });

  it("a BYOK-shaped config makes one attempt and surfaces the user's own error", async () => {
    // What a BYOK config looks like: the client's key, no `fallback` field.
    const byok: LlmConfig = {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-users-own-key",
      model: "meta-llama/llama-3.3-70b-instruct",
      fallback: fallbackLegFor(configured, { usingClientKey: true }),
    };
    const fetchMock = vi.fn(async () => new Response("insufficient credits", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(callTool(byok, tool, {})).rejects.toThrow(/402/);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(urlOf(fetchMock, 0)).toBe("https://openrouter.ai/api/v1/chat/completions");
  });

  it("structural guard: every `fallback:` in src/ is fallbackLegFor with a pinned verdict", () => {
    // BACKSTOP ONLY — the behavioural coverage is the describe below this one.
    // Two things this must catch that the first version of it did not:
    //   1. the ARGUMENT, not just the callee. `fallbackLegFor(env, {
    //      usingClientKey: false })` at a BYOK site is the exact mutation I3
    //      exists to stop, and it matches "was fallbackLegFor called?" perfectly.
    //      So the verdict at every site is pinned by census below.
    //   2. a fallback added in a module nobody thought to list. The scan walks
    //      ALL of src/, not a hardcoded pair of files.
    const census = fallbackAssignments();

    // Every assignment is a fallbackLegFor call whose verdict we can read.
    for (const site of census) {
      expect(
        site.verdict,
        `${site.file}:${site.line} — \`${site.text}\` is not \`fallbackLegFor(env, { usingClientKey: … })\``,
      ).not.toBeNull();
    }

    // …and the exact set of (file, verdict) pairs is pinned. Flipping a BYOK
    // site's `true` to `false` (or vice versa), adding a site, or moving one
    // between files all fail here and force the author to add the behavioural
    // test that goes with it.
    expect(census.map((s) => `${s.file}:${s.verdict}`).sort()).toEqual([
      // /analyze + /ask, hosted branch — our key, eligible.
      "llm/hosted-config.ts:false",
      // /analyze + /ask, BYOK branch — the client's key, never eligible.
      "llm/hosted-config.ts:true",
      // /dictation/polish + /context/refine — eligibility follows the key.
      "llm/hosted-config.ts:usingClientKey",
      // SessionDO hosted branch.
      "session-do.ts:false",
      // SessionDO BYOK branch.
      "session-do.ts:true",
    ]);
  });
});

// ---------------------------------------------------------------------------
// I3 AT THE REAL CALL SITES
//
// The block above proves `fallbackLegFor` refuses a client key and that every
// site calls it. Neither of those catches the mutation that matters: a site
// passing the WRONG verdict — `usingClientKey: false` on the BYOK branch —
// which puts a paying user's own key onto our OpenRouter key and their transcript
// onto a provider they never chose. A grep cannot see an argument, so these
// tests build the config each of the five sites builds and drive a real
// (mocked-transport) call through `callTool`, asserting how many requests went
// out and whose credential was on them.
// ---------------------------------------------------------------------------

describe("I3 at the real call sites (/analyze, /ask, /dictation/polish, /context/refine, SessionDO)", () => {
  /** A maximally-configured deployment: fallback ON, hosted paid model set.
   * Nothing below can pass vacuously because the leg is genuinely available. */
  const env = {
    LLM_BASE_URL: "https://api.anthropic.com/v1",
    LLM_API_KEY: "sk-OURS",
    LLM_MODEL: "claude-sonnet-5",
    FALLBACK_PROVIDER: "openrouter",
    FALLBACK_MODEL,
    FALLBACK_RATE_USD_PER_M: "0.15",
    FALLBACK_KEY_ENV: "OPENROUTER_API_KEY",
    OPENROUTER_API_KEY: "sk-openrouter",
  } as Env;

  const user: Identity = { kind: "user", userId: "u_1" };
  const CLIENT_KEY = "sk-USERS-OWN-KEY";
  const hostedLeg = {
    provider: "anthropic" as const,
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
  };
  /** A fresh set of meters per test — the spend ledger accumulates, so sharing
   * one across cases would let an earlier test's calls satisfy a later one's
   * assertion. */
  const newMeters = () => ({ addUnits: () => {}, spend: createSpendLedger(), noteLeg: () => {} });

  /** Every credential and host that must never appear on the wire for a BYOK
   * call, checked against the WHOLE recorded fetch history rather than one
   * request — a second request is exactly what this invariant forbids. */
  function assertNothingOfOursLeaked(fetchMock: ReturnType<typeof vi.fn>): void {
    const wire = JSON.stringify(fetchMock.mock.calls);

    expect(wire).not.toContain("sk-openrouter");
    expect(wire).not.toContain("sk-OURS");
  }

  it("proof the env really is usable — otherwise every BYOK assertion is vacuous", () => {
    expect(fallbackLegFor(env, { usingClientKey: false })).toMatchObject({
      provider: "openrouter",
      model: FALLBACK_MODEL,
      apiKey: "sk-openrouter",
    });
  });

  it("/analyze + /ask BYOK: no fallback leg, and exactly ONE request, on the client's key", async () => {
    const ledger = createSpendLedger();
    const config = resolveAnalysisLlmConfig(
      env,
      { llm_api_key: CLIENT_KEY, llm_provider: "openrouter", llm_model: "meta-llama/llama-3.3-70b-instruct" },
      user,
      ledger,
    );
    expect(config.fallback).toBeUndefined();
    expect(config.apiKey).toBe(CLIENT_KEY);

    // 402 is on the trigger list, so a wrongly-resolved leg WOULD fire here.
    const fetchMock = vi.fn(async () => new Response("insufficient credits", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(callTool(config, tool, {})).rejects.toThrow(/402/);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${CLIENT_KEY}`);
    assertNothingOfOursLeaked(fetchMock);
    // BYOK is not our money: the meter must not move by a single micro-dollar,
    // and the 402 came back with no usage block, so there is nothing to count.
    expect(ledger.peek()).toEqual({ micros: 0, legs: [], byokCalls: 0, shadowMicros: 0 });
  });

  it("/analyze + /ask hosted: resolves the configured leg and really fails over to it", async () => {
    const ledger = createSpendLedger(pricingOptionsFromEnv(env));
    const config = resolveAnalysisLlmConfig(env, {}, user, ledger);
    expect(config.apiKey).toBe("sk-OURS");
    expect(config.fallback).toMatchObject({ provider: "openrouter", model: FALLBACK_MODEL });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(creditExhausted())
      .mockResolvedValueOnce(openAiCompatOk({ things: [] }, { prompt_tokens: 100, completion_tokens: 10 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await callTool(config, tool, {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 1)).toBe("https://openrouter.ai/api/v1/chat/completions");
    // Our own spend is metered at the leg that served it, using the configured
    // fallback rate rather than the primary's Anthropic rate card.
    const delta = ledger.peek();
    expect(delta.legs).toEqual([
      {
        provider: "openrouter",
        model: FALLBACK_MODEL,
        calls: 1,
        inputTokens: 100,
        outputTokens: 10,
        // openai/gpt-oss-120b is LISTED on the OpenRouter card ($0.15/$0.60 per
        // 1M, llm/pricing.ts OPENROUTER_LISTINGS) and a listed model keeps its
        // entry over the operator's flat FALLBACK_RATE_USD_PER_M:
        // 100 * 0.15 + 10 * 0.60 = 15 + 6 = 21 micro-dollars.
        micros: 21,
        basis: "configured",
      },
    ]);
    expect(delta.micros).toBe(21);
  });

  it("/dictation/polish + /context/refine BYOK: no fallback leg, ONE request, client's key", async () => {
    const ledger = createSpendLedger();
    const config = resolveStatelessLlmConfig(env, CLIENT_KEY, ledger);
    expect(config.fallback).toBeUndefined();
    expect(config.apiKey).toBe(CLIENT_KEY);

    // 429 is on the trigger list too — a wrong verdict fires on it.
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(callTool(config, tool, {})).rejects.toThrow(/429/);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(urlOf(fetchMock, 0)).toBe("https://api.anthropic.com/v1/messages");
    assertNothingOfOursLeaked(fetchMock);
    expect(ledger.peek()).toEqual({ micros: 0, legs: [], byokCalls: 0, shadowMicros: 0 });
  });

  it("/dictation/polish + /context/refine hosted: resolves the leg and fails over", async () => {
    const ledger = createSpendLedger(pricingOptionsFromEnv(env));
    const config = resolveStatelessLlmConfig(env, undefined, ledger);
    expect(config.apiKey).toBe("sk-OURS");
    expect(config.fallback).toMatchObject({ provider: "openrouter" });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(creditExhausted())
      .mockResolvedValueOnce(openAiCompatOk({ things: [] }, { prompt_tokens: 8, completion_tokens: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await callTool(config, tool, {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 1)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(ledger.peek().legs).toMatchObject([{ provider: "openrouter", basis: "configured", calls: 1 }]);
  });

  it("SessionDO BYOK: no fallback leg, ONE request, client's key, zero real-$ accrual", async () => {
    const units = vi.fn();
    const meters = { ...newMeters(), addUnits: units };
    const config = sessionLlmConfig(
      env,
      { apiKey: CLIENT_KEY, provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct" },
      hostedLeg,
      meters,
    );
    expect(config.fallback).toBeUndefined();
    expect(config.apiKey).toBe(CLIENT_KEY);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    // No tool call in the reply → a `protocol` error, which never fails over…
    await expect(callTool(config, tool, {})).rejects.toThrow(/did not include a tool call/);
    expect(fetchMock).toHaveBeenCalledOnce();
    assertNothingOfOursLeaked(fetchMock);
    // …and the per-session unit budget still bounds a BYOK session, while OUR
    // real-$ meter stays untouched (BAR I6: BYOK contributes zero). The call is
    // COUNTED though — zero dollars is not the same as no activity (defect D5).
    expect(units).toHaveBeenCalledOnce();
    expect(meters.spend.peek()).toEqual({ micros: 0, legs: [], byokCalls: 1, shadowMicros: 0 });
  });

  it("SessionDO BYOK survives a hibernation wake, where the fields come back null", () => {
    // `clientLlmProvider`/`clientLlmModel` deserialize as null, not undefined.
    // If `??` were `||`, or the null were read as "no BYOK", a woken session
    // would silently become a hosted one — with a fallback leg attached.
    const config = sessionLlmConfig(
      env,
      { apiKey: CLIENT_KEY, provider: null, model: null },
      hostedLeg,
      newMeters(),
    );
    expect(config.fallback).toBeUndefined();
    expect(config.apiKey).toBe(CLIENT_KEY);
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe(hostedLeg.model);
  });

  it("SessionDO hosted: resolves the leg, fails over, and meters at the SERVING model", async () => {
    const legs: ServedLeg[] = [];
    const spend = createSpendLedger(pricingOptionsFromEnv(env));
    const config = sessionLlmConfig(env, {}, hostedLeg, {
      addUnits: () => {},
      spend,
      noteLeg: (leg) => legs.push(leg),
    });
    expect(config.apiKey).toBe("sk-OURS");
    expect(config.fallback).toMatchObject({ provider: "openrouter", model: FALLBACK_MODEL });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(creditExhausted())
      .mockResolvedValueOnce(openAiCompatOk({ things: [] }, { prompt_tokens: 1000, completion_tokens: 100 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await callTool(config, tool, {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 1)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(legs).toEqual([
      { provider: "openrouter", model: FALLBACK_MODEL, baseUrl: OPENROUTER_BASE_URL, fallback: true },
    ]);
    // The whole point of I5: 1000 in + 100 out on the FALLBACK leg is priced at
    // OpenRouter's listed rate for gpt-oss-120b ($0.15/$0.60 per 1M:
    // 150 + 60 = 210 micro-$), NOT at the primary's claude-sonnet-5 card, which
    // would have charged 3*1000 + 15*100 = 4500 — 21x more, straight into the
    // anti-abuse ceiling.
    expect(spend.peek().legs).toEqual([
      {
        provider: "openrouter",
        model: FALLBACK_MODEL,
        calls: 1,
        inputTokens: 1000,
        outputTokens: 100,
        micros: 210,
        basis: "configured",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The failover trigger table (BAR: "do not narrow, do not widen")
// ---------------------------------------------------------------------------

describe("shouldFailOver — the exact trigger list", () => {
  const http = (status: number, body = "") =>
    new LlmCallError(`LLM call failed: ${status} ${body}`, status, "http", body);

  it("fires on the cannot-pay / not-permitted family, including Anthropic's 400", () => {
    expect(shouldFailOver(http(401, "invalid x-api-key"))).toBe(true);
    expect(shouldFailOver(http(402, "payment required"))).toBe(true);
    expect(shouldFailOver(http(403, "forbidden"))).toBe(true);
    // The reason this feature exists: an out-of-credit Anthropic key is a 400.
    // A 5xx-only trigger would not fire here.
    expect(
      shouldFailOver(
        http(400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'),
      ),
    ).toBe(true);
  });

  it("fires on transport, timeout, 408, 429 and every 5xx", () => {
    expect(shouldFailOver(new LlmCallError("LLM call failed: TypeError", undefined, "transport"))).toBe(true);
    expect(shouldFailOver(new LlmCallError("LLM call timed out after 30000ms", undefined, "timeout"))).toBe(true);
    expect(shouldFailOver(http(408))).toBe(true);
    // OpenAI's `insufficient_quota` arrives as a 429 — covered by the blanket.
    expect(shouldFailOver(http(429, '{"error":{"code":"insufficient_quota"}}'))).toBe(true);
    expect(shouldFailOver(http(500))).toBe(true);
    expect(shouldFailOver(http(502))).toBe(true);
    expect(shouldFailOver(http(529))).toBe(true);
  });

  it("does NOT fire on an ordinary 400, a refusal, or a max_tokens truncation", () => {
    // Our own malformed request: failing over burns the fallback on the same body.
    expect(shouldFailOver(http(400, '{"error":{"message":"tools.0.input_schema: field required"}}'))).toBe(false);
    expect(shouldFailOver(http(404, "model not found"))).toBe(false);
    expect(shouldFailOver(http(413, "too large"))).toBe(false);
    expect(shouldFailOver(new LlmCallError("LLM declined the request (stop_reason: refusal)"))).toBe(false);
    expect(
      shouldFailOver(new LlmCallError("LLM output hit max_tokens before completing the tool call")),
    ).toBe(false);
    expect(shouldFailOver(new LlmCallError("LLM response did not include a tool call"))).toBe(false);
    expect(shouldFailOver(new LlmCallError("LLM tool call arguments were not valid JSON"))).toBe(false);
  });

  it("does not fire on a non-LlmCallError (an unclassified throw is never worth a second key)", () => {
    expect(shouldFailOver(new TypeError("boom"))).toBe(false);
    expect(shouldFailOver("boom")).toBe(false);
    expect(shouldFailOver(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Failover behaviour + the leg-reporting seam stage B prices against
// ---------------------------------------------------------------------------

describe("callTool failover", () => {
  it("fails an out-of-credit Anthropic primary over to OpenRouter and returns its result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(creditExhausted())
      .mockResolvedValueOnce(openAiCompatOk({ things: ["from-openrouter"] }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = await callTool<{ things: string[] }>({ ...primary, fallback: fallbackLeg }, tool, {});
    expect(out.things).toEqual(["from-openrouter"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 0)).toBe("https://api.anthropic.com/v1/messages");
    const [url, init] = fetchMock.mock.calls[1]! as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-openrouter");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["x-title"]).toBe("Cyrano");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(FALLBACK_MODEL);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: tool.name } });

    // The failover is logged, without the provider's response body.
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("openrouter/openai/gpt-oss-120b");
    expect(String(warn.mock.calls[0]![0])).not.toContain("credit balance");
    warn.mockRestore();
  });

  it("attributes usage to the leg that actually served it (the seam the cost model prices)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
      .mockResolvedValueOnce(
        openAiCompatOk({ things: [] }, { prompt_tokens: 1200, completion_tokens: 300 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const seen: Array<{ usage: LlmUsage; leg: ServedLeg }> = [];
    const legs: ServedLeg[] = [];
    await callTool(
      {
        ...primary,
        fallback: fallbackLeg,
        onUsage: (usage, leg) => seen.push({ usage, leg }),
        onLeg: (leg) => legs.push(leg),
      },
      tool,
      {},
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.leg).toEqual({
      provider: "openrouter",
      model: FALLBACK_MODEL,
      baseUrl: OPENROUTER_BASE_URL,
      fallback: true,
    });
    expect(seen[0]!.usage.input_tokens).toBe(1200);
    expect(seen[0]!.usage.output_tokens).toBe(300);
    // onLeg fires once, only for the leg that produced the returned result —
    // the primary threw, so it never "served" anything.
    expect(legs).toEqual([
      { provider: "openrouter", model: FALLBACK_MODEL, baseUrl: OPENROUTER_BASE_URL, fallback: true },
    ]);
  });

  it("tags the primary leg as fallback:false when the primary serves", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => anthropicOk({ things: [] }, { input_tokens: 10, output_tokens: 2 })));
    const legs: ServedLeg[] = [];
    await callTool(
      { ...primary, fallback: fallbackLeg, onUsage: (_u, leg) => legs.push(leg) },
      tool,
      {},
    );
    expect(legs).toEqual([
      { provider: "anthropic", model: "claude-sonnet-5", baseUrl: primary.baseUrl, fallback: false },
    ]);
  });

  it("does not fail over on a refusal or an ordinary 400 — one attempt, primary only", async () => {
    const refusal = vi.fn(async () =>
      new Response(JSON.stringify({ stop_reason: "refusal", content: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", refusal);
    await expect(callTool({ ...primary, fallback: fallbackLeg }, tool, {})).rejects.toThrow(/refusal/);
    expect(refusal).toHaveBeenCalledOnce();

    const badRequest = vi.fn(async () => new Response("tools.0.input_schema: field required", { status: 400 }));
    vi.stubGlobal("fetch", badRequest);
    await expect(callTool({ ...primary, fallback: fallbackLeg }, tool, {})).rejects.toThrow(/400/);
    expect(badRequest).toHaveBeenCalledOnce();
  });

  it("makes exactly ONE fallback attempt — failover never chains and never storms", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(callTool({ ...primary, fallback: fallbackLeg }, tool, {})).rejects.toThrow(LlmCallError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports both failed legs without embedding either provider body by default", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(creditExhausted())
      .mockResolvedValueOnce(new Response("openrouter is down", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await callTool({ ...primary, fallback: fallbackLeg }, tool, {}).catch((e) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).status).toBe(502);
    expect((err as LlmCallError).kind).toBe("http");
    expect(String(err)).toMatch(/both legs/);
    expect(String(err)).not.toMatch(/credit balance is too low|openrouter is down/);
  });

  // -------------------------------------------------------------------------
  // A FALLBACK MUST NEVER DEGRADE WORSE THAN NO FALLBACK.
  //
  // session-do holds an analysis window for another attempt when the failure is
  // retryable (429/408/5xx/transport) and consumes it otherwise. A fallback's
  // permanent-looking error must not override a retryable primary failure.
  // -------------------------------------------------------------------------
  it("a fallback that cannot serve the window never costs the caller a retry it would have had", async () => {
    const permanent400 = () =>
      new Response(JSON.stringify({ error: { code: "tool_use_failed", message: "model did not call a tool" } }), {
        status: 400,
      });

    // Primary 429 (retryable on its own) + fallback 400 (not). The composite
    // must stay retryable — i.e. carry the PRIMARY's status.
    for (const primaryStatus of [429, 408, 500, 503]) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(new Response("slow down", { status: primaryStatus }))
          .mockResolvedValueOnce(permanent400()),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const err = await callTool({ ...primary, fallback: fallbackLeg }, tool, {}).catch((e) => e);
      expect(err, `primary ${primaryStatus}`).toBeInstanceOf(LlmCallError);
      expect((err as LlmCallError).status, `primary ${primaryStatus}`).toBe(primaryStatus);
      expect(isRetryableFailure({ message: "x", status: (err as LlmCallError).status })).toBe(true);
      // Both failed legs remain identified without exposing provider bodies.
      expect(String((err as LlmCallError).message)).toMatch(/both legs/);
      expect(String((err as LlmCallError).message)).not.toMatch(/tool_use_failed/);
      vi.unstubAllGlobals();
    }

    // A primary TIMEOUT (no status at all) is retryable too, and must survive
    // the fallback's 400 the same way.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => {
          const e = new Error("aborted");
          e.name = "TimeoutError";
          return Promise.reject(e);
        })
        .mockResolvedValueOnce(permanent400()),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const timedOut = await callTool({ ...primary, fallback: fallbackLeg }, tool, {}).catch((e) => e);
    expect((timedOut as LlmCallError).status).toBeUndefined();
    expect(isRetryableFailure({ message: "x", status: (timedOut as LlmCallError).status })).toBe(true);
  });

  it("…and still reports the FALLBACK's failure when the primary's was permanent", async () => {
    // The pre-existing behaviour, unchanged: a 400 credit-exhausted primary was
    // never going to be retried, so the fallback's 502 is the more useful of
    // the two and the caller sees it.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(creditExhausted()).mockResolvedValueOnce(new Response("openrouter down", { status: 502 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await callTool({ ...primary, fallback: fallbackLeg }, tool, {}).catch((e) => e);
    expect((err as LlmCallError).status).toBe(502);
  });

  it("session-do's retry rule and callTool's both-legs rule are ONE predicate", () => {
    // If these ever forked, a fallback failure could silently drop a window the
    // primary alone would have held — the bug the test above pins.
    for (const s of [undefined, 408, 429, 500, 502, 503] as (number | undefined)[]) {
      expect(isRetryableStatus(s), String(s)).toBe(true);
      expect(isRetryableFailure({ message: "x", status: s }), String(s)).toBe(true);
    }
    for (const s of [400, 401, 402, 403, 404, 422]) {
      expect(isRetryableStatus(s), String(s)).toBe(false);
      expect(isRetryableFailure({ message: "x", status: s }), String(s)).toBe(false);
    }
    // No failure at all is not a retry.
    expect(isRetryableFailure(undefined)).toBe(false);
  });

  it("gives the fallback its own, tighter timeout budget", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(openAiCompatOk({ things: [] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi.spyOn(AbortSignal, "timeout");
    await callTool({ ...primary, fallback: fallbackLeg }, tool, {});
    expect((spy.mock.calls as unknown as number[][]).map((c) => c[0])).toEqual([30_000, FALLBACK_TIMEOUT_MS]);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Reasoning-model request behavior.
// ---------------------------------------------------------------------------

describe("reasoning-model headroom on the OpenAI-compat wire", () => {
  const openrouterPrimary: LlmConfig = {
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: "sk-openrouter",
    model: FALLBACK_MODEL,
  };

  async function bodyOf(config: LlmConfig, maxTokens?: number): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn(async () => openAiCompatOk({ things: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await callTool(config, tool, {}, maxTokens === undefined ? {} : { maxTokens });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it("classifies the gpt-oss family and nothing that merely contains the string", () => {
    expect(isReasoningBudgetModel("openai/gpt-oss-120b")).toBe(true);
    expect(isReasoningBudgetModel("openai/gpt-oss-20b")).toBe(true);
    expect(isReasoningBudgetModel("gpt-oss-120b")).toBe(true);
    expect(isReasoningBudgetModel("notgpt-oss-120b")).toBe(false);
    expect(isReasoningBudgetModel("meta-llama/llama-3.3-70b-instruct")).toBe(false);
    expect(isReasoningBudgetModel("gpt-5.6-luna")).toBe(false);
    expect(isReasoningBudgetModel("claude-sonnet-5")).toBe(false);
  });

  it("gives the combined pass's cap extra headroom on gpt-oss", async () => {
    const body = await bodyOf(openrouterPrimary, 2048);
    expect(body.max_tokens).toBe(4096);
    // This model family takes the classic field, not `max_completion_tokens`.
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("requests low reasoning effort so the tool call has room", async () => {
    const body = await bodyOf(openrouterPrimary, 2048);
    expect(body.reasoning_effort).toBe("low");
    // "none" belongs to the separate GPT-5 branch.
    expect(body.reasoning_effort).not.toBe("none");
  });

  it("is a floor, not a ceiling — a caller asking for more keeps what it asked for", async () => {
    expect((await bodyOf(openrouterPrimary, 8192)).max_tokens).toBe(8192);
  });

  it("applies on the FALLBACK leg too, which is where it actually matters", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(creditExhausted())
      .mockResolvedValueOnce(openAiCompatOk({ things: [] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await callTool({ ...primary, fallback: fallbackLeg }, tool, {}, { maxTokens: 2048 });
    const [, init] = fetchMock.mock.calls[1]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).max_tokens).toBe(4096);
    expect(JSON.parse(init.body as string).reasoning_effort).toBe("low");
  });

  it("I1: the hosted OpenAI-compat leg and a plain OpenAI-compat model are untouched", async () => {
    // gpt-5.6-luna — what HOSTED_PAID_* points at today. Unchanged branch.
    const luna = await bodyOf(
      { provider: "openrouter", baseUrl: "https://api.openai.com/v1", apiKey: "sk-o", model: "gpt-5.6-luna" },
      2048,
    );
    expect(luna.max_completion_tokens).toBe(4096);
    expect(luna.reasoning_effort).toBe("none");
    expect(luna.max_tokens).toBeUndefined();

    // A non-reasoning model gets EXACTLY the cap it was given, as before —
    // and no sampling field it never used to receive.
    const llama = await bodyOf(
      {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or",
        model: "meta-llama/llama-3.3-70b-instruct",
      },
      2048,
    );
    expect(llama.max_tokens).toBe(2048);
    expect(llama.max_completion_tokens).toBeUndefined();
    expect(llama.reasoning_effort).toBeUndefined();
  });

  it("I1: the Anthropic primary's max_tokens is untouched by any of this", async () => {
    const fetchMock = vi.fn(async () => anthropicOk({ things: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await callTool({ ...primary, fallback: fallbackLeg }, tool, {}, { maxTokens: 2048 });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).max_tokens).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// Failover log volume
// ---------------------------------------------------------------------------

describe("the failover log line is throttled, not silenced", () => {
  async function failOverOnce(): Promise<void> {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(creditExhausted())
      .mockResolvedValueOnce(openAiCompatOk({ things: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await callTool({ ...primary, fallback: fallbackLeg }, tool, {});
  }

  it("logs the first transition immediately and then at most once per minute", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // An out-of-credit primary fails over on EVERY tick of every session; a
    // line per call is noise, and SessionDO's own once-per-session breadcrumb
    // would be drowned by it.
    for (let i = 0; i < 25; i++) await failOverOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("openrouter/openai/gpt-oss-120b");

    // A DIFFERENT situation is still reported at once — throttling must not
    // hide a new failure mode behind an old one.
    const other = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(openAiCompatOk({ things: [] }));
    vi.stubGlobal("fetch", other);
    await callTool({ ...primary, fallback: fallbackLeg }, tool, {});
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toContain("http 503");
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// fallbackLegFor — the configuration surface
// ---------------------------------------------------------------------------

describe("fallbackLegFor", () => {
  it("uses OpenRouter's base URL default with an explicit key env and model", () => {
    const leg = fallbackLegFor(
      {
        FALLBACK_PROVIDER: "openrouter",
        FALLBACK_KEY_ENV: "OPENROUTER_API_KEY",
        FALLBACK_MODEL,
        OPENROUTER_API_KEY: "sk-x",
      } as Env,
      { usingClientKey: false },
    );
    expect(leg).toEqual({
      provider: "openrouter",
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: "sk-x",
      model: FALLBACK_MODEL,
      timeoutMs: FALLBACK_TIMEOUT_MS,
    });
  });

  it("resolves the key by NAME so it stays a secret, never a var", () => {
    const leg = fallbackLegFor(
      {
        FALLBACK_PROVIDER: "openrouter",
        FALLBACK_KEY_ENV: "OPENROUTER_API_KEY",
        FALLBACK_MODEL,
        OPENROUTER_API_KEY: "sk-or",
      } as Env,
      { usingClientKey: false },
    );
    expect(leg?.apiKey).toBe("sk-or");
  });

  it("honours explicit base URL / model / timeout overrides", () => {
    const leg = fallbackLegFor(
      {
        FALLBACK_PROVIDER: "openrouter",
        FALLBACK_KEY_ENV: "OPENROUTER_API_KEY",
        OPENROUTER_API_KEY: "sk-or",
        FALLBACK_BASE_URL: "https://example.test/v1",
        FALLBACK_MODEL: "openai/gpt-oss-20b",
        FALLBACK_TIMEOUT_MS: "8000",
      } as Env,
      { usingClientKey: false },
    );
    expect(leg).toEqual({
      provider: "openrouter",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-or",
      model: "openai/gpt-oss-20b",
      timeoutMs: 8000,
    });
  });

  it("falls back to the default budget for a junk or non-positive timeout", () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      const leg = fallbackLegFor(
        {
          FALLBACK_PROVIDER: "openrouter",
          FALLBACK_KEY_ENV: "OPENROUTER_API_KEY",
          FALLBACK_MODEL,
          OPENROUTER_API_KEY: "sk-x",
          FALLBACK_TIMEOUT_MS: raw,
        } as Env,
        { usingClientKey: false },
      );
      expect(leg?.timeoutMs).toBe(FALLBACK_TIMEOUT_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// HOSTED_PAID_KEY_ENV names an Env field. It is operator-supplied, and Env is a
// plain object, so an Object.prototype name resolves to an INHERITED FUNCTION —
// which is non-nullish, so a `?? env.LLM_API_KEY` fallthrough never fires and a
// function goes out as the bearer token. env.ts guards its own key lookup this
// way; the two hosted branches did not.
// ---------------------------------------------------------------------------

describe("an operator-named key env resolves to a string or to nothing, never to a prototype member", () => {
  const base = {
    LLM_BASE_URL: "https://api.anthropic.com/v1",
    LLM_API_KEY: "sk-OURS",
    LLM_MODEL: "claude-sonnet-5",
    HOSTED_PAID_MODEL: "gpt-5.6-luna",
    HOSTED_PAID_PROVIDER: "openrouter",
  } as unknown as Env;
  const owner: Identity = { kind: "user", userId: "u_1", label: "u", plan: null } as unknown as Identity;

  it("falls through to LLM_API_KEY for every Object.prototype name", () => {
    for (const keyEnv of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
      const config = resolveAnalysisLlmConfig(
        { ...base, HOSTED_PAID_KEY_ENV: keyEnv } as Env,
        null,
        owner,
        createSpendLedger(),
      );
      expect(typeof config.apiKey, keyEnv).toBe("string");
      expect(config.apiKey, keyEnv).toBe("sk-OURS");
    }
  });

  it("still reads a real, operator-set key field", () => {
    const config = resolveAnalysisLlmConfig(
      { ...base, HOSTED_PAID_KEY_ENV: "OPENAI_API_KEY", OPENAI_API_KEY: "sk-openai" } as unknown as Env,
      null,
      owner,
      createSpendLedger(),
    );
    expect(config.apiKey).toBe("sk-openai");
  });

  it("namedEnvKey itself: own string fields only", () => {
    const env = { A: "a", B: "" } as unknown as Env;
    expect(namedEnvKey(env, "A")).toBe("a");
    expect(namedEnvKey(env, "B")).toBeUndefined(); // empty is not a key
    expect(namedEnvKey(env, "MISSING")).toBeUndefined();
    expect(namedEnvKey(env, "constructor")).toBeUndefined();
    expect(namedEnvKey(env, "toString")).toBeUndefined();
  });
});

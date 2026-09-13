// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// The native Messages API client (llm/client.ts) — request shape, forced
// tool choice, usage reporting, and error mapping. The 2026-07-11 rewrite
// off the OpenAI-compat shim is load-bearing for BYOK cost control, so the
// wire shape is pinned here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, costWeightedUnits, pingLlm, LlmCallError, type ToolSchema } from "../src/llm/client.js";
import { priceUsage } from "../src/llm/pricing.js";
import { runCombinedAnalysis } from "../src/analysis/passes.js";
import type { TranscriptSegment } from "../src/types.js";

const config = { baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-test", model: "claude-sonnet-5" };

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

function messagesResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function okToolResponse(input: unknown, usage?: Record<string, number>) {
  return messagesResponse({
    stop_reason: "tool_use",
    content: [{ type: "tool_use", name: tool.name, input }],
    usage,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("callTool (native Messages API)", () => {
  it("sends the native request shape: /messages, x-api-key, forced tool_choice, cached system", async () => {
    const fetchMock = vi.fn(async () => okToolResponse({ things: ["a"] }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await callTool<{ things: string[] }>(config, tool, { hello: "world" });
    expect(out.things).toEqual(["a"]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["authorization"]).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-sonnet-5");
    expect(body.max_tokens).toBe(1024); // default cap
    expect(body.thinking).toBeUndefined();
    expect(body.tool_choice).toEqual({ type: "tool", name: tool.name });
    expect(body.tools).toEqual([
      { name: tool.name, description: tool.description, input_schema: tool.output_schema },
    ]);
    // One cache breakpoint on the system block caches tools+system together.
    expect(body.system).toEqual([
      { type: "text", text: tool.system_prompt, cache_control: { type: "ephemeral" } },
    ]);
    expect(body.messages).toEqual([{ role: "user", content: JSON.stringify({ hello: "world" }) }]);
  });

  it("honors a per-call maxTokens override", async () => {
    const fetchMock = vi.fn(async () => okToolResponse({ things: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await callTool(config, tool, {}, { maxTokens: 256 });
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(256);
  });

  it("reports usage to onUsage, zero-filling absent fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okToolResponse({ things: [] }, { input_tokens: 100, output_tokens: 20 })),
    );
    const seen: unknown[] = [];
    await callTool({ ...config, onUsage: (u) => seen.push(u) }, tool, {});
    expect(seen).toEqual([
      { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ]);
  });

  it("redacts an Anthropic HTTP response body from the exception string by default", async () => {
    const providerBody = "authentication_error echoed private transcript text";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(providerBody, { status: 401 })),
    );
    const err = await callTool(config, tool, {}).catch((e) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).status).toBe(401);
    expect((err as LlmCallError).kind).toBe("http");
    expect((err as LlmCallError).body).toBe(providerBody);
    expect(String(err)).toContain("401");
    expect(String(err)).not.toContain(providerBody);
    expect(Object.keys(err as object)).not.toContain("body");
  });

  it("includes an HTTP response body only with explicit content logging", async () => {
    const providerBody = "diagnostic body explicitly opted in";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(providerBody, { status: 502 })));
    const err = await callTool({ ...config, logContent: true }, tool, {}).catch((e) => e);
    expect((err as LlmCallError).status).toBe(502);
    expect((err as LlmCallError).kind).toBe("http");
    expect(String(err)).toContain(providerBody);
  });

  it("throws on refusal and truncated (max_tokens) responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => messagesResponse({ stop_reason: "refusal", content: [], usage: { input_tokens: 5 } })),
    );
    await expect(callTool(config, tool, {})).rejects.toThrow(/refusal/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => messagesResponse({ stop_reason: "max_tokens", content: [] })),
    );
    await expect(callTool(config, tool, {})).rejects.toThrow(/max_tokens/);
  });

  it("throws when no matching tool_use block is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => messagesResponse({ stop_reason: "end_turn", content: [{ type: "text" }] })),
    );
    await expect(callTool(config, tool, {})).rejects.toThrow(/did not include a tool call/);
  });
});

describe("callTool (OpenRouter / OpenAI-compatible provider)", () => {
  const orConfig = { ...config, provider: "openrouter" as const, baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" };

  function chatToolResponse(args: unknown, usage?: Record<string, unknown>, finish = "tool_calls") {
    return messagesResponse({
      choices: [
        {
          finish_reason: finish,
          message: { tool_calls: [{ function: { name: tool.name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] },
        },
      ],
      usage,
    });
  }

  it("hits /chat/completions with Bearer auth, OpenAI function tool, forced tool_choice", async () => {
    const fetchMock = vi.fn(async () => chatToolResponse({ things: ["x"] }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await callTool<{ things: string[] }>(orConfig, tool, { q: 1 });
    expect(out.things).toEqual(["x"]);

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test");
    expect(headers["x-api-key"]).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("openai/gpt-4o-mini");
    expect(body.thinking).toBeUndefined(); // OpenAI shape has no thinking param
    expect(body.tool_choice).toEqual({ type: "function", function: { name: tool.name } });
    expect(body.tools[0]).toEqual({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.output_schema },
    });
    expect(body.messages).toEqual([
      { role: "system", content: tool.system_prompt },
      { role: "user", content: JSON.stringify({ q: 1 }) },
    ]);
  });

  it("maps OpenAI usage onto LlmUsage (cached tokens -> cache_read, rest -> input)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatToolResponse({ things: [] }, {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 200 },
        }),
      ),
    );
    const seen: unknown[] = [];
    await callTool({ ...orConfig, onUsage: (u) => seen.push(u) }, tool, {});
    expect(seen).toEqual([
      { input_tokens: 800, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
    ]);
  });

  it("maps cache_write_tokens onto cache_creation, not into cheap fresh input", async () => {
    // `cache_write_tokens` is in the recorded OpenRouter fixture and was being
    // ignored: writes stayed inside `prompt_tokens` and priced at 1.0x instead
    // of the 1.25x an Anthropic-family model bills for them through an
    // OpenAI-compatible gateway — a silent 25% under-count on that field.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatToolResponse({ things: [] }, {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
        }),
      ),
    );
    const seen: unknown[] = [];
    await callTool({ ...orConfig, onUsage: (u) => seen.push(u) }, tool, {});
    // Both are subsets of prompt_tokens, so fresh input is what is left.
    expect(seen).toEqual([
      { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 },
    ]);
  });

  it("never reports negative fresh input when a provider double-counts its own subsets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chatToolResponse({ things: [] }, {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 90, cache_write_tokens: 90 },
        }),
      ),
    );
    const seen: Array<{ input_tokens: number }> = [];
    await callTool({ ...orConfig, onUsage: (u) => seen.push(u) }, tool, {});
    expect(seen[0]!.input_tokens).toBe(0);
  });

  it("defensively unwraps double-encoded tool arguments (the old-shim failure mode)", async () => {
    // Some models return the JSON object as a *string* inside arguments.
    vi.stubGlobal("fetch", vi.fn(async () => chatToolResponse(JSON.stringify({ things: ["y"] }))));
    const out = await callTool<{ things: string[] }>(orConfig, tool, {});
    expect(out.things).toEqual(["y"]);
  });

  it("throws on truncation, missing tool call, and non-2xx (carrying status)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => chatToolResponse({ things: [] }, undefined, "length")));
    await expect(callTool(orConfig, tool, {})).rejects.toThrow(/max_tokens/);

    vi.stubGlobal("fetch", vi.fn(async () => messagesResponse({ choices: [{ message: { tool_calls: [] } }] })));
    await expect(callTool(orConfig, tool, {})).rejects.toThrow(/did not include a tool call/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("no credits", { status: 402 })));
    const err = await callTool(orConfig, tool, {}).catch((e) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).status).toBe(402);
  });
});

describe("costWeightedUnits", () => {
  it("weights cache writes 1.25x, cache reads 0.1x, output 5x", () => {
    expect(
      costWeightedUnits({
        input_tokens: 100,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 2000,
        output_tokens: 100,
      }),
    ).toBe(100 + 1250 + 200 + 500);
  });
});

// Pricing moved off model-name-only lookup (`usageMicros`, deleted) onto
// provider+model (`llm/pricing.ts`) on 2026-08-19 — defects D1/D2. These cases
// are the originals, restated through the new entry point so the Anthropic
// rate card and its cache ratios stay pinned exactly where they were.
describe("priceUsage on the Anthropic card", () => {
  const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const anthropic = (model: string) => ({
    provider: "anthropic" as const,
    model,
    baseUrl: "https://api.anthropic.com/v1",
  });

  it("prices Haiku at $1/M in and $5/M out (micro-$ per token == $/M rate)", () => {
    expect(priceUsage({ ...zero, input_tokens: 1_000_000 }, anthropic("claude-haiku-4-5")).micros).toBe(1_000_000);
    expect(priceUsage({ ...zero, output_tokens: 1_000_000 }, anthropic("claude-haiku-4-5")).micros).toBe(5_000_000);
  });

  it("applies Anthropic cache ratios: write 1.25x input, read 0.1x input", () => {
    expect(
      priceUsage(
        { ...zero, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 },
        anthropic("claude-haiku-4-5"),
      ).micros,
    ).toBe(1_250_000 + 100_000);
  });

  it("prices Sonnet 3x Haiku on input; an unlisted model still estimates at Sonnet — but SAYS so", () => {
    const u = { ...zero, input_tokens: 1000, output_tokens: 100 };
    const sonnet = priceUsage(u, anthropic("claude-sonnet-5"));
    expect(sonnet.micros).toBe(3 * 1000 + 15 * 100);
    expect(sonnet.basis).toBe("exact");

    // Same number as before (pricing an unknown model high is the safe
    // direction), but no longer silent — that marker is invariant I4.
    const unlisted = priceUsage(u, anthropic("claude-something-unreleased"));
    expect(unlisted.micros).toBe(sonnet.micros);
    expect(unlisted.basis).toBe("estimated");
  });
});

describe("runCombinedAnalysis", () => {
  const window: TranscriptSegment[] = [
    { session_id: "s", seq: 1, t_start: 0, t_end: 1, speaker: "USER", confidence: 1, text: "I'll send the deck Friday", final: true },
    { session_id: "s", seq: 2, t_start: 1, t_end: 2, speaker: "SYSTEM", confidence: 1, text: "Can you review the PR?", final: true },
  ];

  it("extracts all four kinds from one call and attributes SYSTEM asks by source line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        messagesResponse({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              name: "extract_analysis",
              input: {
                commitments: [{ text: "Send the deck", owner: "USER", inferred_deadline: null, confidence: 0.9, source_seq: 1 }],
                asks: [{ text: "Review the PR", requested_by: "OTHER", answered: false, confidence: 0.8, source_seq: 2 }],
                subtext: [],
                suggestions: [{ text: "Confirm Friday in writing", outcome: "deadline locked", dismissible: true, source_seq: 1 }],
              },
            },
          ],
        }),
      ),
    );
    const outcome = await runCombinedAnalysis(config, window, [], []);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.result.commitments).toHaveLength(1);
    expect(outcome.result.asks[0]!.requested_by).toBe("SYSTEM"); // seq 2 is a SYSTEM line
    expect(outcome.result.suggestions).toHaveLength(1);
    expect(outcome.result.subtext).toEqual([]);
  });

  it("degrades to empty results and reports the failure status instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const outcome = await runCombinedAnalysis(config, window, [], []);
    expect(outcome.result).toEqual({ commitments: [], asks: [], subtext: [], suggestions: [], decisions: [] });
    expect(outcome.failure?.status).toBe(401);
  });
});

describe("pingLlm", () => {
  it("distinguishes auth failures from other failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    const auth = await pingLlm(config);
    expect(auth).toMatchObject({ ok: false, kind: "auth", status: 401 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("overloaded", { status: 529 })));
    const overloaded = await pingLlm(config);
    expect(overloaded).toMatchObject({ ok: false, kind: "error", status: 529 });

    vi.stubGlobal("fetch", vi.fn(async () => messagesResponse({ content: [] })));
    const ok = await pingLlm(config);
    expect(ok).toEqual({ ok: true });
  });

  it("reports the probe's own usage, so /health/llm is not an unmetered our-key call", async () => {
    // Tiny (one token each way, ~$0.00002) but real, on our key, and previously
    // attributed to nobody — the last unmetered our-key egress in the Worker.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => messagesResponse({ content: [], usage: { input_tokens: 8, output_tokens: 1 } })),
    );
    const seen: unknown[] = [];
    const probe = await pingLlm({ ...config, onUsage: (u, leg) => seen.push({ u, leg }) });
    expect(probe).toEqual({ ok: true });
    expect(seen).toEqual([
      {
        u: { input_tokens: 8, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        leg: { provider: "anthropic", model: config.model, baseUrl: config.baseUrl, fallback: false },
      },
    ]);
  });

  it("never turns a healthy probe into a failure over bookkeeping", async () => {
    // A 200 whose body is not JSON (or carries no usage) attributes nothing and
    // still reports healthy.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const seen: unknown[] = [];
    expect(await pingLlm({ ...config, onUsage: (u) => seen.push(u) })).toEqual({ ok: true });
    expect(seen).toEqual([]);
  });
});

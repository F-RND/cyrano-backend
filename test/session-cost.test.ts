// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Per-session cost accounting (session-cost.ts) and the rate table it prices
// from (llm/pricing.ts). What is pinned here:
//
//   PRICE TABLE  every listed model has a finite rate AND a citation; the Pro+
//                candidates are listed at the numbers copied off OpenRouter's
//                models API on 2026-09-18; an unlisted model is `estimated`
//                (reported "unpriced"), never $0 and never silently exact.
//   ONE PRICE    the session ledger sees the SAME PricedUsage the per-user
//                meter folds in — the two views cannot disagree.
//   PER PASS     every callTool reports which tool produced the usage block,
//                and the session row breaks cost down by it.
//   BOUNDED      the per-session record folds its cheap tail past a cap and
//                the totals still reconcile; the registry keeps a rolling
//                window of rows.
//   CLOSED ROW   SessionCostRow's keys are pinned (BAR I7): session id, owner
//                id, timing, transcript SIZE, money. Nothing else.
//
// Every micro-dollar figure below is derived by hand from the rate stated in
// the comment above it, never from running the implementation.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callTool,
  pingLlm,
  PING_TOOL_NAME,
  type LlmCallInfo,
  type LlmConfig,
  type LlmUsage,
  type ServedLeg,
  type ToolSchema,
} from "../src/llm/client.js";
import {
  ESTIMATE_RATE,
  OPENROUTER_LISTINGS_FETCHED,
  priceTable,
  priceUsage,
  rateFor,
  type PricedUsage,
} from "../src/llm/pricing.js";
import { createSpendLedger } from "../src/llm/spend.js";
import {
  applySessionCost,
  clampSessionCostLimit,
  createSessionCostLedger,
  isEmptySessionCostDelta,
  MAX_SESSION_COST_BUCKETS,
  MAX_SESSION_COST_ROWS,
  MAX_SESSION_COST_SHADOW_BUCKETS,
  OVERFLOW_BUCKET,
  sessionCostRow,
  sessionCostRowFromWire,
  sessionCostStorageKey,
  summarizeSessionCosts,
  UNKNOWN_PASS,
  type SessionCostBucket,
  type SessionCostContext,
  type SessionCostRow,
} from "../src/session-cost.js";
import { sessionCostsQuery } from "../src/index.js";

const ZERO: LlmUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const OPENROUTER = "https://openrouter.ai/api/v1";

function orLeg(model: string, fallback = false): ServedLeg {
  return { provider: "openrouter", model, baseUrl: OPENROUTER, fallback };
}

const haikuLeg: ServedLeg = {
  provider: "anthropic",
  model: "claude-haiku-4-5",
  baseUrl: "https://api.anthropic.com/v1",
  fallback: false,
};

function priced(over: Partial<PricedUsage>): PricedUsage {
  return {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    micros: 0,
    basis: "exact",
    inputTokens: 0,
    outputTokens: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The rate table
// ---------------------------------------------------------------------------

describe("price table — every listed rate is finite, cited, and the candidates are on it", () => {
  const table = priceTable();

  it("lists no model without a finite positive rate and a source", () => {
    expect(table.models.length).toBeGreaterThan(0);
    for (const m of table.models) {
      const where = `${m.provider}/${m.model}`;
      expect(Number.isFinite(m.input_per_m) && m.input_per_m > 0, where).toBe(true);
      expect(Number.isFinite(m.output_per_m) && m.output_per_m > 0, where).toBe(true);
      expect(Number.isFinite(m.cache_read_multiplier) && m.cache_read_multiplier >= 0, where).toBe(true);
      expect(Number.isFinite(m.cache_write_multiplier) && m.cache_write_multiplier >= 0, where).toBe(true);
      expect(m.basis === "exact" || m.basis === "configured", where).toBe(true);
      expect(m.source.length, where).toBeGreaterThan(20);
    }
  });

  it("is deterministic: two calls return byte-identical tables, sorted by provider then model", () => {
    expect(JSON.stringify(priceTable())).toBe(JSON.stringify(table));
    const keys = table.models.map((m) => `${m.provider} ${m.model}`);
    expect([...keys].sort()).toEqual(keys);
  });

  it("carries the Pro+ candidates at the prices OpenRouter listed on the fetch date, marked configured", () => {
    // USD per 1M tokens, copied from GET https://openrouter.ai/api/v1/models
    // (pricing.prompt / pricing.completion are per token; x 1e6) on
    // 2026-09-18. A listed OpenRouter price is the default route's, so it is
    // `configured`, never `exact` — see OPENROUTER_LISTINGS in llm/pricing.ts.
    const expected: Record<string, [number, number]> = {
      "z-ai/glm-4.5": [0.6, 2.2],
      "z-ai/glm-4.5-air": [0.13, 0.85],
      "z-ai/glm-4.6": [0.43, 1.75],
      "z-ai/glm-4.7": [0.4, 1.75],
      "qwen/qwen3-32b": [0.08, 0.28],
      "qwen/qwen3-30b-a3b": [0.12, 0.5],
      "qwen/qwen3-30b-a3b-instruct-2507": [0.0481, 0.193],
      "qwen/qwen3.5-27b": [0.195, 1.56],
      "qwen/qwen3.6-27b": [0.3, 2.0],
      "qwen/qwen3.8-27b": [0.214, 2.55],
      "openai/gpt-oss-120b": [0.15, 0.6],
    };
    for (const [model, [input, output]] of Object.entries(expected)) {
      const { rate, basis } = rateFor("openrouter", model);
      expect(basis, model).toBe("configured");
      expect(rate.inputPerM, model).toBe(input);
      expect(rate.outputPerM, model).toBe(output);
      const entry = table.models.find((m) => m.provider === "openrouter" && m.model === model);
      expect(entry?.source, model).toContain(OPENROUTER_LISTINGS_FETCHED);
    }
  });

  it("derives cache multipliers from the listed cached-input price, and defaults to 1x (over-count) when none is listed", () => {
    // z-ai/glm-4.6 lists cached input at $0.08 against $0.43 input.
    const glm = rateFor("openrouter", "z-ai/glm-4.6").rate;
    expect(glm.cacheReadMultiplier).toBeCloseTo(0.08 / 0.43, 10);
    expect(glm.cacheWriteMultiplier).toBe(1);
    // qwen/qwen3-32b lists no cache price: reads bill as input.
    const qwen = rateFor("openrouter", "qwen/qwen3-32b").rate;
    expect(qwen.cacheReadMultiplier).toBe(1);
    expect(qwen.cacheWriteMultiplier).toBe(1);
    // Haiku via OpenRouter carries Anthropic's own 0.1x / 1.25x.
    const haiku = rateFor("openrouter", "anthropic/claude-haiku-4.5").rate;
    expect(haiku.cacheReadMultiplier).toBeCloseTo(0.1, 10);
    expect(haiku.cacheWriteMultiplier).toBeCloseTo(1.25, 10);
  });

  it("prices a candidate end to end: GLM-4.5-Air, one analysis tick", () => {
    // z-ai/glm-4.5-air $0.13 in / $0.85 out, cached input $0.025 (0.1923x).
    // 3000 fresh + 2000 cached + 400 out:
    //   3000 * 0.13 = 390; 2000 * 0.025 = 50; 400 * 0.85 = 340  → 780 micro-$.
    const p = priceUsage(
      { ...ZERO, input_tokens: 3000, cache_read_input_tokens: 2000, output_tokens: 400 },
      orLeg("z-ai/glm-4.5-air"),
    );
    expect(p).toMatchObject({ provider: "openrouter", model: "z-ai/glm-4.5-air", micros: 780, basis: "configured" });
    expect(p.inputTokens).toBe(5000);
  });

  it("reports an UNLISTED OpenRouter model as estimated — never $0, never exact", () => {
    for (const model of ["qwen/qwen3-999b", "z-ai/glm-99", "", "constructor", "__proto__", "toString"]) {
      const { rate, basis } = rateFor("openrouter", model);
      expect(basis, model).toBe("estimated");
      expect(rate).toEqual(ESTIMATE_RATE);
      // 1M input at the Sonnet estimate: 3,000,000 micro-$ — visibly a guess,
      // and the safe (high) direction for the ceiling.
      const p = priceUsage({ ...ZERO, input_tokens: 1_000_000 }, orLeg(model));
      expect(p.micros, model).toBe(3_000_000);
      expect(p.basis, model).toBe("estimated");
    }
    expect(table.estimate_rate).toEqual({ input_per_m: 3, output_per_m: 15, basis: "estimated" });
    // OpenRouter is a published card now; only the unrecognised-host account
    // has no card at all.
    expect(table.unpriced_providers.map((u) => u.provider)).toEqual(["unknown"]);
  });

  it("carries the corrected, cited Luna rate so the incumbent baseline is real", () => {
    const luna = table.models.find((m) => m.provider === "openai" && m.model === "gpt-5.6-luna");
    expect(luna).toMatchObject({ input_per_m: 0.2, output_per_m: 1.2, cache_read_multiplier: 0.1, basis: "exact" });
    expect(luna?.source).toMatch(/developers\.openai\.com/);
  });
});

// ---------------------------------------------------------------------------
// callTool tells onUsage which tool produced the block
// ---------------------------------------------------------------------------

describe("callTool reports the pass (tool name) with every usage block", () => {
  const tool: ToolSchema = {
    name: "extract_analysis",
    description: "t",
    system_prompt: "s",
    input_schema: { type: "object" },
    output_schema: { type: "object", properties: {}, required: [] },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("on the native Anthropic wire", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            stop_reason: "tool_use",
            content: [{ type: "tool_use", name: tool.name, input: {} }],
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const calls: LlmCallInfo[] = [];
    const config: LlmConfig = {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k",
      model: "claude-haiku-4-5",
      onUsage: (_u, _leg, call) => calls.push(call),
    };
    await callTool(config, tool, {});
    expect(calls).toEqual([{ tool: "extract_analysis" }]);
  });

  it("on the OpenAI-compatible wire", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              { finish_reason: "tool_calls", message: { tool_calls: [{ function: { name: tool.name, arguments: "{}" } }] } },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const calls: LlmCallInfo[] = [];
    const config: LlmConfig = {
      baseUrl: OPENROUTER,
      apiKey: "k",
      model: "z-ai/glm-4.6",
      provider: "openrouter",
      onUsage: (_u, _leg, call) => calls.push(call),
    };
    await callTool(config, tool, {});
    expect(calls).toEqual([{ tool: "extract_analysis" }]);
  });

  it("names the connection probe `ping`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const calls: LlmCallInfo[] = [];
    await pingLlm({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k",
      model: "claude-haiku-4-5",
      onUsage: (_u, _leg, call) => calls.push(call),
    });
    expect(calls).toEqual([{ tool: PING_TOOL_NAME }]);
  });
});

// ---------------------------------------------------------------------------
// The ledger — one arithmetic, keyed by pass
// ---------------------------------------------------------------------------

describe("session-cost ledger", () => {
  it("receives the SAME priced block the per-user meter folds in, keyed by pass", () => {
    const session = createSessionCostLedger();
    const spend = createSpendLedger(undefined, session);
    // Haiku $1/$5: 1000 in + 100 out = 1500 micro-$, twice on the analysis
    // pass; once 200 in + 20 out = 300 on the whisper pass.
    const u = { ...ZERO, input_tokens: 1000, output_tokens: 100 };
    spend.recordServed(u, haikuLeg, { tool: "extract_analysis" });
    spend.recordServed(u, haikuLeg, { tool: "extract_analysis" });
    spend.recordServed({ ...ZERO, input_tokens: 200, output_tokens: 20 }, haikuLeg, { tool: "generate_whisper" });
    spend.recordByok({ tool: "extract_analysis" });

    const delta = session.peek();
    expect(delta.byokCalls).toBe(1);
    expect(delta.buckets).toEqual([
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        pass: "extract_analysis",
        calls: 2,
        inputTokens: 2000,
        outputTokens: 200,
        micros: 3000,
        basis: "exact",
      },
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        pass: "generate_whisper",
        calls: 1,
        inputTokens: 200,
        outputTokens: 20,
        micros: 300,
        basis: "exact",
      },
    ]);
    // Reconciles with the per-user meter to the micro-dollar.
    const meter = spend.peek();
    expect(meter.micros).toBe(3300);
    expect(delta.buckets.reduce((s, b) => s + b.micros, 0)).toBe(meter.micros);
  });

  it("keeps shadow spend in its own flagged buckets, on the analysis pass", () => {
    const session = createSessionCostLedger();
    const spend = createSpendLedger(undefined, session);
    spend.recordShadow(priced({ provider: "openrouter", model: "z-ai/glm-4.6", micros: 780, inputTokens: 5000, outputTokens: 400, basis: "configured" }));
    spend.recordServed({ ...ZERO, input_tokens: 1000 }, haikuLeg, { tool: "extract_analysis" });
    const delta = session.peek();
    expect(delta.buckets).toHaveLength(2);
    const shadow = delta.buckets.find((b) => b.shadow === true);
    expect(shadow).toMatchObject({ provider: "openrouter", model: "z-ai/glm-4.6", pass: "extract_analysis", micros: 780 });
    const charged = delta.buckets.find((b) => b.shadow === undefined);
    expect(charged).toMatchObject({ provider: "anthropic", micros: 1000 });
    expect(Object.hasOwn(charged!, "shadow")).toBe(false);
  });

  it("names a block with no call info `(unknown)` rather than dropping it", () => {
    const session = createSessionCostLedger();
    const spend = createSpendLedger(undefined, session);
    spend.recordServed({ ...ZERO, input_tokens: 1000 }, haikuLeg);
    expect(session.peek().buckets[0]).toMatchObject({ pass: UNKNOWN_PASS, micros: 1000 });
  });

  it("take() drains and peek() does not", () => {
    const session = createSessionCostLedger();
    session.onServed(priced({ micros: 5, inputTokens: 1 }), { tool: "t" });
    expect(isEmptySessionCostDelta(session.peek())).toBe(false);
    expect(session.take().buckets).toHaveLength(1);
    expect(isEmptySessionCostDelta(session.take())).toBe(true);
    expect(isEmptySessionCostDelta(session.peek())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Persisted state — merge and bound
// ---------------------------------------------------------------------------

function bucket(over: Partial<SessionCostBucket>): SessionCostBucket {
  return {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    pass: "extract_analysis",
    calls: 1,
    inputTokens: 100,
    outputTokens: 10,
    micros: 150,
    basis: "exact",
    ...over,
  };
}

describe("applySessionCost", () => {
  it("folds a delta into the stored record bucket by bucket, worst basis wins", () => {
    const prev = applySessionCost(undefined, {
      buckets: [bucket({ micros: 150 }), bucket({ pass: "generate_whisper", micros: 30 })],
      byokCalls: 1,
    });
    const next = applySessionCost(prev, {
      buckets: [bucket({ micros: 150, basis: "configured" })],
      byokCalls: 2,
    });
    expect(next.byokCalls).toBe(3);
    expect(next.buckets).toEqual([
      bucket({ calls: 2, inputTokens: 200, outputTokens: 20, micros: 300, basis: "configured" }),
      bucket({ pass: "generate_whisper", micros: 30 }),
    ]);
  });

  it("bounds the charged class, folds the cheap tail, and still reconciles", () => {
    const many = Array.from({ length: MAX_SESSION_COST_BUCKETS + 5 }, (_, i) =>
      bucket({ pass: `pass-${String(i).padStart(3, "0")}`, micros: 1000 - i, basis: i === 0 ? "exact" : "estimated" }),
    );
    const total = many.reduce((s, b) => s + b.micros, 0);
    const state = applySessionCost(undefined, { buckets: many, byokCalls: 0 });
    expect(state.buckets).toHaveLength(MAX_SESSION_COST_BUCKETS);
    const overflow = state.buckets.find((b) => b.pass === OVERFLOW_BUCKET);
    expect(overflow).toMatchObject({ provider: OVERFLOW_BUCKET, model: OVERFLOW_BUCKET, calls: 6, basis: "estimated" });
    expect(state.buckets.reduce((s, b) => s + b.micros, 0)).toBe(total);
    // The kept buckets are the expensive head.
    expect(state.buckets[0]).toMatchObject({ pass: "pass-000", micros: 1000 });
  });

  it("bounds shadow buckets separately and never folds them into the charged overflow", () => {
    const shadow = Array.from({ length: MAX_SESSION_COST_SHADOW_BUCKETS + 2 }, (_, i) =>
      bucket({ provider: "openrouter", model: `m${i}`, micros: 10, shadow: true }),
    );
    const state = applySessionCost(undefined, { buckets: [bucket({ micros: 5 }), ...shadow], byokCalls: 0 });
    const charged = state.buckets.filter((b) => b.shadow === undefined);
    const shadowed = state.buckets.filter((b) => b.shadow === true);
    expect(charged).toEqual([bucket({ micros: 5 })]);
    expect(shadowed).toHaveLength(MAX_SESSION_COST_SHADOW_BUCKETS);
    expect(shadowed.reduce((s, b) => s + b.micros, 0)).toBe(10 * (MAX_SESSION_COST_SHADOW_BUCKETS + 2));
  });

  it("coerces junk off storage: NaN micros read 0, an unknown basis reads estimated", () => {
    const state = applySessionCost(undefined, {
      buckets: [bucket({ micros: Number.NaN, basis: "exactly" as never })],
      byokCalls: -3,
    });
    expect(state.buckets[0]).toMatchObject({ micros: 0, basis: "estimated" });
    expect(state.byokCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-09-18T10:00:00.000Z");

function ctx(over: Partial<SessionCostContext> = {}): SessionCostContext {
  return {
    sessionId: "sess_1",
    ownerUserId: null,
    createdAt: T0,
    endedAt: T0 + 30_000,
    now: T0 + 60_000,
    transcriptSegments: 12,
    transcriptWords: 250,
    configured: { provider: "openrouter", model: "z-ai/glm-4.6" },
    ...over,
  };
}

const ROW_KEYS = [
  "session_id",
  "owner_user_id",
  "started_at",
  "ended_at",
  "duration_ms",
  "transcript_segments",
  "transcript_words",
  "configured_provider",
  "configured_model",
  "calls",
  "input_tokens",
  "output_tokens",
  "micros",
  "usd",
  "usd_per_minute",
  "usd_per_1k_words",
  "basis",
  "priced_micros",
  "estimated_micros",
  "unpriced_models",
  "models",
  "passes",
  "byok_calls",
  "shadow_micros",
  "shadow_models",
] as const;

describe("sessionCostRow", () => {
  it("is a CLOSED shape (I7): these keys and no others", () => {
    const row = sessionCostRow(undefined, ctx());
    expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort());
    const wire = sessionCostRowFromWire(JSON.parse(JSON.stringify(row)));
    expect(Object.keys(wire!).sort()).toEqual([...ROW_KEYS].sort());
  });

  it("computes $/minute and $/1k words from the session's own duration and size", () => {
    // 1650 micro-$ over a 30 s session with 250 words:
    //   usd = 0.00165
    //   per minute = 1650 / 0.5 = 3300 micro-$ → 0.0033
    //   per 1k words = 1650 / 0.25 = 6600 micro-$ → 0.0066
    const state = applySessionCost(undefined, {
      buckets: [
        bucket({ provider: "openrouter", model: "z-ai/glm-4.6", micros: 1500, basis: "configured", calls: 3, inputTokens: 3000, outputTokens: 300 }),
        bucket({ provider: "openrouter", model: "z-ai/glm-4.6", pass: "generate_whisper", micros: 150, basis: "configured", calls: 2, inputTokens: 200, outputTokens: 40 }),
      ],
      byokCalls: 0,
    });
    const row = sessionCostRow(state, ctx());
    expect(row).toMatchObject({
      session_id: "sess_1",
      started_at: "2026-09-18T10:00:00.000Z",
      ended_at: "2026-09-18T10:00:30.000Z",
      duration_ms: 30_000,
      transcript_segments: 12,
      transcript_words: 250,
      configured_provider: "openrouter",
      configured_model: "z-ai/glm-4.6",
      calls: 5,
      input_tokens: 3200,
      output_tokens: 340,
      micros: 1650,
      usd: 0.00165,
      usd_per_minute: 0.0033,
      usd_per_1k_words: 0.0066,
      basis: "configured",
      priced_micros: 1650,
      estimated_micros: 0,
      unpriced_models: [],
      byok_calls: 0,
      shadow_micros: 0,
      shadow_models: [],
    });
    expect(row.models).toEqual([
      { provider: "openrouter", model: "z-ai/glm-4.6", calls: 5, input_tokens: 3200, output_tokens: 340, micros: 1650, basis: "configured" },
    ]);
    // Passes, most expensive first.
    expect(row.passes).toEqual([
      { pass: "extract_analysis", calls: 3, input_tokens: 3000, output_tokens: 300, micros: 1500, basis: "configured" },
      { pass: "generate_whisper", calls: 2, input_tokens: 200, output_tokens: 40, micros: 150, basis: "configured" },
    ]);
  });

  it("names an unpriced model and keeps its micro-dollars out of priced_micros", () => {
    const state = applySessionCost(undefined, {
      buckets: [
        bucket({ micros: 1500 }),
        bucket({ provider: "openrouter", model: "qwen/qwen3-999b", micros: 30_000, basis: "estimated" }),
      ],
      byokCalls: 0,
    });
    const row = sessionCostRow(state, ctx());
    expect(row.micros).toBe(31_500);
    expect(row.priced_micros).toBe(1500);
    expect(row.estimated_micros).toBe(30_000);
    expect(row.unpriced_models).toEqual(["openrouter/qwen/qwen3-999b"]);
    // One estimate in the pile makes the pile an estimate.
    expect(row.basis).toBe("estimated");
  });

  it("measures a live session to `now`, an ended one to `ended_at`, and declines to divide by nothing", () => {
    const state = applySessionCost(undefined, { buckets: [bucket({ micros: 600 })], byokCalls: 0 });
    const live = sessionCostRow(state, ctx({ endedAt: null, now: T0 + 120_000 }));
    expect(live.ended_at).toBeNull();
    expect(live.duration_ms).toBe(120_000);
    expect(live.usd_per_minute).toBe(0.0003);

    const zero = sessionCostRow(state, ctx({ endedAt: T0, transcriptWords: 0 }));
    expect(zero.duration_ms).toBe(0);
    expect(zero.usd_per_minute).toBeNull();
    expect(zero.usd_per_1k_words).toBeNull();

    const empty = sessionCostRow(undefined, ctx());
    expect(empty).toMatchObject({ calls: 0, micros: 0, usd: 0, basis: null, models: [], passes: [] });
  });

  it("reports shadow spend beside, never inside, the charged figures", () => {
    const state = applySessionCost(undefined, {
      buckets: [
        bucket({ micros: 1000 }),
        bucket({ provider: "openrouter", model: "z-ai/glm-4.6", micros: 780, basis: "configured", shadow: true }),
      ],
      byokCalls: 2,
    });
    const row = sessionCostRow(state, ctx());
    expect(row.micros).toBe(1000);
    expect(row.shadow_micros).toBe(780);
    expect(row.shadow_models).toEqual([
      { provider: "openrouter", model: "z-ai/glm-4.6", calls: 1, input_tokens: 100, output_tokens: 10, micros: 780, basis: "configured" },
    ]);
    expect(row.byok_calls).toBe(2);
    expect(row.models).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Wire re-validation at the registry
// ---------------------------------------------------------------------------

describe("sessionCostRowFromWire", () => {
  it("refuses a body with nothing to file it under", () => {
    expect(sessionCostRowFromWire(null)).toBeNull();
    expect(sessionCostRowFromWire({})).toBeNull();
    expect(sessionCostRowFromWire({ session_id: "s" })).toBeNull();
    expect(sessionCostRowFromWire({ session_id: "s", started_at: "not a date" })).toBeNull();
  });

  it("round-trips a real row and RECOMPUTES the derived money columns from the integers", () => {
    const state = applySessionCost(undefined, { buckets: [bucket({ micros: 1650 })], byokCalls: 0 });
    const row = sessionCostRow(state, ctx());
    const tampered = { ...JSON.parse(JSON.stringify(row)), usd: 99, usd_per_minute: 99, priced_micros: 99_999 };
    const back = sessionCostRowFromWire(tampered)!;
    expect(back).toEqual(row);
  });

  it("clamps junk and caps arrays", () => {
    const back = sessionCostRowFromWire({
      session_id: "x".repeat(500),
      started_at: "2026-09-18T10:00:00.000Z",
      micros: Number.NaN,
      estimated_micros: 5,
      duration_ms: -1,
      models: Array.from({ length: 200 }, () => ({ provider: "p", model: "m", micros: "12" })),
      unpriced_models: [1, "a", null],
      basis: "bogus",
    })!;
    expect(back.session_id).toHaveLength(128);
    expect(back.micros).toBe(0);
    // estimated cannot exceed micros.
    expect(back.estimated_micros).toBe(0);
    expect(back.priced_micros).toBe(0);
    expect(back.duration_ms).toBe(0);
    expect(back.usd_per_minute).toBeNull();
    expect(back.models).toHaveLength(MAX_SESSION_COST_BUCKETS);
    expect(back.models[0]).toMatchObject({ provider: "p", model: "m", micros: 0, basis: "estimated" });
    expect(back.unpriced_models).toEqual(["a"]);
    expect(back.basis).toBe("estimated");
  });
});

// ---------------------------------------------------------------------------
// The listing — sessions side by side, rolled up per model
// ---------------------------------------------------------------------------

describe("summarizeSessionCosts", () => {
  function row(over: Partial<SessionCostRow>): SessionCostRow {
    return sessionCostRowFromWire({
      session_id: "s",
      started_at: "2026-09-18T10:00:00.000Z",
      ended_at: "2026-09-18T10:01:00.000Z",
      duration_ms: 60_000,
      transcript_words: 100,
      ...over,
    })!;
  }

  it("totals across the page and rolls up per model, most spend first", () => {
    const glm = { provider: "openrouter", model: "z-ai/glm-4.6", calls: 4, input_tokens: 4000, output_tokens: 400, micros: 2000, basis: "configured" as const };
    const qwen = { provider: "openrouter", model: "qwen/qwen3-32b", calls: 4, input_tokens: 4000, output_tokens: 400, micros: 400, basis: "configured" as const };
    const rows = [
      row({ session_id: "a", micros: 2000, calls: 4, models: [glm] }),
      row({ session_id: "b", micros: 2000, calls: 4, models: [glm], duration_ms: 120_000, transcript_words: 300 }),
      row({ session_id: "c", micros: 400, calls: 4, models: [qwen], unpriced_models: ["openrouter/x"], estimated_micros: 100 }),
      row({ session_id: "d", micros: 0, calls: 0, byok_calls: 3 }),
    ];
    const report = summarizeSessionCosts(rows, { now: T0, limit: 50 });
    expect(report.returned).toBe(4);
    expect(report.totals).toMatchObject({
      sessions: 4,
      sessions_with_cost: 3,
      sessions_with_unpriced: 1,
      calls: 12,
      micros: 4400,
      usd: 0.0044,
      priced_micros: 4300,
      estimated_micros: 100,
      duration_ms: 300_000,
      transcript_words: 600,
      // 4400 micro-$ over 5 minutes = 880 micro-$/min → 0.00088
      usd_per_minute: 0.00088,
      byok_calls: 3,
    });
    expect(report.by_model.map((m) => m.model)).toEqual(["z-ai/glm-4.6", "qwen/qwen3-32b"]);
    // GLM: 4000 micro-$ over 3 minutes (60 s + 120 s) = 1333.33 → 0.001333
    expect(report.by_model[0]).toMatchObject({
      sessions: 2,
      calls: 8,
      micros: 4000,
      usd: 0.004,
      duration_ms: 180_000,
      usd_per_minute: 0.001333,
      transcript_words: 400,
      usd_per_1k_words: 0.01,
      basis: "configured",
    });
    // Qwen: 400 over 1 minute → 0.0004
    expect(report.by_model[1]).toMatchObject({ sessions: 1, micros: 400, usd_per_minute: 0.0004 });
  });

  it("clamps the page to the bound", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ session_id: `s${i}` }));
    expect(summarizeSessionCosts(rows, { now: T0, limit: 3 }).sessions.map((r) => r.session_id)).toEqual(["s0", "s1", "s2"]);
    expect(summarizeSessionCosts(rows, { now: T0, limit: 10_000 }).limit).toBe(MAX_SESSION_COST_ROWS);
    expect(clampSessionCostLimit(null)).toBe(50);
    expect(clampSessionCostLimit("abc")).toBe(50);
    expect(clampSessionCostLimit("0")).toBe(1);
    expect(clampSessionCostLimit("999")).toBe(MAX_SESSION_COST_ROWS);
  });
});

describe("registry storage key and router query", () => {
  it("orders rows by end time so a reverse prefix list is newest first", () => {
    const older = sessionCostStorageKey(T0, "zzz");
    const newer = sessionCostStorageKey(T0 + 1, "aaa");
    expect(older < newer).toBe(true);
    expect(newer.startsWith("sessioncost:")).toBe(true);
  });

  it("forwards only limit and user_id, re-encoded and bounded", () => {
    const url = new URL("https://x/costs/sessions?limit=5&user_id=u_1&scan=9&cursor=x#frag");
    expect(sessionCostsQuery(url)).toBe("?limit=5&user_id=u_1");
    expect(sessionCostsQuery(new URL("https://x/costs/sessions"))).toBe("");
    const long = new URL(`https://x/costs/sessions?user_id=${"a".repeat(300)}`);
    expect(new URLSearchParams(sessionCostsQuery(long)).get("user_id")).toHaveLength(128);
  });
});

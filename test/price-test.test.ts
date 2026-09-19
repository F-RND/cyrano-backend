// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Shadow price-testing harness (analysis/price-test.ts) — the pure parsing,
// sampling, aggregation, and reporting logic. The DO wiring is covered by the
// session tests; here we pin the market-testing math so cost inference and the
// end-of-session report stay stable as targets are rotated in and out.

import { describe, expect, it } from "vitest";
import {
  parsePriceTargets,
  priceTestEnabled,
  priceTestSampleRate,
  runShadowPass,
  mergeAgg,
  buildReport,
  type TargetAgg,
} from "../src/analysis/price-test.js";
import { usageMicrosAt, type LlmConfig } from "../src/llm/client.js";
import type { Env } from "../src/env.js";
import { transcriptContentLoggingEnabled } from "../src/env.js";

function env(overrides: Partial<Env>): Env {
  return overrides as Env;
}

describe("priceTestEnabled / sample rate", () => {
  it("keeps transcript content logging fail-closed", () => {
    expect(transcriptContentLoggingEnabled(env({}))).toBe(false);
    expect(transcriptContentLoggingEnabled(env({ TRANSCRIPT_CONTENT_LOGGING: "false" }))).toBe(false);
    expect(transcriptContentLoggingEnabled(env({ TRANSCRIPT_CONTENT_LOGGING: "1" }))).toBe(false);
    expect(transcriptContentLoggingEnabled(env({ TRANSCRIPT_CONTENT_LOGGING: "true" }))).toBe(true);
  });

  it("is off unless explicitly 'true'", () => {
    expect(priceTestEnabled(env({}))).toBe(false);
    expect(priceTestEnabled(env({ PRICE_TEST_ENABLED: "1" }))).toBe(false);
    expect(priceTestEnabled(env({ PRICE_TEST_ENABLED: "true" }))).toBe(true);
  });

  it("defaults sample rate to 1 and clamps to [0,1]", () => {
    expect(priceTestSampleRate(env({}))).toBe(1);
    expect(priceTestSampleRate(env({ PRICE_TEST_SAMPLE_RATE: "0.25" }))).toBe(0.25);
    expect(priceTestSampleRate(env({ PRICE_TEST_SAMPLE_RATE: "5" }))).toBe(1);
    expect(priceTestSampleRate(env({ PRICE_TEST_SAMPLE_RATE: "-2" }))).toBe(0);
    expect(priceTestSampleRate(env({ PRICE_TEST_SAMPLE_RATE: "junk" }))).toBe(1);
  });
});

describe("parsePriceTargets", () => {
  it("returns [] for unset / invalid JSON / non-array", () => {
    expect(parsePriceTargets(env({}))).toEqual([]);
    expect(parsePriceTargets(env({ PRICE_TEST_TARGETS: "not json" }))).toEqual([]);
    expect(parsePriceTargets(env({ PRICE_TEST_TARGETS: '{"label":"x"}' }))).toEqual([]);
  });

  it("keeps well-formed targets and drops malformed / duplicate ones", () => {
    const raw = JSON.stringify([
      { label: "ok", provider: "openrouter", baseUrl: "https://u/v1", model: "m", keyEnv: "K", inputPerM: 1, outputPerM: 2 },
      { label: "bad-provider", provider: "gemini", baseUrl: "https://u/v1", model: "m", keyEnv: "K", inputPerM: 1, outputPerM: 2 },
      // Half a rate would price the other side of every call at zero — worse
      // than declaring none, which is now legal.
      { label: "half-rate", provider: "anthropic", baseUrl: "https://u/v1", model: "m", keyEnv: "K", inputPerM: 1 },
      { label: "ok", provider: "anthropic", baseUrl: "https://u/v1", model: "dupe", keyEnv: "K", inputPerM: 1, outputPerM: 2 },
    ]);
    const targets = parsePriceTargets(env({ PRICE_TEST_TARGETS: raw }));
    expect(targets.map((t) => t.label)).toEqual(["ok"]);
    expect(targets[0]!.model).toBe("m");
  });

  it("drops unsupported providers", () => {
    const raw = JSON.stringify([
      {
        label: "unsupported",
        provider: "custom",
        baseUrl: "https://example.test/v1",
        model: "openai/gpt-oss-120b",
        keyEnv: "CUSTOM_API_KEY",
      },
    ]);
    const targets = parsePriceTargets(env({ PRICE_TEST_TARGETS: raw }));
    expect(targets).toEqual([]);
  });
});

describe("usageMicrosAt", () => {
  it("prices at the supplied per-1M rate with Anthropic cache ratios", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    // $1/M in, $5/M out → 1e6 in-micros + 5e6 out-micros.
    expect(usageMicrosAt(usage, 1, 5)).toBe(6_000_000);
  });
});

describe("runShadowPass", () => {
  const target = {
    label: "t1",
    provider: "openrouter" as const,
    baseUrl: "https://u/v1",
    model: "m",
    keyEnv: "OPENROUTER_API_KEY",
    inputPerM: 1,
    outputPerM: 5,
  };

  it("skips targets whose key is absent", async () => {
    const deltas = await runShadowPass(
      env({ PRICE_TEST_TARGETS: JSON.stringify([target]) }),
      [target],
      async () => ({ ok: true }),
      () => 0,
    );
    expect(deltas).toEqual([]);
  });

  it("records cost, conformance, latency, and sample for a successful run", async () => {
    let clock = 0;
    const deltas = await runShadowPass(
      env({ OPENROUTER_API_KEY: "sk-x" }),
      [target],
      async (config: LlmConfig) => {
        // Simulate the client reporting usage back through onUsage. The second
        // argument is the leg that produced the block (llm/client.ts tags every
        // usage report with it so a failed-over call is priced at what ran).
        config.onUsage?.(
          {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          { provider: config.provider ?? "anthropic", model: config.model, baseUrl: config.baseUrl, fallback: false },
          { tool: "extract_analysis" },
        );
        clock += 42;
        return { ok: true, sample: { commitments: ["c"] } };
      },
      () => clock,
    );
    expect(deltas).toHaveLength(1);
    const d = deltas[0]!;
    expect(d).toMatchObject({
      label: "t1",
      calls: 1,
      schema_ok: 1,
      schema_fail: 0,
      errors: 0,
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cost_micros: 6_000_000,
      latency_ms_total: 42,
    });
    expect(d.sample_output).toEqual({ commitments: ["c"] });
  });

  it("hands every priced shadow block to the spend sink, at the target's own rate", async () => {
    // The DO wires this sink to SpendLedger.recordShadow, which is what makes
    // the fan-out's dollars land on the session owner's meter instead of a
    // console.log. Both figures come from the same priced block, so the
    // comparison report and the meter cannot disagree.
    const spent: Array<{ micros: number; basis: string; provider: string; model: string }> = [];
    const deltas = await runShadowPass(
      env({ OPENROUTER_API_KEY: "sk-x" }),
      [target],
      async (config: LlmConfig) => {
        config.onUsage?.(
          {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          { provider: config.provider ?? "anthropic", model: config.model, baseUrl: config.baseUrl, fallback: false },
          { tool: "extract_analysis" },
        );
        return { ok: true };
      },
      () => 0,
      (priced) => spent.push(priced),
    );
    // $1/M in, $5/M out on 1M + 1M = 1,000,000 + 5,000,000 micro-$.
    expect(spent).toHaveLength(1);
    expect(spent[0]!.micros).toBe(6_000_000);
    expect(deltas[0]!.cost_micros).toBe(6_000_000);
    // An operator-typed rate is an operator-CONFIGURED rate — never "exact".
    expect(spent[0]!.basis).toBe("configured");
    expect(deltas[0]!.cost_basis).toBe("configured");
    // Base URL "https://u/v1" is a host we hold no account for, and the price
    // model says so rather than guessing an account.
    expect(spent[0]!.provider).toBe("unknown");
  });

  it("prices a target with no declared rates off the shared rate cards", async () => {
    const anthropicTarget = {
      label: "anthropic-haiku",
      provider: "anthropic" as const,
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-haiku-4-5",
      keyEnv: "ANTHROPIC_API_KEY",
    };
    const deltas = await runShadowPass(
      env({ ANTHROPIC_API_KEY: "sk-x" } as Partial<Env>),
      [anthropicTarget],
      async (config: LlmConfig) => {
        config.onUsage?.(
          {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          { provider: "anthropic", model: config.model, baseUrl: config.baseUrl, fallback: false },
          { tool: "extract_analysis" },
        );
        return { ok: true };
      },
      () => 0,
    );
    expect(deltas[0]!.cost_micros).toBe(6_000_000);
    expect(deltas[0]!.cost_basis).toBe("exact");
  });

  it("counts a non-conformant result as schema_fail, and a throw as an error", async () => {
    const okFail = await runShadowPass(
      env({ OPENROUTER_API_KEY: "sk-x" }),
      [target],
      async () => ({ ok: false }),
      () => 0,
    );
    expect(okFail[0]).toMatchObject({ schema_ok: 0, schema_fail: 1, errors: 0 });

    const threw = await runShadowPass(
      env({ OPENROUTER_API_KEY: "sk-x" }),
      [target],
      async () => {
        throw new Error("boom");
      },
      () => 0,
    );
    expect(threw[0]).toMatchObject({ schema_ok: 0, schema_fail: 0, errors: 1 });
    expect(threw[0]!.last_error).toContain("boom");
  });
});

describe("mergeAgg + buildReport", () => {
  it("folds deltas by label and derives per-call rates, cheapest first", () => {
    const agg: Record<string, TargetAgg> = {};
    const mk = (label: string, cost: number, ok: number): TargetAgg => ({
      label,
      model: label,
      calls: 1,
      schema_ok: ok,
      schema_fail: 1 - ok,
      errors: 0,
      input_tokens: 100,
      output_tokens: 50,
      cost_micros: cost,
      cost_basis: "configured",
      latency_ms_total: 200,
    });
    mergeAgg(agg, [mk("cheap", 10, 1), mk("pricey", 100, 1)]);
    mergeAgg(agg, [mk("cheap", 10, 0), mk("pricey", 100, 1)]);

    expect(agg.cheap!.calls).toBe(2);
    expect(agg.cheap!.cost_micros).toBe(20);
    expect(agg.cheap!.schema_ok).toBe(1);

    const report = buildReport("sess-1", agg);
    expect(report.type).toBe("price_test_report");
    expect(report.session_id).toBe("sess-1");
    // Cheapest per-call first.
    expect(report.targets.map((t) => t.label)).toEqual(["cheap", "pricey"]);
    const cheap = report.targets[0]!;
    expect(cheap.conformance).toBe(0.5); // 1 ok / 2 calls
    expect(cheap.cost_micros_per_call).toBe(10);
    expect(cheap.avg_latency_ms).toBe(200);
  });

  it("never promotes an accumulator with NO recorded basis to the delta's basis", () => {
    // `pricetest:agg` is persisted in DO storage, so a blob written before
    // cost_basis existed comes back without it. Folding an `exact` delta into
    // that must not make the session's total read `exact` — an accumulator
    // whose provenance we cannot read is an estimate, same rule usage.ts
    // applies to an unrecognised basis off the wire.
    const legacy = {
      label: "anthropic-haiku-4-5",
      model: "claude-haiku-4-5",
      calls: 3,
      schema_ok: 3,
      schema_fail: 0,
      errors: 0,
      input_tokens: 300,
      output_tokens: 150,
      cost_micros: 900,
      latency_ms_total: 600,
      // cost_basis deliberately absent — this is the pre-2026-08-19 shape.
    } as unknown as TargetAgg;
    const agg: Record<string, TargetAgg> = { "anthropic-haiku-4-5": legacy };
    mergeAgg(agg, [
      {
        label: "anthropic-haiku-4-5",
        model: "claude-haiku-4-5",
        calls: 1,
        schema_ok: 1,
        schema_fail: 0,
        errors: 0,
        input_tokens: 100,
        output_tokens: 50,
        cost_micros: 300,
        cost_basis: "exact",
        latency_ms_total: 200,
      },
    ]);
    expect(agg["anthropic-haiku-4-5"]!.cost_basis).toBe("estimated");
    expect(agg["anthropic-haiku-4-5"]!.cost_micros).toBe(1200);
  });
});

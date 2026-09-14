// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Shadow price-testing — a market-testing harness that measures what each
// candidate provider/model would cost and how reliably it holds the analysis
// schema, WITHOUT changing what the live copilot runs.
//
// When PRICE_TEST_ENABLED is set, the Session DO calls runShadowPass() after
// each real analysis window. Every configured target runs the SAME window on
// OUR key (never a BYOK key), in parallel, purely for measurement. Per-target
// deltas are merged into a session accumulator and emitted as a structured
// report at session end (console.log for `wrangler tail`/Logpush, plus a
// persisted snapshot). See docs and wrangler.jsonc for the target format.
//
// Measurement-only calls still spend real money. Every usage block here is
// priced through llm/pricing.ts (one cost model, with a
// basis) and reported to the session owner's meter as SHADOW spend via
// `onShadowSpend` → `SpendLedger.recordShadow` — attributed as a fact, and
// deliberately excluded from the anti-abuse ceiling, because a user must never
// be cut off for spend they did not ask for. See usage.ts `UsageLeg.shadow`.

import type { Env } from "../env.js";
import { transcriptContentLoggingEnabled } from "../env.js";
import { asProvider, type LlmConfig, type LlmUsage, type LlmProvider, type ServedLeg } from "../llm/client.js";
import {
  billingProviderFor,
  priceUsage,
  priceUsageWithRate,
  pricingOptionsFromEnv,
  rateFor,
  worseBasis,
  type PriceBasis,
  type PricedUsage,
} from "../llm/pricing.js";

export interface PriceTarget {
  /** Stable label used as the report key — keep it unique across targets. */
  label: string;
  provider: LlmProvider;
  /** Anthropic-compatible /v1 root for "anthropic"; OpenAI-compatible /v1 root
   * (OpenRouter, OpenAI, …) for "openrouter". */
  baseUrl: string;
  model: string;
  /** Name of the Env field holding this target's API key (a secret or var).
   * Resolved dynamically so keys stay in secrets, out of PRICE_TEST_TARGETS. */
  keyEnv: string;
  /**
   * OPTIONAL operator-declared list price, USD per 1,000,000 tokens. Both or
   * neither.
   *
   * These used to be required, and the shadow pass priced with them through a
   * private copy of the cost arithmetic — a second, provenance-free cost model
   * of exactly the shape stage B deleted everywhere else. They survive because
   * a price test is by definition aimed at providers we hold no rate card for
   * (pricing an OpenRouter candidate off the Sonnet ESTIMATE_RATE would make
   * the comparison report meaningless), but they are now just an operator-
   * supplied rate: fed through llm/pricing.ts like everything else and recorded
   * with `basis: "configured"`. Omit them and the target prices off the shared
   * rate cards at whatever basis those carry.
   */
  inputPerM?: number;
  outputPerM?: number;
}

/** Running totals for one target across a session. Serializable — persisted in
 * DO storage under `pricetest:agg` so the end-of-session report survives
 * hibernation. */
export interface TargetAgg {
  label: string;
  model: string;
  calls: number;
  /** Calls that returned a valid, schema-conformant forced-tool result. */
  schema_ok: number;
  /** Calls that ran but produced no usable structured result (the key metric
   * for weak/legacy models that can't hold forced tool-calling). */
  schema_fail: number;
  /** Calls that threw before returning (network, auth, timeout). */
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  /** How much to trust `cost_micros` — the same provenance every other priced
   * figure in the backend carries (llm/pricing.ts PriceBasis). A target that
   * declares its own rates reads "configured"; one priced off a rate card reads
   * whatever that card says. */
  cost_basis: PriceBasis;
  latency_ms_total: number;
  last_error?: string;
  /** Most recent window's extraction, kept for eyeballing output quality. */
  sample_output?: unknown;
}

export function priceTestEnabled(env: Env): boolean {
  return env.PRICE_TEST_ENABLED === "true";
}

/** Fraction of windows to shadow, clamped to [0, 1]; defaults to 1. */
export function priceTestSampleRate(env: Env): number {
  const raw = env.PRICE_TEST_SAMPLE_RATE;
  if (raw === undefined) return 1;
  const r = Number(raw);
  return Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 1;
}


/** Parse and validate PRICE_TEST_TARGETS. Malformed entries are dropped with a
 * log line rather than failing the session — a bad target must never break a
 * live call. Returns [] when unset, invalid JSON, or empty. */
export function parsePriceTargets(env: Env): PriceTarget[] {
  const raw = env.PRICE_TEST_TARGETS;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("PRICE_TEST_TARGETS is not valid JSON — price-testing disabled");
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error("PRICE_TEST_TARGETS must be a JSON array — price-testing disabled");
    return [];
  }
  const out: PriceTarget[] = [];
  const seen = new Set<string>();
  for (const t of parsed) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    // Rates are optional, but both-or-neither: one alone would price the other
    // side of the call at zero, which is worse than having no rate at all.
    const hasInput = typeof o.inputPerM === "number" && Number.isFinite(o.inputPerM) && o.inputPerM >= 0;
    const hasOutput = typeof o.outputPerM === "number" && Number.isFinite(o.outputPerM) && o.outputPerM >= 0;
    // Operator-supplied, so the same parser (and "openai" alias) as the env tags.
    const provider = asProvider(o.provider);
    if (
      typeof o.label !== "string" ||
      provider === undefined ||
      typeof o.baseUrl !== "string" ||
      typeof o.model !== "string" ||
      typeof o.keyEnv !== "string" ||
      (o.inputPerM !== undefined || o.outputPerM !== undefined ? !(hasInput && hasOutput) : false)
    ) {
      console.error(`price-test target skipped (bad shape): ${JSON.stringify(t)}`);
      continue;
    }
    if (seen.has(o.label)) {
      console.error(`price-test target skipped (duplicate label): ${o.label}`);
      continue;
    }
    seen.add(o.label);
    out.push({
      label: o.label,
      provider,
      baseUrl: o.baseUrl,
      model: o.model,
      keyEnv: o.keyEnv,
      ...(hasInput && hasOutput
        ? { inputPerM: o.inputPerM as number, outputPerM: o.outputPerM as number }
        : {}),
    });
  }
  return out;
}

/**
 * Price one shadow usage block for one target — the ONLY place a shadow
 * micro-dollar is computed, and it runs through llm/pricing.ts like every other
 * figure in the backend.
 *
 * A target that declares its own rates gets them, recorded `configured` (an
 * operator-supplied rate is exactly what that basis means), inheriting the
 * resolved billing provider's cache multipliers so an Anthropic target keeps
 * Anthropic's 1.25x/0.1x and a flat-rate provider gets 1x/1x. A target with no
 * declared rates prices off the shared cards at whatever basis they carry.
 */
export function priceShadowUsage(usage: LlmUsage, leg: ServedLeg, target: PriceTarget, env: Env): PricedUsage {
  const opts = pricingOptionsFromEnv(env);
  if (target.inputPerM === undefined || target.outputPerM === undefined) {
    return priceUsage(usage, leg, opts);
  }
  const provider = billingProviderFor(leg);
  const card = rateFor(provider, leg.model, opts).rate;
  return priceUsageWithRate(
    usage,
    { provider, model: leg.model },
    {
      inputPerM: target.inputPerM,
      outputPerM: target.outputPerM,
      cacheWriteMultiplier: card.cacheWriteMultiplier,
      cacheReadMultiplier: card.cacheReadMultiplier,
    },
    "configured",
  );
}

/** Resolve a target's API key off the Env by the field name it declared. */
function resolveKey(env: Env, keyEnv: string): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[keyEnv];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const EMPTY_USAGE: LlmUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** What a shadow run of one window reports back. `ok` is schema-conformance:
 * the pass produced a usable structured result. `sample` is that result (or a
 * failure marker) for later quality comparison. */
export interface ShadowRunResult {
  ok: boolean;
  sample?: unknown;
}

/**
 * Run one analysis window against every target in parallel and return per-target
 * deltas. `run` is supplied by the caller (the DO) so the shadow executes the
 * exact same pass the live path runs — only the LlmConfig differs. Usage flows
 * back through the config's onUsage; cost is inferred at the target's rate.
 *
 * Nothing here throws: a target with no key is skipped, and a thrown pass is
 * recorded as an error delta. `now` is injected so the pure-ish core stays
 * testable.
 */
export async function runShadowPass(
  env: Env,
  targets: PriceTarget[],
  run: (config: LlmConfig) => Promise<ShadowRunResult>,
  now: () => number = () => Date.now(),
  /**
   * Called once per usage block the shadow pass produces, with that block
   * ALREADY PRICED. The DO wires this to `SpendLedger.recordShadow` so the
   * dollars this pass spends on our keys land on the session owner's meter as
   * attributed-but-uncharged shadow spend.
   *
   * Optional so the pure harness stays testable without a ledger — but the DO
   * must pass it so shadow spend remains attributed to the session owner.
   */
  onShadowSpend?: (priced: PricedUsage, target: PriceTarget) => void,
): Promise<TargetAgg[]> {
  const deltas = await Promise.all(
    targets.map(async (t): Promise<TargetAgg | null> => {
      const apiKey = resolveKey(env, t.keyEnv);
      if (!apiKey) {
        console.error(`price-test target "${t.label}" skipped: no key at Env.${t.keyEnv}`);
        return null;
      }
      const usage: LlmUsage = { ...EMPTY_USAGE };
      // Priced per usage block, not once over the summed usage, so the number
      // in this report and the number in the ledger are the same additions of
      // the same terms — a per-block sum and a sum-then-price can differ by a
      // micro-dollar of rounding, and a cost model that disagrees with itself
      // is the defect this stage exists to remove.
      let costMicros = 0;
      let costBasis: PriceBasis = "exact";
      let priced = false;
      const config: LlmConfig = {
        baseUrl: t.baseUrl,
        apiKey,
        provider: t.provider,
        model: t.model,
        logContent: transcriptContentLoggingEnabled(env),
        onUsage: (u, leg) => {
          usage.input_tokens += u.input_tokens;
          usage.output_tokens += u.output_tokens;
          usage.cache_creation_input_tokens += u.cache_creation_input_tokens;
          usage.cache_read_input_tokens += u.cache_read_input_tokens;
          const block = priceShadowUsage(u, leg, t, env);
          costMicros += block.micros;
          costBasis = priced ? worseBasis(costBasis, block.basis) : block.basis;
          priced = true;
          onShadowSpend?.(block, t);
        },
      };
      const started = now();
      let ok = false;
      let sample: unknown;
      let error: string | undefined;
      try {
        const r = await run(config);
        ok = r.ok;
        sample = r.sample;
      } catch (err) {
        error = String(err);
      }
      const latency = Math.max(0, now() - started);
      return {
        label: t.label,
        model: t.model,
        calls: 1,
        schema_ok: ok ? 1 : 0,
        schema_fail: !ok && !error ? 1 : 0,
        errors: error ? 1 : 0,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_micros: costMicros,
        // A target that produced no usage block at all (a thrown call) has
        // nothing priced; say "estimated" rather than claiming an exact zero.
        cost_basis: priced ? costBasis : "estimated",
        latency_ms_total: latency,
        last_error: error,
        sample_output: sample,
      };
    }),
  );
  return deltas.filter((d): d is TargetAgg => d !== null);
}

/** Fold per-window deltas into a session-long accumulator (keyed by label). */
export function mergeAgg(into: Record<string, TargetAgg>, deltas: TargetAgg[]): void {
  for (const d of deltas) {
    const cur = into[d.label];
    if (!cur) {
      into[d.label] = { ...d };
      continue;
    }
    cur.calls += d.calls;
    cur.schema_ok += d.schema_ok;
    cur.schema_fail += d.schema_fail;
    cur.errors += d.errors;
    cur.input_tokens += d.input_tokens;
    cur.output_tokens += d.output_tokens;
    cur.cost_micros += d.cost_micros;
    // `cur` can come off DO storage (`pricetest:agg`), and a blob written
    // before cost_basis existed has none. Treating that absence as "estimated"
    // keeps the fold honest: an accumulator whose provenance we cannot read must
    // not inherit a fresh delta's `exact` and start reading as a bill. Same rule
    // as usage.ts normalizeUsageDelta, which coerces an unrecognised basis to
    // "estimated" rather than trusting the wire.
    cur.cost_basis = worseBasis(cur.cost_basis ?? "estimated", d.cost_basis);
    cur.latency_ms_total += d.latency_ms_total;
    if (d.last_error) cur.last_error = d.last_error;
    if (d.sample_output !== undefined) cur.sample_output = d.sample_output;
    cur.model = d.model;
  }
}

/** The end-of-session report shape (also the persisted `pricetest:report`). */
export interface PriceTestReport {
  type: "price_test_report";
  session_id: string;
  targets: Array<
    TargetAgg & {
      /** schema_ok / calls, rounded to 3 dp; null when no calls landed. */
      conformance: number | null;
      /** cost_micros / calls — average inferred cost per analysis window. */
      cost_micros_per_call: number | null;
      /** latency_ms_total / calls. */
      avg_latency_ms: number | null;
    }
  >;
}

/** Derive rates from an accumulator into a ready-to-log report. */
export function buildReport(sessionId: string, agg: Record<string, TargetAgg>): PriceTestReport {
  const targets = Object.values(agg)
    .map((t) => ({
      ...t,
      conformance: t.calls > 0 ? Math.round((t.schema_ok / t.calls) * 1000) / 1000 : null,
      cost_micros_per_call: t.calls > 0 ? Math.round(t.cost_micros / t.calls) : null,
      avg_latency_ms: t.calls > 0 ? Math.round(t.latency_ms_total / t.calls) : null,
    }))
    // Cheapest first — the whole point is the cost comparison.
    .sort((a, b) => (a.cost_micros_per_call ?? Infinity) - (b.cost_micros_per_call ?? Infinity));
  return { type: "price_test_report", session_id: sessionId, targets };
}

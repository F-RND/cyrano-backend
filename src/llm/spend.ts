// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-request / per-session accumulator that sits between the LLM client's
 * `onUsage(usage, leg)` callback and the per-user meter in registry-do.
 *
 * WHY A LEDGER AND NOT `let spendMicros = 0`
 * ------------------------------------------
 * The old shape was a running integer, which can only answer "how much". Three
 * things now have to be answered at the same seam:
 *  1. WHICH provider+model produced each micro-dollar (defect D3 — an expensive
 *     subject shows how much and never why).
 *  2. On what BASIS each figure was priced, so a report can separate a bill from
 *     an estimate (BAR I4).
 *  3. Whether calls happened at all on a BYOK key — zero of our dollars, but not
 *     the same thing as no calls (defect D5: a cheap subject and a
 *     bring-your-own-key subject looked identical).
 * All three are per-CALL facts, so they have to be captured where the call is,
 * not reconstructed later from a total.
 *
 * ONE USAGE BLOCK = ONE CALL. `calls` counts usage blocks attributed, on both
 * the priced and the BYOK side, so the two counts mean the same thing. A
 * failed-over call reports up to two usage blocks (the primary may answer with
 * usage and then fail on protocol grounds before the fallback runs), and that is
 * deliberately counted as two: two providers each did work we may be billed for.
 *
 * `take()` DRAINS. Every caller reports a delta exactly once and cannot
 * double-count it by reading the accumulator twice; the SessionDO flush relies
 * on this to stay correct across an await (see flushLlmSpend).
 */

import type { LlmUsage, ServedLeg } from "./client.js";
import { priceUsage, worseBasis, type PricedUsage, type PricingOptions } from "./pricing.js";
import { isShadowLeg, normalizeUsageDelta, type UsageDelta, type UsageLeg } from "../usage.js";

export interface SpendLedger {
  /**
   * A usage block that spent OUR money, priced at the leg that actually served
   * it. `leg` is the one `onUsage` handed us — on a failed-over call that is the
   * FALLBACK's provider+model, never the primary's (BAR I5).
   */
  recordServed(usage: LlmUsage, leg: ServedLeg): void;
  /**
   * A usage block on a client-supplied key. Contributes exactly zero
   * micro-dollars and increments a call count instead (defect D5). There is no
   * parameter for a price here on purpose: no code path can make a BYOK call
   * cost us anything.
   */
  recordByok(): void;
  /**
   * A usage block WE chose to spend on this subject's traffic that the subject
   * never asked for — the shadow price-test fan-out (analysis/price-test.ts),
   * which re-runs an analysis window against candidate providers on our keys
   * for market measurement.
   *
   * It takes an ALREADY-PRICED block rather than (usage, leg) because the
   * caller has to know the number too (its own comparison report), and two
   * independent pricings of the same block is how a second cost model grows
   * back. One arithmetic, in llm/pricing.ts, two consumers.
   *
   * Lands in `delta.shadowMicros` and in a `shadow`-flagged leg, never in
   * `delta.micros`: attributed as a fact, kept out of the ceiling. Same shape
   * as `recordByok`, one step further along — BYOK is zero dollars and a count,
   * shadow is real dollars, named, and uncharged.
   */
  recordShadow(priced: PricedUsage): void;
  /** Drain: returns everything accumulated and resets to empty. */
  take(): UsageDelta;
  /** Read without draining — for guards and tests. */
  peek(): UsageDelta;
}

/** Stable map key for a provider+model bucket. Shadow and charged buckets for
 * the same provider+model are DIFFERENT buckets — see usage.ts mergeLegs. */
function legKey(provider: string, model: string, shadow: boolean): string {
  return `${shadow ? "s" : "c"}|${provider} ${model}`;
}

export function createSpendLedger(opts?: PricingOptions): SpendLedger {
  const legs = new Map<string, UsageLeg>();
  let byokCalls = 0;

  const add = (priced: PricedUsage, shadow: boolean): void => {
    const key = legKey(priced.provider, priced.model, shadow);
    const prev = legs.get(key);
    if (prev) {
      prev.calls += 1;
      prev.inputTokens += priced.inputTokens;
      prev.outputTokens += priced.outputTokens;
      prev.micros += priced.micros;
      prev.basis = worseBasis(prev.basis, priced.basis);
      return;
    }
    legs.set(key, {
      provider: priced.provider,
      model: priced.model,
      calls: 1,
      inputTokens: priced.inputTokens,
      outputTokens: priced.outputTokens,
      micros: priced.micros,
      basis: priced.basis,
      ...(shadow ? { shadow: true as const } : {}),
    });
  };

  const snapshot = (): UsageDelta => {
    const out = [...legs.values()].map((l) => ({ ...l }));
    return {
      // Always the sum of the legs, never a separately-maintained running total:
      // a total that could drift from its own breakdown is the bug I6 exists to
      // catch, so there is only one number and the breakdown IS it.
      micros: out.filter((l) => !isShadowLeg(l)).reduce((sum, l) => sum + l.micros, 0),
      legs: out,
      byokCalls,
      shadowMicros: out.filter(isShadowLeg).reduce((sum, l) => sum + l.micros, 0),
    };
  };

  return {
    recordServed(usage, leg) {
      add(priceUsage(usage, leg, opts), false);
    },
    recordByok() {
      byokCalls += 1;
    },
    recordShadow(priced) {
      add(priced, true);
    },
    take() {
      const out = snapshot();
      legs.clear();
      byokCalls = 0;
      return out;
    },
    peek: snapshot,
  };
}

/**
 * The `onShadowSpend` sink for `analysis/price-test.ts` `runShadowPass`: it
 * puts what a price-test fan-out spends on OUR keys onto the session owner's
 * meter as attributed-but-uncharged shadow spend.
 *
 * WHY THIS IS A NAMED, EXPORTED FUNCTION RATHER THAN AN ARROW AT THE CALL SITE
 * ---------------------------------------------------------------------------
 * The DO used to inline `(priced) => this.ledger().recordShadow(priced)`. That
 * line is the whole of defect D7's fix — without it the fan-out spends real
 * money that reaches no subject's meter, and the cohort's true cost reads
 * ~6.05x low with the three shipped targets — and it had NO test. Replacing it
 * with `undefined` or `() => {}` typechecked clean and left the entire suite
 * green, because the test that claimed to cover it hand-retyped the same arrow
 * in its own harness and proved only that `runShadowPass` calls whatever it is
 * handed.
 *
 * This is the same treatment `llm/hosted-config.ts` gave the I3 verdict, for
 * the same reason: a structural scan can see that `runShadowPass` was called
 * and cannot see WHAT IT WAS CALLED WITH. Naming the argument makes both
 * halves checkable — a pure test drives this function against a spy ledger,
 * and the census in `test/cost-reconciliation.test.ts` pins every
 * `runShadowPass` call site to passing THIS function, so neutering the sink
 * fails a named test instead of failing silently in production.
 */
export function shadowSpendSink(ledger: SpendLedger): (priced: PricedUsage) => void {
  return (priced) => ledger.recordShadow(priced);
}

/** True when a delta has nothing worth reporting to the per-user meter. */
export function isEmptyDelta(d: UsageDelta): boolean {
  return d.micros <= 0 && d.byokCalls <= 0 && d.legs.length === 0 && d.shadowMicros <= 0;
}

/** Wire encoding for the registry's internal `_usage` POST. snake_case to match
 * every other body on that endpoint. */
export function spendDeltaToWire(d: UsageDelta): {
  delta_micros: number;
  legs: Array<{
    provider: string;
    model: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    micros: number;
    basis: string;
    shadow?: true;
  }>;
  byok_calls: number;
  shadow_micros: number;
} {
  return {
    delta_micros: d.micros,
    legs: d.legs.map((l) => ({
      provider: l.provider,
      model: l.model,
      calls: l.calls,
      input_tokens: l.inputTokens,
      output_tokens: l.outputTokens,
      micros: l.micros,
      basis: l.basis,
      // Emitted only when true, so a charged leg's wire bytes are unchanged.
      ...(l.shadow ? { shadow: true as const } : {}),
    })),
    byok_calls: d.byokCalls,
    shadow_micros: d.shadowMicros,
  };
}

/**
 * Decode the `_usage` POST body back into a UsageDelta. The inverse of
 * {@link spendDeltaToWire}, and the ONLY place the snake_case wire names are
 * read — everything past this point is the camelCase in-memory shape.
 *
 * Deliberately tolerant: a body from an older Worker carries `delta_micros`
 * with no `legs`, and that must keep metering exactly as it did (the total
 * lands, the breakdown just stays empty). `normalizeUsageDelta` does the
 * clamping and the recompute-total-from-legs rule.
 */
export function usageDeltaFromWire(raw: unknown): UsageDelta {
  const b = (raw ?? {}) as {
    delta_micros?: unknown;
    legs?: unknown;
    byok_calls?: unknown;
    shadow_micros?: unknown;
  };
  const wireLegs = Array.isArray(b.legs) ? b.legs : [];
  const legs = wireLegs.map((w) => {
    const l = (w ?? {}) as Record<string, unknown>;
    return {
      provider: String(l.provider ?? "unknown"),
      model: String(l.model ?? "unknown"),
      calls: Number(l.calls ?? 0),
      inputTokens: Number(l.input_tokens ?? 0),
      outputTokens: Number(l.output_tokens ?? 0),
      micros: Number(l.micros ?? 0),
      basis: l.basis,
      ...(l.shadow === true ? { shadow: true as const } : {}),
    } as UsageLeg;
  });
  return normalizeUsageDelta({
    micros: Number(b.delta_micros ?? 0),
    legs,
    byokCalls: Number(b.byok_calls ?? 0),
    shadowMicros: Number(b.shadow_micros ?? 0),
  });
}

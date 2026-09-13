// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// The interruption policy engine evaluates every candidate whisper whenever
// context changes and returns one action: speak now, cue, queue, or drop.
//
// This module is pure: `decide()` takes a candidate, the current
// conversational context, and the session's policy state, and returns a
// decision plus the reason — it performs no I/O and mutates nothing. The
// mutation helpers (`recordDelivery`, `applyFeedback`) are separate and are
// only called by the caller (SessionDO, or the simulation harness) after it
// has actually acted on a decision. This split is what makes the module
// testable without any audio hardware — see policy/simulate.ts and
// test/policy.test.ts.
//
// Caps below are constants, not settings, per the brief.

import type { WhisperCandidate, WhisperFeedbackKind } from "../types.js";

export type Tier = WhisperCandidate["tier"];
export type ConversationalState = "user_speaking" | "other_speaking" | "silence";
export type Decision = "speak" | "cue" | "queue" | "drop";

export const RATE_CAP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
export const RATE_CAP_MAX_AUTO_WHISPERS = 4; // per window, SPEAK deliveries only
export const RATE_CAP_MIN_GAP_MS = 90 * 1000; // minimum gap between SPEAK deliveries

/**
 * Session-starting budget per tier. Ambient's budget governs its CUE
 * ceiling only — ambient content can never reach SPEAK, full stop. Budget is
 * consumed permanently by negative feedback (dismissed cue / barged whisper)
 * and does not regenerate mid-session, unlike the rolling rate-cap window.
 */
export const INITIAL_TIER_BUDGET: Record<Tier, number> = {
  critical: 6,
  actionable: 4,
  ambient: 3,
};

export const FEEDBACK_BUDGET_PENALTY = 1;

export interface DeliveryEvent {
  at: number;
  delivery: "speak" | "cue";
}

export interface PolicyState {
  tierBudget: Record<Tier, number>;
  deliveryHistory: DeliveryEvent[];
}

export function initialPolicyState(): PolicyState {
  return {
    tierBudget: { ...INITIAL_TIER_BUDGET },
    deliveryHistory: [],
  };
}

export interface DecisionContext {
  now: number; // ms epoch, or session-relative ms in the simulation harness
  conversationalState: ConversationalState;
}

export interface DecisionResult {
  decision: Decision;
  reason: string;
}

function isExpired(candidate: WhisperCandidate, now: number): boolean {
  return now > candidate.created_at + candidate.ttl_ms;
}

function recentSpeaks(history: DeliveryEvent[], now: number): DeliveryEvent[] {
  return history.filter((h) => h.delivery === "speak" && now - h.at < RATE_CAP_WINDOW_MS);
}

function msSinceLastSpeak(history: DeliveryEvent[], now: number): number | null {
  const speaks = history.filter((h) => h.delivery === "speak");
  if (speaks.length === 0) return null;
  const last = speaks[speaks.length - 1];
  return last === undefined ? null : now - last.at;
}

/**
 * Pure decision function. Does not mutate `state` — call `recordDelivery`
 * separately once the caller has actually acted on a "speak" or "cue"
 * decision, and `applyFeedback` when whisper.feedback arrives.
 */
export function decide(
  candidate: WhisperCandidate,
  ctx: DecisionContext,
  state: PolicyState,
): DecisionResult {
  // Subtext-derived speculation about OTHER never auto-pushes or auto-cues —
  // it is only ever reachable via pull mode / the review screen (invariant 9).
  if (candidate.speculation) {
    return { decision: "drop", reason: "speculation_never_auto_delivers" };
  }

  if (isExpired(candidate, ctx.now)) {
    return { decision: "drop", reason: "ttl_expired" };
  }

  const budget = state.tierBudget[candidate.tier];
  if (budget <= 0) {
    return { decision: "drop", reason: "tier_budget_exhausted" };
  }

  // Ambient content's ceiling is a cue — it can never reach full audio.
  const ceiling: Decision = candidate.tier === "ambient" ? "cue" : "speak";

  if (ceiling === "cue") {
    return { decision: "cue", reason: "ambient_ceiling_is_cue" };
  }

  // ceiling === "speak" from here: critical or actionable content.
  if (ctx.conversationalState === "user_speaking") {
    return { decision: "queue", reason: "user_mid_utterance" };
  }

  const speaksInWindow = recentSpeaks(state.deliveryHistory, ctx.now);
  if (speaksInWindow.length >= RATE_CAP_MAX_AUTO_WHISPERS) {
    return { decision: "queue", reason: "rate_cap_window_exhausted" };
  }

  const sinceLast = msSinceLastSpeak(state.deliveryHistory, ctx.now);
  if (sinceLast !== null && sinceLast < RATE_CAP_MIN_GAP_MS) {
    return { decision: "queue", reason: "min_gap_not_elapsed" };
  }

  return { decision: "speak", reason: "eligible" };
}

/** Call after actually delivering a "speak" or "cue" decision. */
export function recordDelivery(state: PolicyState, delivery: "speak" | "cue", at: number): void {
  state.deliveryHistory.push({ at, delivery });
}

/**
 * Call when a whisper.feedback message arrives. A dismissed cue or a
 * barged-mid-play whisper lowers that tier's budget for the rest of the
 * session — "delivered" (heard/played through) feedback does not restore it;
 * budget only ever moves down, by design.
 */
export function applyFeedback(state: PolicyState, tier: Tier, feedback: WhisperFeedbackKind): void {
  if (feedback === "dismissed" || feedback === "barged") {
    state.tierBudget[tier] = Math.max(0, state.tierBudget[tier] - FEEDBACK_BUDGET_PENALTY);
  }
}

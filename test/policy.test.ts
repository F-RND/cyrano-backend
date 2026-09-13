// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  applyFeedback,
  decide,
  initialPolicyState,
  recordDelivery,
  INITIAL_TIER_BUDGET,
  RATE_CAP_MAX_AUTO_WHISPERS,
  RATE_CAP_MIN_GAP_MS,
  RATE_CAP_WINDOW_MS,
} from "../src/policy/engine.js";
import { runSimulation, type SimulationEvent } from "../src/policy/simulate.js";
import type { WhisperCandidate } from "../src/types.js";

function candidate(overrides: Partial<WhisperCandidate> = {}): WhisperCandidate {
  return {
    id: overrides.id ?? "c1",
    session_id: "s1",
    text: "You committed to Friday.",
    tier: overrides.tier ?? "critical",
    source: overrides.source ?? "commitments",
    created_at: overrides.created_at ?? 0,
    ttl_ms: overrides.ttl_ms ?? 60_000,
    speculation: overrides.speculation ?? false,
  };
}

describe("decide: speculation and ambient ceiling", () => {
  it("always drops speculative (subtext) candidates regardless of state", () => {
    const state = initialPolicyState();
    const c = candidate({ speculation: true, tier: "ambient" });
    const result = decide(c, { now: 0, conversationalState: "silence" }, state);
    expect(result).toEqual({ decision: "drop", reason: "speculation_never_auto_delivers" });
  });

  it("never lets ambient content reach speak, even in ideal conditions", () => {
    const state = initialPolicyState();
    const c = candidate({ tier: "ambient" });
    const result = decide(c, { now: 0, conversationalState: "silence" }, state);
    expect(result.decision).toBe("cue");
  });
});

describe("decide: mid-USER-speech suppression", () => {
  it("queues (never speaks) a critical candidate while USER is mid-utterance", () => {
    const state = initialPolicyState();
    const c = candidate({ created_at: 0, ttl_ms: 60_000 });
    const result = decide(c, { now: 100, conversationalState: "user_speaking" }, state);
    expect(result).toEqual({ decision: "queue", reason: "user_mid_utterance" });
  });

  it("speaks once the user stops talking, before TTL expiry", () => {
    const state = initialPolicyState();
    const c = candidate({ created_at: 0, ttl_ms: 60_000 });
    const whileSpeaking = decide(c, { now: 100, conversationalState: "user_speaking" }, state);
    expect(whileSpeaking.decision).toBe("queue");
    const afterSilence = decide(c, { now: 5_000, conversationalState: "silence" }, state);
    expect(afterSilence).toEqual({ decision: "speak", reason: "eligible" });
  });

  it("speaks while OTHER is speaking (user can listen without talking)", () => {
    const state = initialPolicyState();
    const c = candidate({ created_at: 0, ttl_ms: 60_000 });
    const result = decide(c, { now: 100, conversationalState: "other_speaking" }, state);
    expect(result.decision).toBe("speak");
  });
});

describe("decide: TTL expiry", () => {
  it("drops a candidate once its TTL has elapsed, even if it was otherwise eligible", () => {
    const state = initialPolicyState();
    const c = candidate({ created_at: 0, ttl_ms: 5_000 });
    const result = decide(c, { now: 5_001, conversationalState: "silence" }, state);
    expect(result).toEqual({ decision: "drop", reason: "ttl_expired" });
  });

  it("a candidate stuck queued behind USER speech expires instead of ever speaking", () => {
    const state = initialPolicyState();
    const c = candidate({ created_at: 0, ttl_ms: 3_000 });
    const stillSpeaking = decide(c, { now: 2_999, conversationalState: "user_speaking" }, state);
    expect(stillSpeaking.decision).toBe("queue");
    const nowExpired = decide(c, { now: 3_001, conversationalState: "user_speaking" }, state);
    expect(nowExpired).toEqual({ decision: "drop", reason: "ttl_expired" });
  });
});

describe("decide: rate-limit exhaustion", () => {
  it("queues once RATE_CAP_MAX_AUTO_WHISPERS speaks have happened in the rolling window", () => {
    const state = initialPolicyState();
    for (let i = 0; i < RATE_CAP_MAX_AUTO_WHISPERS; i++) {
      recordDelivery(state, "speak", i * (RATE_CAP_MIN_GAP_MS + 1));
    }
    const c = candidate({
      id: "c-over-cap",
      created_at: RATE_CAP_MAX_AUTO_WHISPERS * (RATE_CAP_MIN_GAP_MS + 1),
      ttl_ms: 600_000,
    });
    const now = c.created_at + RATE_CAP_MIN_GAP_MS + 1;
    const result = decide(c, { now, conversationalState: "silence" }, state);
    expect(result).toEqual({ decision: "queue", reason: "rate_cap_window_exhausted" });
  });

  it("queues if less than the minimum gap has elapsed since the last speak", () => {
    const state = initialPolicyState();
    recordDelivery(state, "speak", 0);
    const c = candidate({ created_at: 1_000, ttl_ms: 600_000 });
    const result = decide(c, { now: 1_000, conversationalState: "silence" }, state);
    expect(result).toEqual({ decision: "queue", reason: "min_gap_not_elapsed" });
  });

  it("becomes eligible again once the rolling window clears", () => {
    const state = initialPolicyState();
    recordDelivery(state, "speak", 0);
    const c = candidate({ created_at: 1_000, ttl_ms: RATE_CAP_WINDOW_MS * 2 });
    const result = decide(c, { now: RATE_CAP_WINDOW_MS + 1_000, conversationalState: "silence" }, state);
    expect(result.decision).toBe("speak");
  });
});

describe("decide: feedback-driven budget reduction", () => {
  it("lowers the tier budget on dismissed/barged feedback and eventually drops the tier", () => {
    const state = initialPolicyState();
    const budget = INITIAL_TIER_BUDGET.critical;
    for (let i = 0; i < budget; i++) {
      applyFeedback(state, "critical", "barged");
    }
    expect(state.tierBudget.critical).toBe(0);
    const c = candidate({ created_at: 0, ttl_ms: 60_000 });
    const result = decide(c, { now: 0, conversationalState: "silence" }, state);
    expect(result).toEqual({ decision: "drop", reason: "tier_budget_exhausted" });
  });

  it("does not reduce budget on 'delivered' feedback", () => {
    const state = initialPolicyState();
    applyFeedback(state, "critical", "delivered");
    expect(state.tierBudget.critical).toBe(INITIAL_TIER_BUDGET.critical);
  });

  it("budget reduction is permanent for the session, unlike the rolling rate window", () => {
    const state = initialPolicyState();
    applyFeedback(state, "actionable", "dismissed");
    applyFeedback(state, "actionable", "dismissed");
    expect(state.tierBudget.actionable).toBe(INITIAL_TIER_BUDGET.actionable - 2);
    // Time passing alone (unlike the rate window) never restores tier budget.
    const c = candidate({ tier: "actionable", created_at: 0, ttl_ms: 60_000 });
    decide(c, { now: RATE_CAP_WINDOW_MS * 10, conversationalState: "silence" }, state);
    expect(state.tierBudget.actionable).toBe(INITIAL_TIER_BUDGET.actionable - 2);
  });
});

describe("runSimulation: end-to-end scripted timeline", () => {
  it("suppresses a critical whisper delivered mid-utterance until the user goes silent", () => {
    const events: SimulationEvent[] = [
      { t: 0, kind: "conversational_state", state: "user_speaking" },
      { t: 100, kind: "candidate", candidate: candidate({ id: "c1", created_at: 100, ttl_ms: 10_000 }) },
      { t: 2_000, kind: "conversational_state", state: "silence" },
    ];
    const log = runSimulation(events, { tickMs: 250 });
    const forC1 = log.filter((l) => l.candidateId === "c1");
    expect(forC1.some((l) => l.decision === "queue" && l.reason === "user_mid_utterance")).toBe(true);
    expect(forC1.some((l) => l.decision === "speak")).toBe(true);
    // Never speaks before the state actually goes silent.
    const firstSpeak = forC1.find((l) => l.decision === "speak");
    expect(firstSpeak && firstSpeak.t).toBeGreaterThanOrEqual(2_000);
  });

  it("drops a stale whisper instead of ever delivering it", () => {
    const events: SimulationEvent[] = [
      { t: 0, kind: "conversational_state", state: "user_speaking" },
      { t: 0, kind: "candidate", candidate: candidate({ id: "stale", created_at: 0, ttl_ms: 1_000 }) },
    ];
    const log = runSimulation(events, { tickMs: 250, horizonPaddingMs: 5_000 });
    const forStale = log.filter((l) => l.candidateId === "stale");
    expect(forStale.every((l) => l.decision !== "speak" && l.decision !== "cue")).toBe(true);
    expect(forStale.some((l) => l.decision === "drop" && l.reason === "ttl_expired")).toBe(true);
  });

  it("feedback lowers budget and a later same-tier candidate gets dropped", () => {
    const events: SimulationEvent[] = [
      { t: 0, kind: "conversational_state", state: "silence" },
      { t: 0, kind: "candidate", candidate: candidate({ id: "amb1", tier: "ambient", created_at: 0, ttl_ms: 5_000 }) },
      { t: 250, kind: "feedback", candidateId: "amb1", feedback: "dismissed" },
      { t: 500, kind: "candidate", candidate: candidate({ id: "amb2", tier: "ambient", created_at: 500, ttl_ms: 5_000 }) },
      { t: 750, kind: "feedback", candidateId: "amb2", feedback: "dismissed" },
      { t: 1_000, kind: "candidate", candidate: candidate({ id: "amb3", tier: "ambient", created_at: 1_000, ttl_ms: 5_000 }) },
      { t: 1_250, kind: "feedback", candidateId: "amb3", feedback: "dismissed" },
      { t: 1_500, kind: "candidate", candidate: candidate({ id: "amb4", tier: "ambient", created_at: 1_500, ttl_ms: 5_000 }) },
    ];
    const log = runSimulation(events, { tickMs: 250, horizonPaddingMs: 5_000 });
    // Budget for ambient starts at 3; three dismissals exhaust it, so the 4th ambient candidate must drop.
    const forAmb4 = log.filter((l) => l.candidateId === "amb4");
    expect(forAmb4.some((l) => l.decision === "drop" && l.reason === "tier_budget_exhausted")).toBe(true);
  });
});

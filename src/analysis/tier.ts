// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Maps analysis-pass output into the policy engine's priority tiers. The
// brief names one example each (critical: "you're double-booked", actionable:
// "open ask detected, deadline captured", ambient: "FYI, sentiment
// observation") without prescribing a formula, so this is a deliberately
// small, explicit heuristic rather than a general contradiction-detector —
// see DECISIONS.md.

import type { CommitmentExtraction, HotState, WhisperCandidate } from "../types.js";
import type { Tier } from "../policy/engine.js";

const TTL_MS_BY_TIER: Record<Tier, number> = {
  critical: 90_000, // a double-booking correction is worthless once the topic moves on
  actionable: 5 * 60_000,
  ambient: 2 * 60_000, // ambient only ever reaches "cue", so a shorter TTL is fine
};

export function ttlForTier(tier: Tier): number {
  return TTL_MS_BY_TIER[tier];
}

/**
 * A new commitment is "critical" (double-booked pattern) only if it shares an
 * inferred deadline with the existing hot-state commitment but is a
 * different commitment — i.e. two different things promised for the same
 * day. Otherwise a fresh commitment with a captured deadline is "actionable".
 *
 * The double-booking check only applies to the USER's own commitments: a
 * counterpart (OTHER/SYSTEM) promising something for the same day the user
 * already committed is not a scheduling conflict, so it stays "actionable".
 */
export function tierForCommitment(commitment: CommitmentExtraction, hotState: HotState | null): Tier {
  const existing = hotState?.last_commitment;
  if (
    commitment.owner === "USER" &&
    existing &&
    existing.inferred_deadline &&
    commitment.inferred_deadline &&
    existing.inferred_deadline === commitment.inferred_deadline &&
    existing.text !== commitment.text
  ) {
    return "critical";
  }
  return "actionable";
}

export function makeCandidateId(sessionId: string, sourceSeq: number, kind: string): string {
  return `${sessionId}-${kind}-${sourceSeq}`;
}

export function buildCandidate(params: {
  sessionId: string;
  now: number;
  text: string;
  tier: Tier;
  source: WhisperCandidate["source"];
  sourceSeq: number;
  kind: string;
  speculation?: boolean;
}): WhisperCandidate {
  return {
    id: makeCandidateId(params.sessionId, params.sourceSeq, params.kind),
    session_id: params.sessionId,
    text: params.text,
    tier: params.tier,
    source: params.source,
    created_at: params.now,
    ttl_ms: ttlForTier(params.tier),
    speculation: params.speculation ?? false,
  };
}

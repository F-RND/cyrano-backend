// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Simulation harness for the interruption policy engine. Feeds a scripted
// timeline (conversational-state changes, candidate whisper arrivals, user
// feedback) through decide()/recordDelivery()/applyFeedback() and returns a
// full decision log. No audio hardware, no iOS, no network involved — this
// is how the policy engine is tested (see test/policy.test.ts) and how a
// designer can dry-run a new caps/budget tuning against a recorded transcript
// timeline before touching device code.

import type { WhisperCandidate, WhisperFeedbackKind } from "../types.js";
import {
  decide,
  initialPolicyState,
  recordDelivery,
  applyFeedback,
  RATE_CAP_WINDOW_MS,
  type ConversationalState,
  type Decision,
  type Tier,
} from "./engine.js";

export interface ConversationalStateEvent {
  t: number;
  kind: "conversational_state";
  state: ConversationalState;
}

export interface CandidateEvent {
  t: number;
  kind: "candidate";
  candidate: WhisperCandidate;
}

export interface FeedbackEvent {
  t: number;
  kind: "feedback";
  candidateId: string;
  feedback: WhisperFeedbackKind;
}

export type SimulationEvent = ConversationalStateEvent | CandidateEvent | FeedbackEvent;

export interface DecisionLogEntry {
  t: number;
  candidateId: string;
  tier: Tier;
  decision: Decision;
  reason: string;
}

export interface SimulationOptions {
  /** How often pending (queued) candidates are re-evaluated, in ms. */
  tickMs?: number;
  /** How far past the last scripted event to keep ticking so queued candidates can resolve or expire. */
  horizonPaddingMs?: number;
}

export function runSimulation(events: SimulationEvent[], opts: SimulationOptions = {}): DecisionLogEntry[] {
  const tickMs = opts.tickMs ?? 250;
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const lastEventT = sorted.length > 0 ? sorted[sorted.length - 1]!.t : 0;
  const horizon = lastEventT + (opts.horizonPaddingMs ?? RATE_CAP_WINDOW_MS);

  const state = initialPolicyState();
  let conversationalState: ConversationalState = "silence";
  const pending: WhisperCandidate[] = [];
  const candidatesById = new Map<string, WhisperCandidate>();
  const log: DecisionLogEntry[] = [];

  const checkpointSet = new Set<number>();
  for (const e of sorted) checkpointSet.add(e.t);
  for (let t = 0; t <= horizon; t += tickMs) checkpointSet.add(t);
  const checkpoints = [...checkpointSet].sort((a, b) => a - b);

  let eventIdx = 0;
  for (const t of checkpoints) {
    while (eventIdx < sorted.length && sorted[eventIdx]!.t === t) {
      const e = sorted[eventIdx]!;
      if (e.kind === "conversational_state") {
        conversationalState = e.state;
      } else if (e.kind === "candidate") {
        candidatesById.set(e.candidate.id, e.candidate);
        pending.push(e.candidate);
      } else if (e.kind === "feedback") {
        const candidate = candidatesById.get(e.candidateId);
        if (candidate) applyFeedback(state, candidate.tier, e.feedback);
      }
      eventIdx++;
    }

    for (let i = pending.length - 1; i >= 0; i--) {
      const candidate = pending[i]!;
      const result = decide(candidate, { now: t, conversationalState }, state);
      log.push({ t, candidateId: candidate.id, tier: candidate.tier, decision: result.decision, reason: result.reason });

      if (result.decision === "speak" || result.decision === "cue") {
        recordDelivery(state, result.decision, t);
        pending.splice(i, 1);
      } else if (result.decision === "drop") {
        pending.splice(i, 1);
      }
      // "queue" stays pending and is re-evaluated at the next checkpoint.
    }
  }

  return log;
}

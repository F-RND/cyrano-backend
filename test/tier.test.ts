// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { tierForCommitment } from "../src/analysis/tier.js";
import type { CommitmentExtraction, HotState } from "../src/types.js";

function commitment(over: Partial<CommitmentExtraction> = {}): CommitmentExtraction {
  return {
    text: over.text ?? "Send the deck",
    owner: over.owner ?? "USER",
    inferred_deadline: over.inferred_deadline ?? null,
    confidence: over.confidence ?? 0.9,
    source_seq: over.source_seq ?? 1,
  };
}

function hotStateWith(last: CommitmentExtraction | null): HotState {
  return {
    session_id: "s",
    last_commitment: last,
    open_asks: [],
    latest_suggestion: null,
    updated_at_seq: 0,
  };
}

describe("tierForCommitment ownership", () => {
  const friday = "2026-07-17";

  it("escalates two of the USER's own commitments on the same deadline to critical", () => {
    const hot = hotStateWith(commitment({ text: "Meet Priya", inferred_deadline: friday }));
    const next = commitment({ text: "Fly to Berlin", inferred_deadline: friday });
    expect(tierForCommitment(next, hot)).toBe("critical");
  });

  it("does NOT treat a counterpart commitment sharing the user's deadline as a conflict", () => {
    // OTHER promising something on the same day the user already committed is
    // not a double-booking of the user's schedule.
    const hot = hotStateWith(commitment({ text: "Meet Priya", inferred_deadline: friday }));
    const theirs = commitment({ text: "Send the signed contract", owner: "OTHER", inferred_deadline: friday });
    expect(tierForCommitment(theirs, hot)).toBe("actionable");
  });

  it("a fresh commitment with no clashing prior is actionable", () => {
    expect(tierForCommitment(commitment({ inferred_deadline: friday }), hotStateWith(null))).toBe("actionable");
  });
});

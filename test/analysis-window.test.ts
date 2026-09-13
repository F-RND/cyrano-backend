// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ANALYSIS_MIN_WINDOW_WORDS, windowWordCount } from "../src/analysis/window.js";
import type { TranscriptSegment } from "../src/types.js";

// The word gate is the backstop against the measured failure mode: an
// analysis tick (~5 concurrent LLM calls) firing on every VAD silence gap,
// so a one-word "yeah" turn billed the same as a paragraph — order 1,000+
// model calls per hour of ordinary back-and-forth. These pin the two
// properties the gate's correctness rests on: filler-sized windows stay
// under the threshold, and content is COUNTED cumulatively across segments
// so deferred words still trip the gate later (deferral, not loss).

let seq = 0;
function seg(text: string, speaker: TranscriptSegment["speaker"] = "USER"): TranscriptSegment {
  seq += 1;
  return {
    session_id: "test",
    seq,
    t_start: seq * 1000,
    t_end: seq * 1000 + 900,
    speaker,
    confidence: 0.9,
    text,
    final: true,
  };
}

describe("windowWordCount", () => {
  it("counts plain words across segments", () => {
    expect(windowWordCount([seg("I'll send the deck Friday")])).toBe(5);
    expect(windowWordCount([seg("yeah"), seg("sounds good")])).toBe(3);
  });

  it("returns 0 for an empty window", () => {
    expect(windowWordCount([])).toBe(0);
  });

  it("ignores punctuation-only and whitespace-only tokens", () => {
    expect(windowWordCount([seg("... — !?")])).toBe(0);
    expect(windowWordCount([seg("  ")])).toBe(0);
    expect(windowWordCount([seg("well... okay")])).toBe(2);
  });

  it("counts unicode words and digits", () => {
    expect(windowWordCount([seg("envoie-le à Priya")])).toBe(3);
    expect(windowWordCount([seg("room 42")])).toBe(2);
  });

  it("keeps single filler turns below the tick threshold", () => {
    // The utterances that used to burn a full tick via the silence trigger.
    for (const filler of ["yeah", "okay", "mm-hmm", "sounds good", "ok bye"]) {
      expect(windowWordCount([seg(filler)])).toBeLessThan(ANALYSIS_MIN_WINDOW_WORDS);
    }
  });

  it("lets the shortest real commitment through the gate", () => {
    expect(windowWordCount([seg("I'll call Sam tomorrow")])).toBeGreaterThanOrEqual(
      ANALYSIS_MIN_WINDOW_WORDS,
    );
  });

  it("accumulates deferred filler across segments until the gate clears", () => {
    // Three deferred sub-threshold turns whose sum crosses the threshold:
    // the tick that sees the combined window must run.
    const deferred = [seg("okay"), seg("sounds good"), seg("send it Monday")];
    expect(windowWordCount(deferred)).toBeGreaterThanOrEqual(ANALYSIS_MIN_WINDOW_WORDS);
  });
});

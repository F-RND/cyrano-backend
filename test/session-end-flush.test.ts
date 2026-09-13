// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ANALYSIS_MIN_WINDOW_WORDS, windowPassesGate } from "../src/analysis/window.js";

// The end-of-session flush exists for one failure mode: a short session (a
// dictation burst) ends below the 4-segment analysis trigger AND below the
// word gate, so its content never analyzes — handleSessionEnd used to call
// only endSessionInternal, no final pass. The flush forces one pass whose
// gate decision is pinned here: bypass the ≥4-word threshold, but never
// spend an LLM call on a window with zero real words.

describe("windowPassesGate", () => {
  it("enforces the normal threshold on ordinary ticks", () => {
    expect(windowPassesGate(ANALYSIS_MIN_WINDOW_WORDS - 1)).toBe(false);
    expect(windowPassesGate(ANALYSIS_MIN_WINDOW_WORDS)).toBe(true);
    expect(windowPassesGate(0)).toBe(false);
  });

  it("lets an end-flush through below the threshold", () => {
    // "send it Monday" — 3 words, the exact burst tail the flush exists for.
    expect(windowPassesGate(3, { endFlush: true })).toBe(true);
    expect(windowPassesGate(1, { endFlush: true })).toBe(true);
  });

  it("never passes an empty window, even forced", () => {
    expect(windowPassesGate(0, { endFlush: true })).toBe(false);
  });

  it("end-flush does not tighten the gate for windows already over it", () => {
    expect(windowPassesGate(20, { endFlush: true })).toBe(true);
  });
});

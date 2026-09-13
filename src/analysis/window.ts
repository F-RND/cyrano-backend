// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Cost gate for analysis ticks. One tick spends ~5 concurrent LLM calls
// (four built-in passes + the custom/detection pass), and the silence
// trigger fires after every utterance — so without a content check, a
// "yeah" / "okay, sounds good" turn costs the same as a paragraph. The
// gate requires the unanalyzed window to contain a minimum number of real
// words before any pass may run. A window that fails the gate is NOT
// consumed: its segments stay pending and ride into the next tick once
// more content accumulates, so short-but-meaningful turns ("send it
// Monday") are deferred, never dropped. A sub-threshold tail at session
// end is flushed by the forced end-of-session pass (see windowPassesGate's
// endFlush option), which bypasses the threshold with a ≥1-word floor.

import type { TranscriptSegment } from "../types.js";

/** Minimum words in the unanalyzed window before a tick may spend LLM
 * calls. 4 keeps the shortest real commitments ("I'll call Sam tomorrow")
 * on the fast path while filler turns accumulate silently. */
export const ANALYSIS_MIN_WINDOW_WORDS = 4;

/** The gate decision itself. An end-of-session flush (`endFlush`) bypasses
 * the threshold with a ≥1-real-word floor: the closing tail is often exactly
 * the segment that matters — a dictation burst's "send it Monday" ends the
 * session before a 4th segment or another tick ever fires — and the cost is
 * bounded at one extra pass per session. */
export function windowPassesGate(words: number, opts: { endFlush?: boolean } = {}): boolean {
  if (opts.endFlush) return words > 0;
  return words >= ANALYSIS_MIN_WINDOW_WORDS;
}

/** Counts whitespace-separated tokens containing at least one letter or
 * digit, so stray punctuation ("...", "—") and empty strings don't count
 * as content. Unicode-aware; note CJK text without spaces counts each run
 * as one word, which only makes the gate more permissive there. */
export function windowWordCount(segments: readonly TranscriptSegment[]): number {
  let count = 0;
  for (const segment of segments) {
    for (const token of segment.text.split(/\s+/)) {
      if (/[\p{L}\p{N}]/u.test(token)) count++;
    }
  }
  return count;
}

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Full-transcript reanalysis — the "Reanalyze with Copilot" action.
//
// A finished session analyzed on-device can be re-run through the SAME hosted
// combined pass live sessions use (schemas/analysis.json), so the user can see
// what the copilot would have extracted and optionally replace the local
// results. Stateless on purpose: the transcript lives only for the life of the
// request (like /context/refine — nothing is logged or stored), and no Session
// DO is involved, so reanalysis can never disturb live session state, retention
// alarms, or the hot-state carry-forward.
//
// The transcript is windowed to mirror the live cadence's shape — each window
// is analyzed with the commitments/asks already extracted carried forward as
// known_* (the same dedupe contract the DO gives the model) — but windows are
// larger than a live tick's, since a reanalysis holds the whole conversation
// and richer context is exactly what the user asked it for.

import {
  runCombinedAnalysis,
  type AnalysisResult,
  type PassFailure,
} from "./passes.js";
import type { LlmConfig } from "../llm/client.js";
import type { Speaker, TranscriptSegment } from "../types.js";

export interface ReanalyzeLine {
  seq: number;
  speaker: Speaker;
  text: string;
  /** Diarized SYSTEM-feed voice (2, 3, …) when the stored segment had one —
   * carried through so reanalysis attributes to "Speaker N" like live does. */
  speaker_slot?: number;
}

/** Reject-not-truncate caps, like MAX_REFINE_INPUT_BYTES: a silent trim would
 * read as "the whole session was reanalyzed" when it wasn't. Far above any
 * real session (a 30-minute conversation is a few hundred finalized lines). */
export const MAX_REANALYZE_LINES = 4000;
export const MAX_REANALYZE_CHARS = 400_000;

/** Lines per combined-pass window. Larger than the live 4-segment tick — the
 * whole transcript is in hand, and subtext/suggestions starve on tiny
 * windows — but bounded so a marathon still fits the pass's token budget. */
const WINDOW_LINES = 40;
/** How many known commitment/ask texts carry into the next window's prompt. */
const KNOWN_CARRY = 30;

/** Per-kind result caps so the response (and the reading user) stays bounded.
 * Applied after cross-window text dedupe, oldest first. Subtext lowered
 * 40 → 24 (2026-07-22 QA feedback): a 34-minute meeting produced 60 entries
 * live, ~50 of them filler-triggered "hesitation" burying the good reads —
 * even reanalysis at 2/window should stay a digest, not a firehose. */
const RESULT_CAPS = { commitments: 80, asks: 80, subtext: 24, suggestions: 16, decisions: 40 };

/** Per-line text clamp — a single runaway "line" is not a transcript line. */
const MAX_LINE_CHARS = 2_000;

const SPEAKER_SET = new Set<string>(["USER", "OTHER", "UNKNOWN", "SYSTEM"] satisfies Speaker[]);

/** Parse + clamp an untrusted `transcript` body field into ordered lines.
 * Returns null when the shape is unusable (not an array of line objects). */
export function sanitizeReanalyzeLines(raw: unknown): ReanalyzeLine[] | null {
  if (!Array.isArray(raw)) return null;
  const lines: ReanalyzeLine[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const { seq, speaker, text, speaker_slot } = item as Record<string, unknown>;
    if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    const spk: Speaker =
      typeof speaker === "string" && SPEAKER_SET.has(speaker) ? (speaker as Speaker) : "UNKNOWN";
    const slot =
      typeof speaker_slot === "number" && Number.isInteger(speaker_slot) && speaker_slot >= 2
        ? speaker_slot
        : undefined;
    lines.push({
      seq: Math.trunc(seq),
      speaker: spk,
      text: trimmed.slice(0, MAX_LINE_CHARS),
      ...(slot !== undefined ? { speaker_slot: slot } : {}),
    });
  }
  lines.sort((a, b) => a.seq - b.seq);
  return lines;
}

export function reanalyzeCharCount(lines: ReanalyzeLine[]): number {
  return lines.reduce((n, l) => n + l.text.length, 0);
}

export interface ReanalyzeOutcome {
  result: AnalysisResult;
  /** Windows successfully analyzed. With `failure` set and windowsRun > 0 the
   * result is a usable partial; windowsRun === 0 means it failed outright. */
  windowsRun: number;
  failure?: PassFailure;
  /** Categories at least one window's reply structurally omitted (see
   * CombinedAnalysisOutcome.missingCategories). A category listed here may
   * be incomplete even though the run "succeeded" — callers must flag it
   * rather than render its zeros as a clean result. */
  missingCategories?: (keyof AnalysisResult)[];
}

/** Window the transcript through the combined pass, carrying extracted
 * commitments/asks forward as known_* and deduping across windows by text.
 * Stops at the first failed window (an auth/budget error would fail every
 * subsequent window identically) and reports it alongside any partial. */
export async function reanalyzeTranscript(
  config: LlmConfig,
  lines: ReanalyzeLine[],
): Promise<ReanalyzeOutcome> {
  const result: AnalysisResult = { commitments: [], asks: [], subtext: [], suggestions: [], decisions: [] };
  const seenTexts = {
    commitments: new Set<string>(),
    asks: new Set<string>(),
    subtext: new Set<string>(),
    suggestions: new Set<string>(),
    decisions: new Set<string>(),
  };
  const key = (text: string) => text.trim().toLowerCase();
  let windowsRun = 0;
  const missingCategories = new Set<keyof AnalysisResult>();

  for (let start = 0; start < lines.length; start += WINDOW_LINES) {
    const window: TranscriptSegment[] = lines
      .slice(start, start + WINDOW_LINES)
      .map((l) => ({
        session_id: "reanalyze",
        seq: l.seq,
        t_start: 0,
        t_end: 0,
        speaker: l.speaker,
        confidence: 1,
        text: l.text,
        final: true,
        ...(l.speaker_slot !== undefined ? { speaker_slot: l.speaker_slot } : {}),
      }));
    const outcome = await runCombinedAnalysis(
      config,
      window,
      result.commitments.slice(-KNOWN_CARRY).map((c) => c.text),
      result.asks.slice(-KNOWN_CARRY).map((a) => a.text),
    );
    if (outcome.failure) {
      return {
        result,
        windowsRun,
        failure: outcome.failure,
        ...(missingCategories.size > 0 ? { missingCategories: [...missingCategories] } : {}),
      };
    }
    windowsRun += 1;
    for (const category of outcome.missingCategories ?? []) missingCategories.add(category);
    for (const c of outcome.result.commitments) {
      if (seenTexts.commitments.size < RESULT_CAPS.commitments && !seenTexts.commitments.has(key(c.text))) {
        seenTexts.commitments.add(key(c.text));
        result.commitments.push(c);
      }
    }
    for (const a of outcome.result.asks) {
      if (seenTexts.asks.size < RESULT_CAPS.asks && !seenTexts.asks.has(key(a.text))) {
        seenTexts.asks.add(key(a.text));
        result.asks.push(a);
      }
    }
    for (const s of outcome.result.subtext) {
      // Cross-kind guard: a sloppy window sometimes emits the same extraction
      // under several kinds ("Pull up the form" as task AND ask AND subtext).
      // A subtext or suggestion that verbatim-duplicates a commitment/ask is a
      // misfiled extraction, not a tone read or next move — drop it. The
      // commitment/ask pairing itself is kept (a real ask the user agreed to
      // can legitimately appear as both).
      const k = key(s.text);
      if (seenTexts.commitments.has(k) || seenTexts.asks.has(k)) continue;
      if (seenTexts.subtext.size < RESULT_CAPS.subtext && !seenTexts.subtext.has(k)) {
        seenTexts.subtext.add(k);
        result.subtext.push(s);
      }
    }
    for (const s of outcome.result.suggestions) {
      const k = key(s.text);
      if (seenTexts.commitments.has(k) || seenTexts.asks.has(k)) continue;
      if (seenTexts.suggestions.size < RESULT_CAPS.suggestions && !seenTexts.suggestions.has(k)) {
        seenTexts.suggestions.add(k);
        result.suggestions.push(s);
      }
    }
    for (const d of outcome.result.decisions) {
      const k = key(d.text);
      if (seenTexts.decisions.size < RESULT_CAPS.decisions && !seenTexts.decisions.has(k)) {
        seenTexts.decisions.add(k);
        result.decisions.push(d);
      }
    }
  }
  return {
    result,
    windowsRun,
    ...(missingCategories.size > 0 ? { missingCategories: [...missingCategories] } : {}),
  };
}

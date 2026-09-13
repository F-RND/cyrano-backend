// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import analysisTool from "../../schemas/analysis.json";
import commitmentsTool from "../../schemas/commitments.json";
import asksTool from "../../schemas/asks.json";
import subtextTool from "../../schemas/subtext.json";
import suggestionsTool from "../../schemas/suggestions.json";
import { callTool, LlmCallError, type LlmConfig, type ToolSchema } from "../llm/client.js";
import { validAsks, validCommitments, validDecisions, validSubtext, validSuggestions } from "./validate.js";
import type {
  AskExtraction,
  CommitmentExtraction,
  DecisionExtraction,
  NextMoveSuggestion,
  Speaker,
  SubtextObservation,
  TranscriptSegment,
  UserContextItem,
} from "../types.js";

/** The two seq→attribute maps validation attributes ownership by: speaker (for
 * `owner`/`requested_by`) and, for slotted SYSTEM lines, the diarized slot (for
 * `owner_slot`/`requested_by_slot`). Built once per window and threaded into
 * validCommitments/validAsks. Only lines that actually carry a `speaker_slot`
 * land in slotBySeq, so a mic-only window produces an empty slot map and the
 * validators emit no slot fields. */
function attributionMaps(window: TranscriptSegment[]): {
  speakerBySeq: Map<number, Speaker>;
  slotBySeq: Map<number, number>;
} {
  const speakerBySeq = new Map<number, Speaker>();
  const slotBySeq = new Map<number, number>();
  for (const s of window) {
    speakerBySeq.set(s.seq, s.speaker);
    if (s.speaker_slot !== undefined) slotBySeq.set(s.seq, s.speaker_slot);
  }
  return { speakerBySeq, slotBySeq };
}

interface TranscriptLine {
  seq: number;
  speaker: TranscriptSegment["speaker"];
  text: string;
  /** Which distinct SYSTEM voice said this line (2, 3, …) — see types.ts.
   * Omitted (not null) when absent, so mic-only sessions serialize
   * byte-identically to the pre-slot format. */
  speaker_slot?: number;
}

function toLines(window: TranscriptSegment[]): TranscriptLine[] {
  return window.map((s) => ({
    seq: s.seq,
    speaker: s.speaker,
    text: s.text,
    // The slot is what lets analysis tell three meeting participants apart
    // instead of collapsing them all into one "SYSTEM" — dropping it here
    // was why subtext/ownership attributed everything to a single voice.
    ...(s.speaker_slot !== undefined ? { speaker_slot: s.speaker_slot } : {}),
  }));
}

/**
 * Adds `user_context` (deliberately attached clipboard/window-snapshot text)
 * to a pass input — only when there is any, so the input stays byte-identical
 * to the pre-attachment format for every session that never attaches anything.
 */
export function withUserContext(
  input: Record<string, unknown>,
  userContext: UserContextItem[],
): Record<string, unknown> {
  return userContext.length > 0 ? { ...input, user_context: userContext } : input;
}

/** Output caps. Every pass emits small structured arrays; these bound the
 * bill (and latency) when a model rambles. The combined pass carries four
 * arrays, so it gets the largest cap. */
const COMBINED_MAX_OUTPUT_TOKENS = 2048;
const SINGLE_PASS_MAX_OUTPUT_TOKENS = 1024;

export async function runCommitments(
  config: LlmConfig,
  window: TranscriptSegment[],
  knownCommitments: string[],
  userContext: UserContextItem[] = [],
): Promise<CommitmentExtraction[]> {
  const result = await callTool<{ commitments: unknown }>(
    config,
    commitmentsTool as ToolSchema,
    withUserContext(
      {
        now: new Date().toISOString(),
        known_commitments: knownCommitments,
        transcript_window: toLines(window),
      },
      userContext,
    ),
    { maxTokens: SINGLE_PASS_MAX_OUTPUT_TOKENS },
  );
  // Attribute each commitment to its committer by the source line's speaker
  // (and slot, for a specific feed voice).
  const { speakerBySeq, slotBySeq } = attributionMaps(window);
  return validCommitments(result.commitments, speakerBySeq, slotBySeq, config.logContent === true);
}

export async function runAsks(
  config: LlmConfig,
  window: TranscriptSegment[],
  knownOpenAsks: string[],
  userContext: UserContextItem[] = [],
): Promise<AskExtraction[]> {
  const result = await callTool<{ asks: unknown }>(
    config,
    asksTool as ToolSchema,
    withUserContext(
      {
        known_open_asks: knownOpenAsks,
        transcript_window: toLines(window),
      },
      userContext,
    ),
    { maxTokens: SINGLE_PASS_MAX_OUTPUT_TOKENS },
  );
  // Let validation attribute each ask to OTHER vs SYSTEM (and a feed slot) by
  // its source line.
  const { speakerBySeq, slotBySeq } = attributionMaps(window);
  return validAsks(result.asks, speakerBySeq, slotBySeq);
}

export async function runSubtext(
  config: LlmConfig,
  window: TranscriptSegment[],
  userContext: UserContextItem[] = [],
): Promise<SubtextObservation[]> {
  const result = await callTool<{ subtext: unknown }>(
    config,
    subtextTool as ToolSchema,
    withUserContext({ transcript_window: toLines(window) }, userContext),
    { maxTokens: SINGLE_PASS_MAX_OUTPUT_TOKENS },
  );
  return validSubtext(result.subtext);
}

export async function runSuggestions(
  config: LlmConfig,
  window: TranscriptSegment[],
  recentCommitments: string[],
  openAsks: string[],
  userContext: UserContextItem[] = [],
): Promise<NextMoveSuggestion[]> {
  const result = await callTool<{ suggestions: unknown }>(
    config,
    suggestionsTool as ToolSchema,
    withUserContext(
      {
        recent_commitments: recentCommitments,
        open_asks: openAsks,
        transcript_window: toLines(window),
      },
      userContext,
    ),
    { maxTokens: SINGLE_PASS_MAX_OUTPUT_TOKENS },
  );
  return validSuggestions(result.suggestions).slice(0, 2);
}

export interface AnalysisResult {
  commitments: CommitmentExtraction[];
  asks: AskExtraction[];
  subtext: SubtextObservation[];
  suggestions: NextMoveSuggestion[];
  decisions: DecisionExtraction[];
}

/** Decisions cap per pass — a work meeting settles a handful of things, not
 * dozens; more than this is the model over-splitting one outcome. */
const MAX_DECISIONS = 6;

/** Why a pass failed, surfaced so the DO can broadcast a degraded state
 * (a BYOK user with a bad key must SEE it, not just get empty columns). */
export interface PassFailure {
  status?: number;
  message: string;
}

export function toPassFailure(err: unknown): PassFailure {
  return {
    status: err instanceof LlmCallError ? err.status : undefined,
    message: String(err),
  };
}

export interface CombinedAnalysisOutcome {
  result: AnalysisResult;
  /** Present when the batched call failed and `result` degraded to empties. */
  failure?: PassFailure;
  /** Categories the model's reply did not contain as arrays at all, despite
   * every one being `required` in schemas/analysis.json. Distinguishes "the
   * engine looked and found nothing" (a genuine `[]`) from "the reply never
   * had this category" (an engine/parsing gap) — the latter used to render
   * as zeros with no signal, which is how the OpenAI-leg incompleteness went
   * unnoticed. Absent when the reply was structurally complete. */
  missingCategories?: (keyof AnalysisResult)[];
}

/** The combined pass's category keys, in schema order. */
const COMBINED_CATEGORIES: (keyof AnalysisResult)[] = [
  "commitments",
  "asks",
  "subtext",
  "suggestions",
  "decisions",
];

/**
 * Runs the four built-in extractions as ONE batched call (schemas/analysis.json)
 * — same window, same context, one bill instead of four. This replaced the
 * four concurrent single-purpose calls 2026-07-11 (~4x call reduction on top
 * of the word gate); the per-purpose schemas stay in backend/schemas/ as the
 * portable agent tools and for the narrow pull-mode fallbacks above.
 *
 * A failure degrades to empty results rather than throwing, but is returned
 * (not just logged) so the caller can broadcast a machine-readable status.
 */
export async function runCombinedAnalysis(
  config: LlmConfig,
  window: TranscriptSegment[],
  knownCommitments: string[],
  knownOpenAsks: string[],
  userContext: UserContextItem[] = [],
): Promise<CombinedAnalysisOutcome> {
  try {
    const result = await callTool<{
      commitments: unknown;
      asks: unknown;
      subtext: unknown;
      suggestions: unknown;
      decisions: unknown;
    }>(
      config,
      analysisTool as ToolSchema,
      withUserContext(
        {
          now: new Date().toISOString(),
          known_commitments: knownCommitments,
          known_open_asks: knownOpenAsks,
          transcript_window: toLines(window),
        },
        userContext,
      ),
      { maxTokens: COMBINED_MAX_OUTPUT_TOKENS },
    );
    const { speakerBySeq, slotBySeq } = attributionMaps(window);
    const missing = COMBINED_CATEGORIES.filter(
      (category) => !Array.isArray((result as Record<string, unknown>)[category]),
    );
    if (missing.length > 0) {
      console.error(
        `analysis pass "combined" reply omitted required categories (provider=${config.provider ?? "anthropic"}, model=${config.model}): ${missing.join(", ")}`,
      );
    }
    return {
      result: {
        commitments: validCommitments(
          result.commitments,
          speakerBySeq,
          slotBySeq,
          config.logContent === true,
        ),
        asks: validAsks(result.asks, speakerBySeq, slotBySeq),
        subtext: validSubtext(result.subtext),
        suggestions: validSuggestions(result.suggestions).slice(0, 2),
        decisions: validDecisions(result.decisions, speakerBySeq, slotBySeq).slice(0, MAX_DECISIONS),
      },
      ...(missing.length > 0 ? { missingCategories: missing } : {}),
    };
  } catch (err) {
    console.error(`analysis pass "combined" failed:`, err);
    return {
      result: { commitments: [], asks: [], subtext: [], suggestions: [], decisions: [] },
      failure: toPassFailure(err),
    };
  }
}

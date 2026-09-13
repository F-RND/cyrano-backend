// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import whisperTool from "../../schemas/whisper.json";
import { callTool, type LlmConfig, type ToolSchema } from "../llm/client.js";
import { MAX_WORDS, validateWhisperGrammar, type WhisperMode } from "../policy/grammar.js";

/**
 * Deterministic fallback used when the LLM rewrite is slow, errors, or
 * produces a line that fails grammar validation even after one retry. This
 * guarantees the pull-mode latency budget (<2.5s) is never blown waiting on
 * a model, and that a whisper never reaches the client unvalidated —
 * INCLUDING this fallback, which is held to the same grammar as the LLM
 * path: first sentence only, then leading words are dropped until the clip
 * validates ("What is the budget" becomes "the budget.", not a delivered
 * question the grammar exists to ban).
 */
export function deterministicFallback(sourceFact: string, mode: WhisperMode): string {
  const firstSentence = sourceFact.trim().split(/[.!?]+/)[0] ?? "";
  let words = firstSentence.split(/\s+/).filter(Boolean);
  while (words.length > 1) {
    const candidate = words.slice(0, MAX_WORDS[mode]).join(" ") + ".";
    if (validateWhisperGrammar(candidate, mode).valid) return candidate;
    words = words.slice(1);
  }
  // Pathological source (nothing but lead-in words): fall back to the old
  // clip-and-punctuate — an imperfect whisper beats an empty one.
  const clipped = sourceFact.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS[mode]).join(" ");
  return clipped.replace(/[?!]+$/, "").replace(/\.*$/, "") + ".";
}

/**
 * Rewrites an already-extracted fact into whisper grammar. This is a small,
 * fast, distinct prompt — it does not re-run the heavyweight analysis passes.
 */
export async function generateWhisperText(
  config: LlmConfig,
  sourceFact: string,
  mode: WhisperMode,
): Promise<{ text: string; source: "llm" | "fallback" }> {
  // A whisper is <=25 words; 256 output tokens is ample and bounds the bill.
  const WHISPER_MAX_OUTPUT_TOKENS = 256;
  try {
    const result = await callTool<{ whisper_text: string }>(
      config,
      whisperTool as ToolSchema,
      {
        source_fact: sourceFact,
        mode,
        max_words: MAX_WORDS[mode],
      },
      { maxTokens: WHISPER_MAX_OUTPUT_TOKENS },
    );
    const first = validateWhisperGrammar(result.whisper_text, mode);
    if (first.valid) {
      return { text: result.whisper_text, source: "llm" };
    }

    // One retry with the violation list appended, then fall back deterministically.
    const retry = await callTool<{ whisper_text: string }>(
      config,
      whisperTool as ToolSchema,
      {
        source_fact: `${sourceFact} (previous attempt violated: ${first.violations.join(", ")}; fix and retry)`,
        mode,
        max_words: MAX_WORDS[mode],
      },
      { maxTokens: WHISPER_MAX_OUTPUT_TOKENS },
    );
    const second = validateWhisperGrammar(retry.whisper_text, mode);
    if (second.valid) {
      return { text: retry.whisper_text, source: "llm" };
    }
  } catch {
    // fall through to deterministic fallback
  }

  return { text: deterministicFallback(sourceFact, mode), source: "fallback" };
}

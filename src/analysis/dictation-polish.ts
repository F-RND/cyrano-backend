// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import polishTool from "../../schemas/dictation-polish.json";
import { callTool, type LlmConfig, type ToolSchema } from "../llm/client.js";

/** The polish modes the hosted route understands — hand-mirror of the Swift
 * `DictationPolishModes`. */
export const POLISH_MODES = ["cleanup", "corrections", "formatting"] as const;
export type PolishMode = (typeof POLISH_MODES)[number];

/** Hard clamp on the input text — dictation bursts are short, and this bounds
 * the per-call bill and matches the delivery-content clamp. Anything longer is
 * truncated before the model sees it. */
export const MAX_POLISH_INPUT_CHARS = 2000;

/** A whole dictation is small; 512 output tokens is ample even with list
 * formatting and bounds the bill. */
const POLISH_MAX_OUTPUT_TOKENS = 512;

/** The client sends at most 3 sense hints and 2 recovery hints per burst
 * (`DictationSenseResolver.maxHints`, `DictationPolish.maxRecoveryHints`);
 * anything past this cap, or longer than a hint ever is, is dropped. */
export const MAX_POLISH_HINTS = 6;
const MAX_POLISH_HINT_CHARS = 400;

export function sanitizeModes(raw: unknown): PolishMode[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set<PolishMode>();
  for (const m of raw) {
    if (typeof m === "string" && (POLISH_MODES as readonly string[]).includes(m)) {
      set.add(m as PolishMode);
    }
  }
  return [...set];
}

/**
 * The device's notes about specific words — an undecided homonym, a possible
 * self-correction ("not that", ", sorry,"), a word possibly cut off — that the
 * client's deterministic passes refused to act on. Strings only, trimmed,
 * clamped and capped; junk yields [].
 */
export function sanitizeHints(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const h of raw) {
    if (typeof h !== "string") continue;
    const hint = h.trim().slice(0, MAX_POLISH_HINT_CHARS);
    if (hint.length === 0) continue;
    out.push(hint);
    if (out.length >= MAX_POLISH_HINTS) break;
  }
  return out;
}

/**
 * Rewrite a dictation transcript per the requested modes. Small, fast, single
 * tool call — like `generateWhisperText`, distinct from the analysis passes.
 * Deterministic passthrough on ANY error or empty result: a polish failure
 * degrades to the raw text, never to nothing. (The Swift caller races a
 * deadline against this and has its own deterministic floor, so a slow/failed
 * hosted call also degrades gracefully client-side.)
 */
export async function generateDictationPolish(
  config: LlmConfig,
  text: string,
  modes: PolishMode[],
  hints: string[] = [],
): Promise<{ text: string; source: "llm" | "passthrough" }> {
  const clamped = text.slice(0, MAX_POLISH_INPUT_CHARS);
  // No modes, or empty text: nothing to do — passthrough without spending a call.
  if (modes.length === 0 || clamped.trim().length === 0) {
    return { text: clamped, source: "passthrough" };
  }
  try {
    const result = await callTool<{ polished_text: string }>(
      config,
      polishTool as ToolSchema,
      // Hints ride only when there are some, so a hint-free call is the
      // same request it always was.
      hints.length > 0 ? { text: clamped, modes, hints } : { text: clamped, modes },
      { maxTokens: POLISH_MAX_OUTPUT_TOKENS },
    );
    const polished = (result.polished_text ?? "").trim();
    if (polished.length === 0) {
      return { text: clamped, source: "passthrough" };
    }
    return { text: polished, source: "llm" };
  } catch {
    return { text: clamped, source: "passthrough" };
  }
}

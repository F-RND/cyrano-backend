// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import refineTool from "../../schemas/context-refine.json";
import { callTool, type LlmConfig, type ToolSchema } from "../llm/client.js";

/** The scope vocabulary — hand-mirror of the Swift
 * `DayContextRefineRequest.Scope`. */
export const REFINE_SCOPES = ["section", "document"] as const;
export type RefineScope = (typeof REFINE_SCOPES)[number];

/**
 * Hard cap on the fragment, in BYTES of UTF-8. A day document is bounded by
 * how much one person said in one day, and 32 KB is well past that.
 *
 * This is a cap, NOT a clamp — unlike dictation polish, which truncates. A
 * silently truncated day document comes back as a revision that *deletes* the
 * user's afternoon, and the client would then write that over their notes. The
 * route rejects with 413 instead.
 */
export const MAX_REFINE_INPUT_BYTES = 32 * 1024;

/** Ceiling on the reply. A whole-document refine legitimately returns about
 * what it was given, so this is sized from the input rather than fixed — but
 * still bounded, so a runaway can't bill unboundedly. */
export function refineMaxTokens(text: string): number {
  const estimated = Math.ceil(text.length / 3) + 512;
  return Math.min(16_000, Math.max(1024, estimated));
}

export class RefineFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineFailure";
  }
}

export interface RefineInput {
  text: string;
  instruction: string;
  scope: RefineScope;
  sectionTitle?: string;
}

export interface RefineResult {
  revisedText: string;
  changed: boolean;
  note: string | null;
}

export function sanitizeScope(raw: unknown): RefineScope {
  return typeof raw === "string" && (REFINE_SCOPES as readonly string[]).includes(raw)
    ? (raw as RefineScope)
    : "section";
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Apply one instruction to a fragment of the day document.
 *
 * Failure semantics deliberately DIVERGE from `generateDictationPolish`, which
 * degrades to passthrough: there is no sensible deterministic floor for "apply
 * this instruction to these notes", and returning the input as though it were a
 * revision would read to the user as "the refinement worked and did nothing".
 * That is worse than an honest error, so this throws. This matches the
 * on-device provider (`FoundationModelsDayContextRefiner`), which throws too.
 *
 * `changed: false` is NOT a failure — it is the model correctly reporting that
 * the instruction didn't apply. In that case the input is returned verbatim, so
 * a client that applies the result anyway writes back byte-identical text.
 */
export async function generateDayContextRefine(
  config: LlmConfig,
  input: RefineInput,
): Promise<RefineResult> {
  const text = input.text;
  const instruction = input.instruction.trim();
  if (text.trim().length === 0 || instruction.length === 0) {
    throw new RefineFailure("empty text or instruction");
  }

  let result: { revised_text?: string; changed?: boolean; note?: string };
  try {
    result = await callTool<{ revised_text?: string; changed?: boolean; note?: string }>(
      config,
      refineTool as ToolSchema,
      {
        text,
        instruction,
        scope: input.scope,
        ...(input.sectionTitle ? { section_title: input.sectionTitle } : {}),
      },
      { maxTokens: refineMaxTokens(text) },
    );
  } catch (err) {
    throw new RefineFailure(err instanceof Error ? err.message : "refinement call failed");
  }

  const note = typeof result.note === "string" && result.note.trim().length > 0
    ? result.note.trim()
    : null;

  // The model reported that nothing should change: hand back the input
  // verbatim rather than whatever it echoed, so "unchanged" is exact.
  if (result.changed === false) {
    return { revisedText: text, changed: false, note };
  }

  const revised = (result.revised_text ?? "").trim();
  if (revised.length === 0) {
    throw new RefineFailure("model returned an empty revision");
  }
  // A revision identical to the input is a no-op however it was labelled.
  if (revised === text.trim()) {
    return { revisedText: text, changed: false, note };
  }
  return { revisedText: revised, changed: true, note };
}

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { callTool, type LlmConfig, type ToolSchema } from "../llm/client.js";
import askTool from "../../schemas/ask.json";

/// Free-form Q&A over a session or day's own context — the wire half of the
/// note-field question path (docs — the client-side sibling is `SessionAsk` /
/// `answerQuestion`). Unlike the extraction passes this does NOT window: the
/// client sends one already-rendered context block (transcript + surfaced
/// items + notes, or the day document) and one question, and we make a single
/// grounded call. Stateless, nothing retained — same posture as /analyze.

/// The context block is free text, not a transcript array, so it gets the same
/// byte-based cap the day-context refine route uses rather than the line/char
/// caps the windowed /analyze path uses.
export const MAX_ASK_CONTEXT_BYTES = 400 * 1024;
export const MAX_ASK_QUESTION_BYTES = 4 * 1024;

/// Prose answers want more room than the 1024 default but nowhere near the
/// combined pass — this is a glance surface, a sentence or three.
const ASK_MAX_OUTPUT_TOKENS = 512;

export type AskScope = "conversation" | "day";

export interface AskResult {
  answer: string;
}

/// Answer one question grounded in the supplied context. Throws on an LLM
/// failure (the route maps it to a 502) — there is no partial answer to
/// salvage the way a windowed pass has partial windows.
export async function answerQuestion(
  config: LlmConfig,
  input: { scope: AskScope; context: string; question: string },
): Promise<AskResult> {
  const result = await callTool<{ answer: unknown }>(
    config,
    askTool as ToolSchema,
    input,
    { maxTokens: ASK_MAX_OUTPUT_TOKENS },
  );
  const answer = typeof result.answer === "string" ? result.answer.trim() : "";
  return { answer };
}

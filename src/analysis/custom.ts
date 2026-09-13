// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// The user-defined watch-category pass. Unlike the four built-in passes
// (static JSON schemas in backend/schemas/), this tool is constructed per
// session: the user's category definitions are embedded in the system prompt
// and their ids enum-constrain the output schema. All categories run in ONE
// batched LLM call per analysis tick — cost stays flat regardless of how
// many categories the user defines. The same call optionally proposes
// "detected" categories: emerging themes no existing category covers, which
// the client can offer to save as a real definition.
//
// Users author only a name + natural-language description. The extraction
// discipline (ground in quoted lines, prefer silence, hedge speculation)
// lives in this harness prompt, not in what the user writes — a sloppy
// description must not degrade into invented items.

import { callTool, type LlmConfig, type ToolSchema } from "../llm/client.js";
import { validCustomItems, validDetectedCategories } from "./validate.js";
import { withUserContext } from "./passes.js";
import {
  MAX_CUSTOM_CATEGORIES,
  MAX_CUSTOM_DESCRIPTION_CHARS,
  type CustomCategoryDefinition,
  type CustomCategoryItem,
  type DetectedCategory,
  type TranscriptSegment,
  type UserContextItem,
} from "../types.js";

/** Built-in pass names — detection must never re-propose what the app already extracts. */
const BUILT_IN_CATEGORY_NAMES = [
  "commitments",
  "open asks",
  "subtext",
  "next moves",
  "suggestions",
];

const MAX_DETECTED_PER_TICK = 2;

/** Hard per-category cap per tick, mirroring the prompt's "at most 2 —
 * keep only the strongest". Without it a chatty window turned a category
 * into a paraphrase pass over the transcript (80+ one-per-utterance items
 * in a 34-minute meeting), which reads as noise, not a watch list. */
const MAX_ITEMS_PER_CATEGORY_PER_TICK = 2;

/** Enforce the per-category cap after validation, preserving order (the
 * model lists its strongest matches first per the prompt). */
export function capPerCategory(items: CustomCategoryItem[]): CustomCategoryItem[] {
  const counts = new Map<string, number>();
  return items.filter((item) => {
    const n = counts.get(item.category_id) ?? 0;
    if (n >= MAX_ITEMS_PER_CATEGORY_PER_TICK) return false;
    counts.set(item.category_id, n + 1);
    return true;
  });
}

/**
 * Normalizes client-supplied definitions into something safe to embed in a
 * prompt: caps the count, trims and clamps text, drops empties, and
 * whitelists the tier value (anything unrecognized falls to ambient — the
 * only tier that can never auto-push).
 */
export function sanitizeDefinitions(defs: unknown): CustomCategoryDefinition[] {
  if (!Array.isArray(defs)) return [];
  const out: CustomCategoryDefinition[] = [];
  const seenIds = new Set<string>();
  for (const raw of defs) {
    if (out.length >= MAX_CUSTOM_CATEGORIES) break;
    if (typeof raw !== "object" || raw === null) continue;
    const d = raw as Record<string, unknown>;
    const id = typeof d.id === "string" ? d.id.trim() : "";
    const name = typeof d.name === "string" ? d.name.trim().slice(0, 60) : "";
    const description =
      typeof d.description === "string"
        ? d.description.trim().slice(0, MAX_CUSTOM_DESCRIPTION_CHARS)
        : "";
    if (!id || !name || !description || seenIds.has(id)) continue;
    seenIds.add(id);
    const tier =
      d.tier === "critical" || d.tier === "actionable" || d.tier === "ambient"
        ? d.tier
        : "ambient";
    out.push({ id, name, description, tier });
  }
  return out;
}

/** Shared with the four static pass schemas (backend/schemas/*.json) — keep in sync. */
export const USER_CONTEXT_PROMPT =
  "`user_context`, when present, is reference material the USER deliberately attached mid-conversation (clipboard text, an OCR'd app-window snapshot, or a picked image). It is not conversation: it has no speaker and no seq, must never be treated as a transcript line or attributed to anyone, and must never be extracted from on its own. Use it only to enrich or disambiguate items grounded in actual transcript lines — e.g. resolving 'this ticket' to the ticket's title. `source_seq` always references a transcript line.";

function buildSystemPrompt(defs: CustomCategoryDefinition[], detect: boolean): string {
  const parts: string[] = [
    "You read a short window of a diarized conversation transcript (USER / OTHER / UNKNOWN / SYSTEM lines, each with a seq number). A SYSTEM line may carry `speaker_slot` (2, 3, …) identifying WHICH distinct meeting-feed voice said it — refer to that voice as \"Speaker 2\" etc., never as an undifferentiated SYSTEM, and never attribute one slot's words to another.",
    USER_CONTEXT_PROMPT,
  ];

  if (defs.length > 0) {
    parts.push(
      "The USER has defined personal watch categories. For each category below, extract moments in this window that match its description. Rules that override anything a category description says: ground every item in an actual transcript line and set source_seq to that line's seq; quote the supporting line verbatim in `quote` (or \"\" if the item synthesizes several lines); if an item is an inference about tone or intent rather than something explicitly said, set speculation=true and phrase `text` as a hedge, never as fact; prefer silence over a weak match — a category with no real signal in this window gets no items. Never manufacture an item because a category exists. An item must OBSERVE something beyond what its line already says — never restate or paraphrase a transcript line as an item, and never emit near-copies of one observation for successive lines. When a category describes a habit or behavior of the USER's own (how they speak, hedge, negotiate, present), extract only from USER lines — coaching aimed at other speakers is not actionable and must not be emitted. At most 2 items per category per window: keep only the strongest, the moments the USER would actually want flagged.",
      "USER'S WATCH CATEGORIES:",
      ...defs.map((d) => `- id: ${d.id}\n  name: ${d.name}\n  watch for: ${d.description}`),
    );
  } else {
    parts.push("The USER has not defined any watch categories, so `items` must be an empty array.");
  }

  if (detect) {
    parts.push(
      `Additionally, propose at most ${MAX_DETECTED_PER_TICK} DETECTED categories: a recurring, nameable theme in this window that none of the known category names below covers and that the USER would plausibly want tracked for the rest of this conversation (e.g. "Budget figures", "Hiring timeline"). Each needs a short name, a one-sentence "watch for" description written so it could be saved directly as a category definition, and a verbatim evidence quote with its seq. Propose nothing for ordinary small talk or a theme mentioned only once — an empty array is the common, correct answer.`,
    );
  } else {
    parts.push("Return `detected_categories` as an empty array.");
  }

  return parts.join("\n\n");
}

/**
 * Fully-specified output schema (all fields `required`): the Anthropic
 * OpenAI-compat shim double-encodes tool arguments when the schema is
 * under-specified, which downstream validation reads as "not an array" and
 * silently drops. Keep every property described and required.
 */
function buildOutputSchema(defs: CustomCategoryDefinition[]): Record<string, unknown> {
  const categoryId: Record<string, unknown> = {
    type: "string",
    description: "The id of the matching user-defined category.",
  };
  if (defs.length > 0) {
    categoryId.enum = defs.map((d) => d.id);
  }
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category_id: categoryId,
            text: {
              type: "string",
              description:
                "The extracted item. Hedged phrasing when speculation=true, never stated as fact.",
            },
            quote: {
              type: "string",
              description: "Verbatim supporting transcript line, or \"\" when synthesized.",
            },
            speculation: {
              type: "boolean",
              description: "true when this is an inference about tone/intent, not an explicit statement.",
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            source_seq: { type: "integer", description: "seq of the grounding transcript line." },
          },
          required: ["category_id", "text", "quote", "speculation", "confidence", "source_seq"],
        },
      },
      detected_categories: {
        type: "array",
        maxItems: MAX_DETECTED_PER_TICK,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short category name, e.g. \"Budget figures\"." },
            description: {
              type: "string",
              description: "One-sentence 'watch for ...' description, saveable as-is.",
            },
            evidence: { type: "string", description: "Verbatim quote that motivated this suggestion." },
            source_seq: { type: "integer", description: "seq of the evidence line." },
          },
          required: ["name", "description", "evidence", "source_seq"],
        },
      },
    },
    required: ["items", "detected_categories"],
  };
}

export function buildCustomCategoriesTool(
  defs: CustomCategoryDefinition[],
  detect: boolean,
): ToolSchema {
  return {
    name: "extract_custom_categories",
    description:
      "Extract matches for the user's personal watch categories from a transcript window, and optionally propose emerging categories worth tracking.",
    system_prompt: buildSystemPrompt(defs, detect),
    input_schema: {
      type: "object",
      properties: {
        transcript_window: {
          type: "array",
          items: {
            type: "object",
            properties: {
              seq: { type: "integer" },
              speaker: { type: "string", enum: ["USER", "OTHER", "UNKNOWN", "SYSTEM"] },
              text: { type: "string" },
              speaker_slot: {
                type: "integer",
                description:
                  "Which distinct SYSTEM voice said this line (2, 3, …). Absent on mic lines and on feeds without diarization.",
              },
            },
            required: ["seq", "speaker", "text"],
          },
        },
        known_category_names: { type: "array", items: { type: "string" } },
        user_context: {
          type: "array",
          description:
            "Reference material the USER deliberately attached (clipboard / window snapshot / picked image). Not conversation — see system prompt.",
          items: {
            type: "object",
            properties: {
              source: { type: "string", enum: ["clipboard", "window", "file"] },
              app_name: { type: "string" },
              window_title: { type: "string" },
              file_name: { type: "string" },
              text: { type: "string" },
            },
            required: ["source", "text"],
          },
        },
      },
      // user_context stays optional: sessions that never attach anything send
      // inputs byte-identical to the pre-attachment format, and agents using
      // this schema verbatim keep working.
      required: ["transcript_window", "known_category_names"],
    },
    output_schema: buildOutputSchema(defs),
  };
}

export interface CustomPassResult {
  items: CustomCategoryItem[];
  detected: DetectedCategory[];
}

/**
 * Runs the batched custom pass. `knownDetectedNames` are category names
 * already proposed this session — passed into the prompt so the model stops
 * re-noticing the same theme, and re-filtered in validation because prompts
 * are suggestions, not guarantees. Skipped entirely (no LLM call) when there
 * is nothing to do.
 */
export async function runCustomCategories(
  config: LlmConfig,
  window: TranscriptSegment[],
  defs: CustomCategoryDefinition[],
  detect: boolean,
  knownDetectedNames: string[],
  userContext: UserContextItem[] = [],
): Promise<CustomPassResult> {
  if (defs.length === 0 && !detect) return { items: [], detected: [] };

  const knownNames = [
    ...BUILT_IN_CATEGORY_NAMES,
    ...defs.map((d) => d.name),
    ...knownDetectedNames,
  ];
  const tool = buildCustomCategoriesTool(defs, detect);
  const result = await callTool<{ items: unknown; detected_categories: unknown }>(
    config,
    tool,
    withUserContext(
      {
        transcript_window: window.map((s) => ({
          seq: s.seq,
          speaker: s.speaker,
          text: s.text,
          ...(s.speaker_slot !== undefined ? { speaker_slot: s.speaker_slot } : {}),
        })),
        known_category_names: knownNames,
      },
      userContext,
    ),
    // Items are capped by category count and detection at 2/tick — 1024 is generous.
    { maxTokens: 1024 },
  );

  return {
    items: capPerCategory(validCustomItems(result.items, defs)),
    detected: validDetectedCategories(result.detected_categories, knownNames).slice(
      0,
      MAX_DETECTED_PER_TICK,
    ),
  };
}

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import type {
  AskExtraction,
  CommitmentExtraction,
  CustomCategoryDefinition,
  CustomCategoryItem,
  DecisionExtraction,
  DetectedCategory,
  NextMoveSuggestion,
  Speaker,
  SubtextObservation,
} from "../types.js";

// ---- model-output validation ----
//
// `tool_choice` forces the model to call the tool, but nothing forces the
// arguments to actually match the output schema — a malformed response used
// to flow `undefined` fields straight into hot state, candidates, and the
// wire. Essential fields (a real `text`, a valid `label`) reject the item;
// everything else is normalized, and the fixed "literal" fields are stamped
// server-side unconditionally rather than trusted from the model.

const commitmentSchema = z.object({
  text: z.string().trim().min(1),
  inferred_deadline: z.string().nullable().optional(),
  confidence: z.number().optional(),
  source_seq: z.number().optional(),
});

const askSchema = z.object({
  text: z.string().trim().min(1),
  confidence: z.number().optional(),
  source_seq: z.number().optional(),
});

const subtextSchema = z.object({
  text: z.string().trim().min(1),
  label: z.enum(["hesitation", "swallowed_disagreement", "enthusiasm_mismatch"]),
  confidence: z.number().optional(),
  source_seq: z.number().optional(),
});

const suggestionSchema = z.object({
  text: z.string().trim().min(1),
  outcome: z.string().optional(),
  source_seq: z.number().optional(),
});

const decisionSchema = z.object({
  text: z.string().trim().min(1),
  status: z.enum(["decided", "tentative"]).optional(),
  confidence: z.number().optional(),
  source_seq: z.number().optional(),
});

const customItemSchema = z.object({
  category_id: z.string().min(1),
  text: z.string().trim().min(1),
  quote: z.string().optional(),
  speculation: z.boolean().optional(),
  confidence: z.number().optional(),
  source_seq: z.number().optional(),
});

const detectedCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1),
  evidence: z.string().optional(),
  source_seq: z.number().optional(),
});

export function clampConfidence(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

export function normalizeSeq(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 0 ? value! : 0;
}

function validItems<S, T>(schema: z.ZodType<S>, items: unknown, passName: string, toTyped: (raw: S) => T): T[] {
  if (!Array.isArray(items)) return [];
  const valid: T[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      valid.push(toTyped(parsed.data));
    } else {
      console.error(`analysis pass "${passName}" produced an invalid item, dropped:`, parsed.error.message);
    }
  }
  return valid;
}

/** Owner of a commitment = who spoke the line it was extracted from. No map
 * (legacy caller) → "USER"; map present but seq unseen → "OTHER" (as asks). */
function ownerForCommitment(
  speakerBySeq: Map<number, Speaker> | undefined,
  source_seq: number,
): CommitmentExtraction["owner"] {
  if (!speakerBySeq) return "USER";
  const speaker = speakerBySeq.get(source_seq);
  return speaker === "USER" ? "USER" : speaker === "SYSTEM" ? "SYSTEM" : "OTHER";
}

export function validCommitments(
  items: unknown,
  speakerBySeq?: Map<number, Speaker>,
  slotBySeq?: Map<number, number>,
  logContent = false,
): CommitmentExtraction[] {
  return validItems(commitmentSchema, items, "commitments", (raw) => {
    const source_seq = normalizeSeq(raw.source_seq);
    // Attribute ownership by the committer's line rather than trusting the
    // model: USER commitments are ours, OTHER/SYSTEM are the counterpart's
    // (a meeting-feed speaker is SYSTEM). UNKNOWN diarization → OTHER. When no
    // speaker map is supplied at all (legacy callers), keep the old "ours"
    // default so nothing silently reattributes.
    const owner = ownerForCommitment(speakerBySeq, source_seq);
    // Slot-level attribution rides ONLY on a SYSTEM owner: a meeting feed can
    // carry several voices, and this names which one so the client can show
    // "Speaker 5" instead of a flat "SYSTEM". Re-derived from the source line
    // here, never trusted from the model, exactly like `owner`.
    const owner_slot = owner === "SYSTEM" ? slotBySeq?.get(source_seq) : undefined;
    // Test-only attribution trace. It contains extracted user text, so the
    // caller must opt in through TRANSCRIPT_CONTENT_LOGGING; the default is
    // deliberately fail-closed even when Worker observability is enabled.
    if (speakerBySeq && logContent) {
      console.log(
        `COMMIT_ATTR raw_seq=${JSON.stringify(raw.source_seq)} norm=${source_seq} ` +
          `speaker=${JSON.stringify(speakerBySeq.get(source_seq) ?? null)} -> owner=${owner} ` +
          `seqs=[${[...speakerBySeq.keys()].join(",")}] text=${JSON.stringify(String(raw.text).slice(0, 50))}`,
      );
    }
    return {
      text: raw.text,
      owner,
      // Spread so an absent slot leaves the key off entirely — additive on the
      // wire, byte-identical to the pre-slot shape for every mic-only session.
      ...(owner_slot !== undefined ? { owner_slot } : {}),
      inferred_deadline: raw.inferred_deadline ?? null,
      confidence: clampConfidence(raw.confidence),
      source_seq,
    };
  });
}

export function validAsks(
  items: unknown,
  speakerBySeq?: Map<number, Speaker>,
  slotBySeq?: Map<number, number>,
): AskExtraction[] {
  return validItems(askSchema, items, "asks", (raw) => {
    const source_seq = normalizeSeq(raw.source_seq);
    // Attribute the ask to SYSTEM only when its source line actually came from
    // captured system-output audio; otherwise it's the in-room counterpart.
    const requested_by = speakerBySeq?.get(source_seq) === "SYSTEM" ? "SYSTEM" : "OTHER";
    // Slot only for a SYSTEM ask, same rule as owner_slot: name which feed
    // voice asked, so the client can say "Speaker 3 asked…" not "SYSTEM asked".
    const requested_by_slot = requested_by === "SYSTEM" ? slotBySeq?.get(source_seq) : undefined;
    return {
      text: raw.text,
      requested_by,
      ...(requested_by_slot !== undefined ? { requested_by_slot } : {}),
      answered: false as const,
      confidence: clampConfidence(raw.confidence),
      source_seq,
    };
  });
}

/** Minimum confidence for a `hesitation` read specifically (2026-07-22 QA
 * feedback): filler-triggered hesitation ("um", "like", self-correction) was
 * ~50 of 60 subtext entries in one meeting, burying the genuinely valuable
 * swallowed_disagreement/enthusiasm_mismatch reads — which stay unfloored
 * because they're rare and worth surfacing even when tentative. Note 0.6 also
 * drops a hesitation with MISSING confidence (clamped default 0.5): a read the
 * model didn't even score is exactly the weak read the prompt says to omit. */
const HESITATION_MIN_CONFIDENCE = 0.6;

export function validSubtext(items: unknown): SubtextObservation[] {
  return validItems(subtextSchema, items, "subtext", (raw) => ({
    text: raw.text,
    label: raw.label,
    speculation: true as const,
    confidence: clampConfidence(raw.confidence),
    source_seq: normalizeSeq(raw.source_seq),
  })).filter((s) => s.label !== "hesitation" || s.confidence >= HESITATION_MIN_CONFIDENCE);
}

export function validSuggestions(items: unknown): NextMoveSuggestion[] {
  return validItems(suggestionSchema, items, "suggestions", (raw) => ({
    text: raw.text,
    outcome: raw.outcome ?? "",
    dismissible: true,
    source_seq: normalizeSeq(raw.source_seq),
  }));
}

/** Decisions carry the SAME server-owned owner/owner_slot attribution as
 * commitments (who the outcome makes accountable, by the source line's
 * speaker/slot — never trusted from the model), plus a status defaulted to the
 * firmer "decided" when the model omits it. */
export function validDecisions(
  items: unknown,
  speakerBySeq?: Map<number, Speaker>,
  slotBySeq?: Map<number, number>,
): DecisionExtraction[] {
  return validItems(decisionSchema, items, "decisions", (raw) => {
    const source_seq = normalizeSeq(raw.source_seq);
    const owner = ownerForCommitment(speakerBySeq, source_seq);
    const owner_slot = owner === "SYSTEM" ? slotBySeq?.get(source_seq) : undefined;
    return {
      text: raw.text,
      owner,
      ...(owner_slot !== undefined ? { owner_slot } : {}),
      status: raw.status ?? ("decided" as const),
      confidence: clampConfidence(raw.confidence),
      source_seq,
    };
  });
}

/**
 * Custom items must reference a category the user actually defined — the
 * output schema enum-constrains `category_id`, but nothing forces the model
 * to honor it, so unknown ids drop here. `category_name` is denormalized
 * server-side from the definition, never trusted from the model.
 */
export function validCustomItems(
  items: unknown,
  definitions: CustomCategoryDefinition[],
): CustomCategoryItem[] {
  const byId = new Map(definitions.map((d) => [d.id, d]));
  return validItems(customItemSchema, items, "custom_categories", (raw) => {
    const def = byId.get(raw.category_id);
    if (!def) {
      console.error(`custom pass referenced unknown category_id "${raw.category_id}", dropped`);
      return null;
    }
    return {
      category_id: def.id,
      category_name: def.name,
      text: raw.text,
      quote: raw.quote ?? "",
      speculation: raw.speculation ?? false,
      confidence: clampConfidence(raw.confidence),
      source_seq: normalizeSeq(raw.source_seq),
    };
  }).filter((item): item is CustomCategoryItem => item !== null);
}

/**
 * Detected-category suggestions: drop anything whose name collides
 * (case-insensitively) with a name in `knownNames` — user definitions, the
 * built-in passes, and names already proposed earlier in the session.
 */
export function validDetectedCategories(items: unknown, knownNames: string[]): DetectedCategory[] {
  const known = new Set(knownNames.map((n) => n.trim().toLowerCase()));
  const out: DetectedCategory[] = [];
  for (const item of validItems(detectedCategorySchema, items, "detected_categories", (raw) => raw)) {
    const key = item.name.trim().toLowerCase();
    if (known.has(key)) continue;
    known.add(key); // also dedupes within this batch
    out.push({
      name: item.name,
      description: item.description,
      evidence: item.evidence ?? "",
      source_seq: normalizeSeq(item.source_seq),
    });
  }
  return out;
}

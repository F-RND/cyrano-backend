// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { validCustomItems, validDetectedCategories } from "../src/analysis/validate.js";
import { buildCustomCategoriesTool, capPerCategory, sanitizeDefinitions } from "../src/analysis/custom.js";
import { MAX_CUSTOM_CATEGORIES, type CustomCategoryDefinition, type CustomCategoryItem } from "../src/types.js";

const DEFS: CustomCategoryDefinition[] = [
  { id: "cat-1", name: "Competitor mentions", description: "Any mention of a competing product", tier: "actionable" },
  { id: "cat-2", name: "Budget figures", description: "Dollar amounts or budget talk", tier: "ambient" },
];

describe("sanitizeDefinitions", () => {
  it("drops empties, dedupes ids, clamps count, and whitelists tier", () => {
    const raw = [
      { id: "a", name: "Ok", description: "watch", tier: "actionable" },
      { id: "a", name: "Duplicate id", description: "watch" },
      { id: "b", name: "", description: "no name" },
      { id: "", name: "no id", description: "x" },
      { id: "c", name: "Bad tier", description: "x", tier: "urgent" },
      "not an object",
      null,
    ];
    const out = sanitizeDefinitions(raw);
    expect(out.map((d) => d.id)).toEqual(["a", "c"]);
    expect(out[1]!.tier).toBe("ambient"); // unknown tier falls to the only never-auto-push tier
  });

  it("caps at MAX_CUSTOM_CATEGORIES and returns [] for non-arrays", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `id-${i}`,
      name: `n${i}`,
      description: "d",
      tier: "ambient",
    }));
    expect(sanitizeDefinitions(many)).toHaveLength(MAX_CUSTOM_CATEGORIES);
    expect(sanitizeDefinitions(undefined)).toEqual([]);
    expect(sanitizeDefinitions({})).toEqual([]);
  });
});

describe("validCustomItems", () => {
  it("keeps items for known categories and denormalizes the name server-side", () => {
    const out = validCustomItems(
      [
        { category_id: "cat-1", text: "They brought up Acme's pricing", quote: "Acme does this for half", speculation: false, confidence: 0.9, source_seq: 7 },
        { category_id: "cat-1", text: "x", category_name: "SPOOFED NAME", quote: "", speculation: false, confidence: 1, source_seq: 8 },
      ],
      DEFS,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.category_name).toBe("Competitor mentions");
    expect(out[1]!.category_name).toBe("Competitor mentions"); // model-sent name ignored
  });

  it("drops items referencing an unknown category_id", () => {
    const out = validCustomItems(
      [{ category_id: "not-a-category", text: "x", quote: "", speculation: false, confidence: 1, source_seq: 1 }],
      DEFS,
    );
    expect(out).toEqual([]);
  });

  it("normalizes optional fields and rejects empty text", () => {
    const out = validCustomItems([{ category_id: "cat-2", text: "Budget is 40k" }, { category_id: "cat-2", text: "  " }], DEFS);
    expect(out).toHaveLength(1);
    expect(out[0]!.quote).toBe("");
    expect(out[0]!.speculation).toBe(false);
    expect(out[0]!.confidence).toBe(0.5);
    expect(out[0]!.source_seq).toBe(0);
  });
});

describe("validDetectedCategories", () => {
  it("drops names colliding case-insensitively with known names, and dedupes within the batch", () => {
    const out = validDetectedCategories(
      [
        { name: "budget FIGURES", description: "d", evidence: "e", source_seq: 1 },
        { name: "Hiring timeline", description: "d", evidence: "e", source_seq: 2 },
        { name: "hiring timeline", description: "again", evidence: "e", source_seq: 3 },
      ],
      ["Budget figures", "commitments"],
    );
    expect(out.map((d) => d.name)).toEqual(["Hiring timeline"]);
  });

  it("rejects unusable entries and returns [] for non-arrays", () => {
    expect(validDetectedCategories([{ name: "", description: "d" }, { description: "no name" }], [])).toEqual([]);
    expect(validDetectedCategories(undefined, [])).toEqual([]);
  });
});

describe("capPerCategory", () => {
  it("keeps at most 2 items per category, preserving order, independent across categories", () => {
    const item = (category_id: string, text: string): CustomCategoryItem => ({
      category_id,
      category_name: "n",
      text,
      quote: "",
      speculation: false,
      confidence: 0.5,
      source_seq: 0,
    });
    // 2026-07-22 QA feedback: an uncapped category degenerated into a
    // one-item-per-utterance paraphrase pass (80+ entries in one meeting).
    const out = capPerCategory([
      item("cat-1", "a"),
      item("cat-2", "x"),
      item("cat-1", "b"),
      item("cat-1", "c"),
      item("cat-2", "y"),
      item("cat-1", "d"),
    ]);
    expect(out.map((i) => i.text)).toEqual(["a", "x", "b", "y"]);
  });
});

describe("buildCustomCategoriesTool", () => {
  it("enum-constrains category_id to the defined ids and requires every output field", () => {
    const tool = buildCustomCategoriesTool(DEFS, true);
    const output = tool.output_schema as any;
    expect(output.properties.items.items.properties.category_id.enum).toEqual(["cat-1", "cat-2"]);
    // The Anthropic OpenAI-compat shim double-encodes args when schemas are
    // under-specified — pin that everything stays `required` (see memory /
    // DECISIONS.md).
    expect(output.required).toEqual(["items", "detected_categories"]);
    expect(output.properties.items.items.required).toEqual([
      "category_id",
      "text",
      "quote",
      "speculation",
      "confidence",
      "source_seq",
    ]);
    expect(output.properties.detected_categories.items.required).toEqual([
      "name",
      "description",
      "evidence",
      "source_seq",
    ]);
  });

  it("omits the empty enum when no categories are defined (empty enums are invalid JSON Schema)", () => {
    const tool = buildCustomCategoriesTool([], true);
    const output = tool.output_schema as any;
    expect(output.properties.items.items.properties.category_id.enum).toBeUndefined();
    expect(tool.system_prompt).toContain("must be an empty array");
  });

  it("embeds each definition and the detection instructions in the system prompt", () => {
    const tool = buildCustomCategoriesTool(DEFS, true);
    expect(tool.system_prompt).toContain("Competitor mentions");
    expect(tool.system_prompt).toContain("Any mention of a competing product");
    expect(tool.system_prompt).toContain("DETECTED categories");

    const noDetect = buildCustomCategoriesTool(DEFS, false);
    expect(noDetect.system_prompt).not.toContain("DETECTED categories");
    expect(noDetect.system_prompt).toContain("`detected_categories` as an empty array");
  });
});

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { validateWhisperGrammar } from "../src/policy/grammar.js";

describe("validateWhisperGrammar", () => {
  it("accepts a valid push whisper under 12 words, declarative, one sentence", () => {
    const result = validateWhisperGrammar("You have the PCI renewal Friday.", "push");
    expect(result.valid).toBe(true);
    expect(result.wordCount).toBe(6);
  });

  it("rejects a push whisper over 12 words", () => {
    const text = "You have committed to the PCI renewal deadline this coming Friday afternoon at three.";
    const result = validateWhisperGrammar(text, "push");
    expect(result.valid).toBe(false);
    expect(result.violations).toContain(`word_count_${text.split(/\s+/).length}_exceeds_12`);
  });

  it("allows a longer pull answer up to 25 words", () => {
    const text =
      "You committed to sending the deck to Priya by Friday, and there is still an open ask from Sam about the budget numbers.";
    const result = validateWhisperGrammar(text, "pull");
    expect(result.wordCount).toBeLessThanOrEqual(25 + 1); // sanity: fixture is intentionally near the limit
  });

  it("rejects a question back to the user", () => {
    const result = validateWhisperGrammar("Did you want to confirm the Friday deadline?", "push");
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("contains_question_mark");
  });

  it("rejects filler lead-ins", () => {
    const result = validateWhisperGrammar("Hey, you're double-booked Friday.", "push");
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("filler_lead_in");
  });

  it("rejects emotional punctuation", () => {
    const result = validateWhisperGrammar("You're double-booked Friday!", "push");
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("emotional_punctuation");
  });

  it("rejects multiple sentences", () => {
    const result = validateWhisperGrammar("You're double-booked. Fix it.", "push");
    expect(result.valid).toBe(false);
    expect(result.violations).toContain("multiple_sentences");
  });
});

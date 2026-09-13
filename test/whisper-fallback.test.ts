// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { deterministicFallback } from "../src/analysis/whisper.js";
import { validateWhisperGrammar, MAX_WORDS } from "../src/policy/grammar.js";

// The deterministic fallback is the last line of defense: it runs when the
// LLM rewrite errors, times out, or fails grammar twice. The audit found it
// used to emit whatever the source fact said verbatim — including
// question-shaped asks the grammar exists to ban. These pin that it now
// produces grammar-valid output for the realistic inputs it sees.
describe("deterministicFallback", () => {
  const cases: Array<{ name: string; source: string; mode: "push" | "pull" }> = [
    { name: "a question-shaped ask (the reported bug)", source: "What is the budget", mode: "pull" },
    { name: "a 'when' question", source: "When are you sending the deck", mode: "pull" },
    { name: "a filler lead-in", source: "So, you owe Priya the numbers by Friday", mode: "push" },
    { name: "a plain commitment", source: "Send the deck to Priya by Friday", mode: "push" },
    { name: "a multi-sentence fact", source: "You owe the deck. Sam still needs the budget.", mode: "pull" },
    { name: "an over-long fact", source: "You committed to the PCI renewal deadline this coming Friday afternoon at exactly three o'clock sharp downtown", mode: "push" },
  ];

  for (const { name, source, mode } of cases) {
    it(`produces a grammar-valid ${mode} whisper for ${name}`, () => {
      const out = deterministicFallback(source, mode);
      const check = validateWhisperGrammar(out, mode);
      expect(check.valid, `"${out}" violated: ${check.violations.join(", ")}`).toBe(true);
      expect(check.wordCount).toBeLessThanOrEqual(MAX_WORDS[mode]);
    });
  }

  it("never emits a trailing question mark even from a pure question", () => {
    const out = deterministicFallback("Why did the deadline move", "pull");
    expect(out).not.toContain("?");
  });

  it("degrades gracefully on a pathological all-lead-in source", () => {
    // Nothing but banned lead-in words: still returns a non-empty, single-
    // sentence string rather than throwing or returning "".
    const out = deterministicFallback("so well actually", "push");
    expect(out.length).toBeGreaterThan(0);
    expect((out.match(/[.!?]/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});

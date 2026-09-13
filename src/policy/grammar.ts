// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Whisper grammar: enforced in the prompt (schemas/whisper.json) AND validated
// here in code, per the brief — "not just prompt hope." A whisper that fails
// validation is dropped, never delivered malformed and never auto-retried
// past the candidate's TTL.

export type WhisperMode = "push" | "pull";

export const MAX_WORDS: Record<WhisperMode, number> = {
  push: 12,
  pull: 25,
};

const BANNED_LEAD_INS = [
  "hey",
  "so,",
  "so ",
  "just so you know",
  "heads up",
  "well,",
  "well ",
  "actually,",
  "look,",
  "listen,",
  "fyi",
  "note:",
  "just a heads up",
];

const QUESTION_LEAD_INS = [
  "who",
  "what",
  "when",
  "where",
  "why",
  "how",
  "is",
  "are",
  "do",
  "does",
  "did",
  "can",
  "could",
  "would",
  "will",
  "should",
];

export interface GrammarCheck {
  valid: boolean;
  violations: string[];
  wordCount: number;
}

export function validateWhisperGrammar(text: string, mode: WhisperMode): GrammarCheck {
  const violations: string[] = [];
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const maxWords = MAX_WORDS[mode];

  if (wordCount === 0) {
    return { valid: false, violations: ["empty"], wordCount: 0 };
  }
  if (wordCount > maxWords) {
    violations.push(`word_count_${wordCount}_exceeds_${maxWords}`);
  }

  // Exactly one sentence: no internal sentence-terminal punctuation, and at
  // most one terminal punctuation mark at the very end.
  const sentenceEnders = trimmed.match(/[.!?]+/g) ?? [];
  const endsWithTerminal = /[.!?]+$/.test(trimmed);
  const internalEnders = endsWithTerminal ? sentenceEnders.length - 1 : sentenceEnders.length;
  if (internalEnders > 0) {
    violations.push("multiple_sentences");
  }

  if (trimmed.includes("?")) {
    violations.push("contains_question_mark");
  }
  if (trimmed.includes("!")) {
    violations.push("emotional_punctuation");
  }

  const lower = trimmed.toLowerCase();
  const firstWord = words[0]?.toLowerCase().replace(/[^a-z']/g, "") ?? "";
  if (QUESTION_LEAD_INS.includes(firstWord)) {
    violations.push("question_lead_in");
  }
  if (BANNED_LEAD_INS.some((lead) => lower.startsWith(lead))) {
    violations.push("filler_lead_in");
  }

  return { valid: violations.length === 0, violations, wordCount };
}

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_REANALYZE_LINES,
  reanalyzeCharCount,
  reanalyzeTranscript,
  sanitizeReanalyzeLines,
  type ReanalyzeLine,
} from "../src/analysis/reanalyze.js";

const config = {
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "sk-test",
  model: "claude-sonnet-5",
};

function toolResponse(input: unknown): Response {
  return new Response(
    JSON.stringify({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "extract_analysis", input }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const emptyAnalysis = { commitments: [], asks: [], subtext: [], suggestions: [] };

function line(seq: number, text: string, speaker: ReanalyzeLine["speaker"] = "USER"): ReanalyzeLine {
  return { seq, speaker, text };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitizeReanalyzeLines", () => {
  it("rejects non-arrays and malformed lines", () => {
    expect(sanitizeReanalyzeLines(undefined)).toBeNull();
    expect(sanitizeReanalyzeLines("transcript")).toBeNull();
    expect(sanitizeReanalyzeLines([{ seq: "one", speaker: "USER", text: "hi" }])).toBeNull();
    expect(sanitizeReanalyzeLines([{ seq: 1, speaker: "USER" }])).toBeNull();
  });

  it("drops empty lines, defaults unknown speakers, and sorts by seq", () => {
    const lines = sanitizeReanalyzeLines([
      { seq: 3, speaker: "OTHER", text: "  can you review it?  " },
      { seq: 1, speaker: "narrator", text: "hello" },
      { seq: 2, speaker: "USER", text: "   " },
    ])!;
    expect(lines.map((l) => l.seq)).toEqual([1, 3]);
    expect(lines[0]!.speaker).toBe("UNKNOWN");
    expect(lines[1]!.text).toBe("can you review it?");
  });

  it("counts chars for the reject-not-truncate cap", () => {
    expect(reanalyzeCharCount([line(1, "abc"), line(2, "de")])).toBe(5);
    expect(MAX_REANALYZE_LINES).toBeGreaterThan(1000);
  });

  it("carries a valid speaker_slot through and drops garbage slots", () => {
    const lines = sanitizeReanalyzeLines([
      { seq: 1, speaker: "SYSTEM", text: "we could explore staging", speaker_slot: 5 },
      { seq: 2, speaker: "SYSTEM", text: "yep", speaker_slot: 0 }, // below the 2.. floor
      { seq: 3, speaker: "SYSTEM", text: "okay", speaker_slot: 2.7 }, // not an integer
      { seq: 4, speaker: "USER", text: "sounds good" },
    ])!;
    expect(lines[0]!.speaker_slot).toBe(5);
    expect(lines[1]!.speaker_slot).toBeUndefined();
    expect(lines[2]!.speaker_slot).toBeUndefined();
    expect("speaker_slot" in lines[3]!).toBe(false);
  });
});

describe("reanalyzeTranscript", () => {
  it("windows the transcript and carries extracted items forward as known_*", async () => {
    const requestBodies: any[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)));
        call += 1;
        if (call === 1) {
          return toolResponse({
            ...emptyAnalysis,
            commitments: [
              { text: "Send Chris the update", inferred_deadline: null, confidence: 0.9, source_seq: 2 },
            ],
            asks: [{ text: "Do you have a hard stop?", confidence: 0.8, source_seq: 5 }],
          });
        }
        return toolResponse({
          ...emptyAnalysis,
          // Same commitment text again — must dedupe across windows.
          commitments: [
            { text: "Send Chris the update", inferred_deadline: null, confidence: 0.9, source_seq: 44 },
            { text: "Book the room", inferred_deadline: null, confidence: 0.7, source_seq: 45 },
          ],
        });
      }),
    );

    // 41 lines → two windows (40 + 1).
    const lines = Array.from({ length: 41 }, (_, i) => line(i + 1, `line ${i + 1}`));
    const outcome = await reanalyzeTranscript(config, lines);

    expect(outcome.windowsRun).toBe(2);
    expect(outcome.failure).toBeUndefined();
    expect(outcome.result.commitments.map((c) => c.text)).toEqual([
      "Send Chris the update",
      "Book the room",
    ]);
    expect(outcome.result.asks.map((a) => a.text)).toEqual(["Do you have a hard stop?"]);

    // The second window's prompt must carry the first window's extractions
    // (the user message is the JSON-stringified pass input).
    const secondInput = requestBodies[1].messages[0].content as string;
    expect(secondInput).toContain("Send Chris the update");
    expect(secondInput).toContain("Do you have a hard stop?");
  });

  it("serializes speaker_slot into the LLM payload so analysis can tell feed voices apart", async () => {
    const requestBodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBodies.push(JSON.parse(init.body as string));
        return toolResponse(emptyAnalysis);
      }),
    );

    await reanalyzeTranscript(config, [
      { seq: 1, speaker: "SYSTEM", text: "I can dig around in staging", speaker_slot: 5 },
      { seq: 2, speaker: "USER", text: "great" },
    ]);

    const input = JSON.parse(requestBodies[0].messages[0].content as string);
    expect(input.transcript_window[0].speaker_slot).toBe(5);
    // Mic lines stay byte-identical to the pre-slot format: no null, no field.
    expect("speaker_slot" in input.transcript_window[1]).toBe(false);
  });

  it("drops subtext/suggestions that verbatim-duplicate a commitment or ask", async () => {
    // A sloppy window emits the same extraction under several kinds — the
    // task/ask pairing is kept, but subtext and next moves must not be
    // verbatim copies of them.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        toolResponse({
          commitments: [
            { text: "Pull up the form", inferred_deadline: null, confidence: 0.8, source_seq: 1 },
          ],
          asks: [{ text: "Pull up the form", confidence: 0.8, source_seq: 1 }],
          subtext: [
            // Confidence above the hesitation floor so what this test observes
            // is the cross-kind dedup, not the floor dropping them first.
            { text: "Pull up the form", label: "hesitation", speculation: true, confidence: 0.8, source_seq: 1 },
            { text: "USER may be hesitant about the deadline", label: "hesitation", speculation: true, confidence: 0.8, source_seq: 2 },
          ],
          suggestions: [
            { text: "Pull up the form", outcome: "form", dismissible: true, source_seq: 1 },
            { text: "Confirm the deadline in writing", outcome: "clarity", dismissible: true, source_seq: 2 },
          ],
        }),
      ),
    );

    const outcome = await reanalyzeTranscript(config, [line(1, "pull up the form"), line(2, "hmm, sure")]);

    expect(outcome.result.commitments.map((c) => c.text)).toEqual(["Pull up the form"]);
    expect(outcome.result.asks.map((a) => a.text)).toEqual(["Pull up the form"]);
    expect(outcome.result.subtext.map((s) => s.text)).toEqual(["USER may be hesitant about the deadline"]);
    expect(outcome.result.suggestions.map((s) => s.text)).toEqual(["Confirm the deadline in writing"]);
  });

  it("returns a usable partial with the failure when a later window fails", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return toolResponse({
            ...emptyAnalysis,
            commitments: [{ text: "Feed the cat", inferred_deadline: null, confidence: 0.9, source_seq: 1 }],
          });
        }
        return new Response("nope", { status: 500 });
      }),
    );

    const lines = Array.from({ length: 41 }, (_, i) => line(i + 1, `line ${i + 1}`));
    const outcome = await reanalyzeTranscript(config, lines);

    expect(outcome.windowsRun).toBe(1);
    expect(outcome.failure).toBeDefined();
    expect(outcome.result.commitments.map((c) => c.text)).toEqual(["Feed the cat"]);
  });
});

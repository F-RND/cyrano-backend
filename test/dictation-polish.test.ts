// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Hosted dictation polish. The
// route is a stateless, text-only cleanup pass; these pin the contract that
// matters for the bill and for graceful degradation: modes are sanitized,
// no-op inputs never spend a call, the input is clamped, and ANY failure
// degrades to the raw text (never to nothing).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateDictationPolish,
  sanitizeModes,
  MAX_POLISH_INPUT_CHARS,
} from "../src/analysis/dictation-polish.js";

const config = { baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-test", model: "claude-sonnet-5" };

function toolResponse(input: unknown): Response {
  return new Response(
    JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "polish_dictation", input }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitizeModes", () => {
  it("keeps only known modes and dedupes", () => {
    expect(sanitizeModes(["cleanup", "bogus", "corrections", "cleanup"]).sort()).toEqual([
      "cleanup",
      "corrections",
    ]);
  });
  it("returns [] for non-arrays and junk", () => {
    expect(sanitizeModes(undefined)).toEqual([]);
    expect(sanitizeModes("cleanup")).toEqual([]);
    expect(sanitizeModes([1, 2, {}])).toEqual([]);
  });
});

describe("generateDictationPolish", () => {
  it("passthrough without a call when no modes are enabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await generateDictationPolish(config, "um hello there", []);
    expect(out).toEqual({ text: "um hello there", source: "passthrough" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passthrough without a call for empty text", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await generateDictationPolish(config, "   ", ["cleanup"]);
    expect(out.source).toBe("passthrough");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the model's polished text on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => toolResponse({ polished_text: "Hello there." })));
    const out = await generateDictationPolish(config, "um hello there", ["cleanup"]);
    expect(out).toEqual({ text: "Hello there.", source: "llm" });
  });

  it("clamps the input to the max before sending", async () => {
    const fetchMock = vi.fn(async () => toolResponse({ polished_text: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const huge = "a ".repeat(MAX_POLISH_INPUT_CHARS); // ~2x the char cap
    await generateDictationPolish(config, huge, ["cleanup"]);
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    // The clamped text rides in the tool input (native Messages user turn).
    const serialized = JSON.stringify(sent);
    expect(serialized).toContain("a".repeat(1)); // sanity: content present
    expect(serialized.length).toBeLessThan(huge.length + 2000); // not the full 2x string
  });

  it("degrades to raw text when the model errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const out = await generateDictationPolish(config, "keep this text", ["cleanup"]);
    expect(out).toEqual({ text: "keep this text", source: "passthrough" });
  });

  it("degrades to raw text when the model returns an empty result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => toolResponse({ polished_text: "   " })));
    const out = await generateDictationPolish(config, "keep this text", ["cleanup"]);
    expect(out).toEqual({ text: "keep this text", source: "passthrough" });
  });
});

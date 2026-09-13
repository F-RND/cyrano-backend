// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  byteLength,
  generateDayContextRefine,
  refineMaxTokens,
  sanitizeScope,
  MAX_REFINE_INPUT_BYTES,
  RefineFailure,
  type RefineInput,
} from "../src/analysis/context-refine.js";

const config = {
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "sk-test",
  model: "claude-sonnet-5",
};

function toolResponse(input: unknown): Response {
  return new Response(
    JSON.stringify({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "refine_day_context", input }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const baseInput: RefineInput = {
  text: "## Tasks\n- Voice 2 will send the deck\n",
  instruction: "change Voice 2 to Jim",
  scope: "section",
  sectionTitle: "Tasks",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitizeScope", () => {
  it("keeps the two known scopes", () => {
    expect(sanitizeScope("section")).toBe("section");
    expect(sanitizeScope("document")).toBe("document");
  });

  it("falls back to the narrower scope for anything else", () => {
    // Defaulting to `section` matters: an unrecognized value must not
    // accidentally widen what gets sent to a whole-document pass.
    expect(sanitizeScope("whole")).toBe("section");
    expect(sanitizeScope(undefined)).toBe("section");
    expect(sanitizeScope(42)).toBe("section");
  });
});

describe("refineMaxTokens", () => {
  it("scales with the input rather than sitting at a constant", () => {
    const small = refineMaxTokens("a".repeat(100));
    const large = refineMaxTokens("a".repeat(20_000));
    expect(large).toBeGreaterThan(small);
  });

  it("floors small inputs", () => {
    expect(refineMaxTokens("hi")).toBe(1024);
  });

  it("leaves headroom above the largest legal input, and still has a ceiling", () => {
    // The 16k ceiling is a backstop, not a working limit: a max-size document
    // must still get room to come back at full length plus headroom.
    const atCap = refineMaxTokens("a".repeat(MAX_REFINE_INPUT_BYTES));
    expect(atCap).toBeLessThan(16_000);
    expect(atCap).toBeGreaterThan(MAX_REFINE_INPUT_BYTES / 4);
    expect(refineMaxTokens("a".repeat(1_000_000))).toBe(16_000);
  });
});

describe("byteLength", () => {
  it("measures UTF-8 bytes, not characters", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("🙂")).toBe(4);
  });
});

describe("generateDayContextRefine", () => {
  it("returns the model's revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      toolResponse({ revised_text: "## Tasks\n- Jim will send the deck\n", changed: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateDayContextRefine(config, baseInput);
    expect(result.changed).toBe(true);
    expect(result.revisedText).toContain("Jim will send the deck");
    expect(result.note).toBeNull();
  });

  it("passes the scope and section title through to the tool call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      toolResponse({ revised_text: "x", changed: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateDayContextRefine(config, baseInput);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    const sent = JSON.stringify(body);
    expect(sent).toContain("\\\"scope\\\":\\\"section\\\"");
    expect(sent).toContain("Tasks");
  });

  it("hands back the input VERBATIM when the model reports no change", async () => {
    // The whole point of `changed: false`: the client can apply the result and
    // still write back byte-identical text, so a no-op can't reword anything.
    const fetchMock = vi.fn().mockResolvedValue(
      toolResponse({
        revised_text: "## Tasks\n-  Voice 2 will send the deck",
        changed: false,
        note: "There's no Voice 2 in these notes.",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateDayContextRefine(config, baseInput);
    expect(result.changed).toBe(false);
    expect(result.revisedText).toBe(baseInput.text);
    expect(result.note).toBe("There's no Voice 2 in these notes.");
  });

  it("treats a revision identical to the input as unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      toolResponse({ revised_text: baseInput.text, changed: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateDayContextRefine(config, baseInput);
    expect(result.changed).toBe(false);
    expect(result.revisedText).toBe(baseInput.text);
  });

  it("THROWS on an upstream failure rather than degrading to passthrough", async () => {
    // Deliberately unlike dictation polish. Returning the input as though it
    // were a revision would read as "it worked and did nothing".
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateDayContextRefine(config, baseInput)).rejects.toBeInstanceOf(RefineFailure);
  });

  it("throws on an empty revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(toolResponse({ revised_text: "   ", changed: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateDayContextRefine(config, baseInput)).rejects.toBeInstanceOf(RefineFailure);
  });

  it("throws without calling the model when text or instruction is blank", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateDayContextRefine(config, { ...baseInput, instruction: "   " }),
    ).rejects.toBeInstanceOf(RefineFailure);
    await expect(
      generateDayContextRefine(config, { ...baseInput, text: "\n\n" }),
    ).rejects.toBeInstanceOf(RefineFailure);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not clamp the input — oversize is the route's 413, not a silent truncation", async () => {
    // If this module clamped like polish does, a long day document would come
    // back as a revision that deletes the user's afternoon.
    const long = "## Tasks\n" + "- a task line\n".repeat(4000);
    expect(byteLength(long)).toBeGreaterThan(MAX_REFINE_INPUT_BYTES);
    const fetchMock = vi.fn().mockResolvedValue(toolResponse({ revised_text: "ok", changed: true }));
    vi.stubGlobal("fetch", fetchMock);

    await generateDayContextRefine(config, { ...baseInput, text: long });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(JSON.stringify(body)).toContain("- a task line");
    expect(JSON.stringify(body).length).toBeGreaterThan(MAX_REFINE_INPUT_BYTES);
  });
});

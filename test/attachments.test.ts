// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import commitmentsTool from "../schemas/commitments.json";
import asksTool from "../schemas/asks.json";
import subtextTool from "../schemas/subtext.json";
import suggestionsTool from "../schemas/suggestions.json";
import { sanitizeAttachment, toUserContextItem } from "../src/attachments.js";
import { withUserContext } from "../src/analysis/passes.js";
import { buildCustomCategoriesTool, USER_CONTEXT_PROMPT } from "../src/analysis/custom.js";
import {
  MAX_ATTACHMENT_IMAGE_B64_CHARS,
  MAX_ATTACHMENT_TEXT_CHARS,
  type UserContextItem,
} from "../src/types.js";

const VALID = {
  id: "att-1",
  destination: "analysis",
  source: "clipboard",
  text: "PROJ-123: Fix export retry logic",
  keep: false,
  at: 1_700_000_000_000,
};

describe("sanitizeAttachment", () => {
  it("accepts a minimal valid clipboard attachment", () => {
    const result = sanitizeAttachment(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment).toMatchObject({
      id: "att-1",
      destination: "analysis",
      source: "clipboard",
      text: "PROJ-123: Fix export retry logic",
      keep: false,
      has_image: false,
      delivered_to_agent: false,
    });
    expect(result.imageBase64).toBeNull();
  });

  it("rejects missing/empty id or text and unknown enums", () => {
    for (const bad of [
      { ...VALID, id: "" },
      { ...VALID, text: "   " },
      { ...VALID, destination: "everyone" },
      { ...VALID, source: "microphone" },
      "not an object",
      null,
      42,
    ]) {
      const result = sanitizeAttachment(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("invalid_attachment");
    }
  });

  it("clamps text, app_name, and window_title", () => {
    const result = sanitizeAttachment({
      ...VALID,
      text: "x".repeat(MAX_ATTACHMENT_TEXT_CHARS + 500),
      app_name: "A".repeat(200),
      window_title: "W".repeat(500),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.text).toHaveLength(MAX_ATTACHMENT_TEXT_CHARS);
    expect(result.attachment.app_name).toHaveLength(60);
    expect(result.attachment.window_title).toHaveLength(120);
  });

  it("accepts a file source and clamps file_name", () => {
    const result = sanitizeAttachment({
      ...VALID,
      source: "file",
      file_name: "F".repeat(200),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment.source).toBe("file");
    expect(result.attachment.file_name).toHaveLength(120);
  });

  it("coerces keep with === true, never truthiness", () => {
    for (const keep of [1, "true", "yes", {}]) {
      const result = sanitizeAttachment({ ...VALID, keep });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.attachment.keep).toBe(false);
    }
    const kept = sanitizeAttachment({ ...VALID, keep: true });
    expect(kept.ok && kept.attachment.keep).toBe(true);
  });

  it("strips the image when the destination is analysis — text-only by shape, not convention", () => {
    const result = sanitizeAttachment({ ...VALID, destination: "analysis", image_base64: "aGVsbG8=" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.imageBase64).toBeNull();
    expect(result.attachment.has_image).toBe(false);
  });

  it("carries the image only for the agent destination", () => {
    const result = sanitizeAttachment({ ...VALID, destination: "agent", image_base64: "aGVsbG8=" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.imageBase64).toBe("aGVsbG8=");
    expect(result.attachment.has_image).toBe(true);
  });

  it("rejects an oversize agent image as attachment_too_large", () => {
    const result = sanitizeAttachment({
      ...VALID,
      destination: "agent",
      image_base64: "A".repeat(MAX_ATTACHMENT_IMAGE_B64_CHARS + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("attachment_too_large");
  });
});

describe("toUserContextItem", () => {
  it("keeps only prompt-relevant fields and omits absent optionals", () => {
    const result = sanitizeAttachment({ ...VALID, source: "window", app_name: "Jira", window_title: "PROJ-123" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(toUserContextItem(result.attachment)).toEqual({
      source: "window",
      app_name: "Jira",
      window_title: "PROJ-123",
      text: VALID.text,
    });

    const bare = sanitizeAttachment(VALID);
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    const item = toUserContextItem(bare.attachment);
    expect(item).toEqual({ source: "clipboard", text: VALID.text });
    expect("app_name" in item).toBe(false);
  });

  it("carries file_name for a file source", () => {
    const result = sanitizeAttachment({ ...VALID, source: "file", file_name: "roadmap.png" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(toUserContextItem(result.attachment)).toEqual({
      source: "file",
      file_name: "roadmap.png",
      text: VALID.text,
    });
  });
});

describe("withUserContext", () => {
  const CONTEXT: UserContextItem[] = [{ source: "clipboard", text: "ref" }];

  it("leaves the input byte-identical when there is no context", () => {
    const input = { transcript_window: [], known_open_asks: [] };
    const out = withUserContext(input, []);
    expect(out).toBe(input); // same object, not a copy with an empty key
    expect("user_context" in out).toBe(false);
  });

  it("adds user_context without disturbing existing keys", () => {
    const out = withUserContext({ transcript_window: [] }, CONTEXT);
    expect(out).toEqual({ transcript_window: [], user_context: CONTEXT });
  });
});

// The four static pass schemas double as the portable hermes-agent contract,
// so the user_context addition must stay strictly additive: present in
// properties, absent from `required`, and explained in the system prompt.
describe("pass schema contract", () => {
  const SCHEMAS = [
    ["commitments", commitmentsTool],
    ["asks", asksTool],
    ["subtext", subtextTool],
    ["suggestions", suggestionsTool],
  ] as const;

  for (const [name, tool] of SCHEMAS) {
    it(`${name}.json carries an optional user_context and the shared prompt rule`, () => {
      const schema = tool as any;
      const property = schema.input_schema.properties.user_context;
      expect(property?.type).toBe("array");
      expect(property.items.properties.source.enum).toEqual(["clipboard", "window", "file"]);
      expect(property.items.required).toEqual(["source", "text"]);
      expect(schema.input_schema.required).not.toContain("user_context");
      expect(schema.system_prompt).toContain(USER_CONTEXT_PROMPT);
    });
  }

  it("custom-categories tool gets the same optional property and prompt rule", () => {
    const tool = buildCustomCategoriesTool(
      [{ id: "c1", name: "N", description: "d", tier: "ambient" }],
      false,
    );
    const input = tool.input_schema as any;
    expect(input.properties.user_context?.type).toBe("array");
    expect(input.required).not.toContain("user_context");
    expect(tool.system_prompt).toContain(USER_CONTEXT_PROMPT);
  });
});

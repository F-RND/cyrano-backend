// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MAX_INDEX_ID_CHARS,
  MAX_INDEX_SCOPE_CHARS,
  MAX_INDEX_SESSIONS,
  MAX_INDEX_TAG_CHARS,
  MAX_INDEX_TAGS,
  MAX_INDEX_TITLE_CHARS,
  sanitizeSessionIndex,
} from "../src/inbox-key.js";

// The session index (documentation/PLAN-REMOTE.md option D) is the ONLY thing
// origin-pull leaves at rest, so what it may contain is a privacy boundary, not
// a formatting detail: it is metadata a device published, clamped here, and
// never used to authorize anything (every read is answered by the device).

describe("sanitizeSessionIndex", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "s1",
    title: "Acme term sheet",
    started_at: 1_700_000_000_000,
    ...over,
  });

  it("keeps the metadata an assistant needs to name a session", () => {
    const index = sanitizeSessionIndex(
      { sessions: [row({ ended_at: 1_700_000_600_000, tags: ["Acme"], running: true })] },
      "Studio Mac",
      42,
    );
    expect(index.sessions[0]).toEqual({
      id: "s1",
      title: "Acme term sheet",
      started_at: 1_700_000_000_000,
      ended_at: 1_700_000_600_000,
      tags: ["Acme"],
      running: true,
    });
    expect(index.device).toBe("Studio Mac");
    expect(index.built_at).toBe(42);
  });

  it("carries the device's sharing scope so a narrow list isn't read as a short history", () => {
    expect(sanitizeSessionIndex({ sessions: [], scope: "today" }, undefined, 0).scope).toBe("today");
  });

  it("DROPS a row with no id or no start time rather than defaulting one", () => {
    // An index entry that can't be fetched later is worse than an absent one:
    // the assistant names it to the user and then fails to open it.
    const index = sanitizeSessionIndex(
      {
        sessions: [
          row(),
          { title: "no id", started_at: 1 },
          { id: "s2", title: "no start" },
          { id: "", title: "empty id", started_at: 1 },
          { id: "s3", title: "nan start", started_at: Number.NaN },
          null,
        ],
      },
      undefined,
      0,
    );
    expect(index.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("clamps a title rather than dropping the session it names", () => {
    const long = "x".repeat(MAX_INDEX_TITLE_CHARS + 50);
    const index = sanitizeSessionIndex({ sessions: [row({ title: long })] }, undefined, 0);
    expect(index.sessions[0]?.title).toHaveLength(MAX_INDEX_TITLE_CHARS);
    expect(index.sessions[0]?.id).toBe("s1");
  });

  it("tolerates a missing title without inventing one", () => {
    const index = sanitizeSessionIndex({ sessions: [row({ title: 42 })] }, undefined, 0);
    expect(index.sessions[0]?.title).toBe("");
  });

  it("caps how many sessions and tags a device can publish", () => {
    const many = Array.from({ length: MAX_INDEX_SESSIONS + 25 }, (_, i) => row({ id: `s${i}` }));
    expect(sanitizeSessionIndex({ sessions: many }, undefined, 0).sessions).toHaveLength(
      MAX_INDEX_SESSIONS,
    );
    const tags = Array.from({ length: MAX_INDEX_TAGS + 10 }, (_, i) => `t${i}`);
    expect(sanitizeSessionIndex({ sessions: [row({ tags })] }, undefined, 0).sessions[0]?.tags)
      .toHaveLength(MAX_INDEX_TAGS);
  });

  it("omits empty tags rather than emitting an empty array", () => {
    const index = sanitizeSessionIndex({ sessions: [row({ tags: [1, 2] })] }, undefined, 0);
    expect(index.sessions[0]).not.toHaveProperty("tags");
  });

  it("DROPS a row with an over-long id rather than truncating it unfetchable", () => {
    // A clamped id would name a session that can never be opened — the same
    // failure the missing-id drop rule exists to prevent.
    const index = sanitizeSessionIndex(
      { sessions: [row(), row({ id: "x".repeat(MAX_INDEX_ID_CHARS + 1) })] },
      undefined,
      0,
    );
    expect(index.sessions.map((s) => s.id)).toEqual(["s1"]);
    const uuidLike = "x".repeat(MAX_INDEX_ID_CHARS);
    expect(
      sanitizeSessionIndex({ sessions: [row({ id: uuidLike })] }, undefined, 0).sessions[0]?.id,
    ).toBe(uuidLike);
  });

  it("clamps each tag and drops blanks so a giant tag can't smuggle bulk", () => {
    const index = sanitizeSessionIndex(
      { sessions: [row({ tags: ["", "t".repeat(MAX_INDEX_TAG_CHARS + 500), "Acme"] })] },
      undefined,
      0,
    );
    expect(index.sessions[0]?.tags).toEqual(["t".repeat(MAX_INDEX_TAG_CHARS), "Acme"]);
  });

  it("clamps the scope string", () => {
    const index = sanitizeSessionIndex(
      { sessions: [], scope: "s".repeat(MAX_INDEX_SCOPE_CHARS + 100) },
      undefined,
      0,
    );
    expect(index.scope).toHaveLength(MAX_INDEX_SCOPE_CHARS);
  });

  it("never carries anything but metadata, whatever the device sends", () => {
    // The load-bearing one. A device (or a tampered frame) that includes
    // transcript text must not get it stored: this object is the thing the
    // privacy claim says holds no conversations.
    const index = sanitizeSessionIndex(
      {
        sessions: [
          row({
            transcript: [{ text: "we agreed to the 20% discount" }],
            notes: ["private"],
            hot_state: { commitments: ["ship Thursday"] },
          }),
        ],
      },
      undefined,
      0,
    );
    const serialized = JSON.stringify(index);
    expect(serialized).not.toContain("discount");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("Thursday");
    expect(Object.keys(index.sessions[0] ?? {}).sort()).toEqual(["id", "started_at", "title"]);
  });

  it("returns an empty index for junk rather than throwing", () => {
    expect(sanitizeSessionIndex(null, undefined, 0).sessions).toEqual([]);
    expect(sanitizeSessionIndex({ sessions: "nope" }, undefined, 0).sessions).toEqual([]);
    expect(sanitizeSessionIndex(undefined, undefined, 0).sessions).toEqual([]);
  });
});

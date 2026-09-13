// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { presenceWarmHint, PRESENCE_WARM_WINDOW_MS } from "../src/index.js";

// Presence warm-up: a connected agent
// polls /agent/latest with no live session and should learn whether the user is
// around so it can stay warm instead of 404-backing-off. The window logic must
// (a) hint on a recent stamp, (b) fall back to the old 404 on a stale/absent
// stamp so an idle-forever agent is untouched.
describe("presenceWarmHint", () => {
  const now = 1_000_000_000_000;

  it("returns a warm hint for a stamp inside the window", () => {
    const hint = presenceWarmHint(now - 1000, now);
    expect(hint).toEqual({ session_id: null, presence: "active", since: now - 1000 });
  });

  it("treats a stamp exactly at the window edge as still warm", () => {
    expect(presenceWarmHint(now - PRESENCE_WARM_WINDOW_MS, now)).not.toBeNull();
  });

  it("returns null (→ 404) once the stamp is past the window", () => {
    expect(presenceWarmHint(now - PRESENCE_WARM_WINDOW_MS - 1, now)).toBeNull();
  });

  it("returns null when there is no presence stamp at all", () => {
    expect(presenceWarmHint(null, now)).toBeNull();
    expect(presenceWarmHint(undefined, now)).toBeNull();
  });

  it("carries the original stamp through as `since` (agent can gauge staleness)", () => {
    const stamp = now - 42_000;
    expect(presenceWarmHint(stamp, now)?.since).toBe(stamp);
  });
});

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  normalizeAppVersion,
  normalizePlatform,
  summarizeAdoption,
  UNKNOWN,
  type AdoptionSighting,
} from "../src/adoption.js";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// `in` rather than `??` throughout: an explicit null is a case under test (a
// record that never checked in, a client that reported no version), and `??`
// would quietly hand it back the default instead.
function sighting(over: Partial<AdoptionSighting> = {}): AdoptionSighting {
  return {
    version: "version" in over ? over.version : "1.0.152",
    platform: "platform" in over ? over.platform : "mac",
    lastSeenAt: "lastSeenAt" in over ? over.lastSeenAt : new Date(NOW - HOUR).toISOString(),
    source: over.source ?? "license",
  };
}

describe("normalizeAppVersion", () => {
  it("accepts the shapes the app actually ships", () => {
    expect(normalizeAppVersion("1.0.152")).toBe("1.0.152");
    expect(normalizeAppVersion(" 2.1 ")).toBe("2.1");
    expect(normalizeAppVersion("1.0.152.3")).toBe("1.0.152.3");
  });

  it("rejects anything that isn't a version", () => {
    for (const bad of ["", "latest", "1.0.152-beta", "<script>", "1.0.152 ok", 152, null, {}]) {
      expect(normalizeAppVersion(bad)).toBeNull();
    }
    // Long enough to be a payload rather than a version.
    expect(normalizeAppVersion("1".repeat(64))).toBeNull();
  });
});

describe("normalizePlatform", () => {
  it("allowlists the shipping platforms, case-insensitively", () => {
    expect(normalizePlatform("mac")).toBe("mac");
    expect(normalizePlatform("MAC-AppStore")).toBe("mac-appstore");
    expect(normalizePlatform("ios")).toBe("ios");
  });

  it("rejects anything else", () => {
    for (const bad of ["macos", "other", "", "windows", 1, undefined]) {
      expect(normalizePlatform(bad)).toBeNull();
    }
  });
});

describe("summarizeAdoption", () => {
  it("counts devices per version and platform", () => {
    const summary = summarizeAdoption(
      [
        sighting(),
        sighting(),
        sighting({ platform: "ios" }),
        sighting({ version: "1.0.150" }),
      ],
      { now: NOW, windowDays: 30 },
    );

    expect(summary.totals.devices).toBe(4);
    expect(summary.versions).toHaveLength(3);
    // Newest release first, so the top row is "who took the latest update".
    expect(summary.versions[0]).toMatchObject({ version: "1.0.152", platform: "ios", devices: 1 });
    expect(summary.versions[1]).toMatchObject({ version: "1.0.152", platform: "mac", devices: 2 });
    expect(summary.versions[2]).toMatchObject({ version: "1.0.150", devices: 1 });
  });

  it("splits licensed from trial devices in every row and total", () => {
    const summary = summarizeAdoption(
      [sighting(), sighting({ source: "trial" }), sighting({ source: "trial" })],
      { now: NOW, windowDays: 30 },
    );

    expect(summary.totals).toMatchObject({ devices: 3, licensed: 1, trial: 2 });
    expect(summary.versions[0]).toMatchObject({ devices: 3, licensed: 1, trial: 2 });
  });

  it("drops devices last seen before the window and keeps the rest", () => {
    const summary = summarizeAdoption(
      [
        sighting({ lastSeenAt: new Date(NOW - 40 * DAY).toISOString() }),
        sighting({ lastSeenAt: new Date(NOW - 3 * DAY).toISOString() }),
      ],
      { now: NOW, windowDays: 30 },
    );

    expect(summary.totals.devices).toBe(1);
  });

  it("reports 1-day and 7-day activity inside the window", () => {
    const summary = summarizeAdoption(
      [
        sighting({ lastSeenAt: new Date(NOW - 2 * HOUR).toISOString() }),
        sighting({ lastSeenAt: new Date(NOW - 3 * DAY).toISOString() }),
        sighting({ lastSeenAt: new Date(NOW - 20 * DAY).toISOString() }),
      ],
      { now: NOW, windowDays: 30 },
    );

    expect(summary.versions[0]).toMatchObject({ devices: 3, active_1d: 1, active_7d: 2 });
  });

  it("buckets a device that reported nothing, and sorts that bucket last", () => {
    const summary = summarizeAdoption(
      [sighting({ version: null, platform: null }), sighting({ version: "1.0.152" })],
      { now: NOW, windowDays: 30 },
    );

    expect(summary.totals.unknown_version).toBe(1);
    expect(summary.versions.at(-1)).toMatchObject({ version: UNKNOWN, platform: UNKNOWN });
  });

  it("treats a junk version as unknown rather than trusting it into a row", () => {
    const summary = summarizeAdoption([sighting({ version: "definitely-not-a-version" })], {
      now: NOW,
      windowDays: 30,
    });

    expect(summary.versions[0]?.version).toBe(UNKNOWN);
    expect(summary.totals.unknown_version).toBe(1);
  });

  it("ignores records that have never checked in", () => {
    const summary = summarizeAdoption(
      [sighting({ lastSeenAt: null }), sighting({ lastSeenAt: "not a date" })],
      { now: NOW, windowDays: 30 },
    );

    expect(summary.totals.devices).toBe(0);
    expect(summary.versions).toEqual([]);
  });

  it("clamps the window to something a scan can mean", () => {
    expect(summarizeAdoption([], { now: NOW, windowDays: 0 }).window_days).toBe(1);
    expect(summarizeAdoption([], { now: NOW, windowDays: 5000 }).window_days).toBe(365);
  });

  it("keeps the most recent check-in as the row's last_seen_at", () => {
    const recent = new Date(NOW - HOUR).toISOString();
    const summary = summarizeAdoption(
      [
        sighting({ lastSeenAt: new Date(NOW - 5 * DAY).toISOString() }),
        sighting({ lastSeenAt: recent }),
        sighting({ lastSeenAt: new Date(NOW - 2 * DAY).toISOString() }),
      ],
      { now: NOW, windowDays: 30 },
    );

    expect(summary.versions[0]?.last_seen_at).toBe(recent);
  });
});

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  bugReportKey,
  BUG_REPORT_PREFIX,
  MAX_DESCRIPTION_CHARS,
  MAX_DIAGNOSTIC_CHARS,
  MAX_EMAIL_CHARS,
  rateLimitKey,
  sanitizeBugReport,
  utcDayBucket,
} from "../src/bugreport.js";

describe("sanitizeBugReport", () => {
  it("keeps a full, well-formed report intact", () => {
    const report = sanitizeBugReport({
      category: "bug",
      description: "The menu bar icon vanished after waking from sleep.",
      email: "person@example.com",
      diagnostics: {
        app_version: "1.0.66",
        build: "1000066",
        platform: "macOS",
        os_version: "15.5",
        device_model: "Mac14,10",
        locale: "en_AU",
      },
    });
    expect(report).toEqual({
      category: "bug",
      description: "The menu bar icon vanished after waking from sleep.",
      email: "person@example.com",
      diagnostics: {
        app_version: "1.0.66",
        build: "1000066",
        platform: "macOS",
        os_version: "15.5",
        device_model: "Mac14,10",
        locale: "en_AU",
      },
    });
  });

  it("returns null when there is nothing to store", () => {
    expect(sanitizeBugReport(null)).toBeNull();
    expect(sanitizeBugReport("text")).toBeNull();
    expect(sanitizeBugReport([])).toBeNull();
    expect(sanitizeBugReport({})).toBeNull();
    expect(sanitizeBugReport({ description: "   " })).toBeNull();
    expect(sanitizeBugReport({ description: 42 })).toBeNull();
  });

  it("truncates an overlong description instead of rejecting it", () => {
    const report = sanitizeBugReport({ description: "x".repeat(MAX_DESCRIPTION_CHARS + 500) });
    expect(report?.description).toHaveLength(MAX_DESCRIPTION_CHARS);
  });

  it("maps unknown categories to other", () => {
    expect(sanitizeBugReport({ category: "rant", description: "hi" })?.category).toBe("other");
    expect(sanitizeBugReport({ category: 7, description: "hi" })?.category).toBe("other");
    expect(sanitizeBugReport({ description: "hi" })?.category).toBe("other");
    expect(sanitizeBugReport({ category: "idea", description: "hi" })?.category).toBe("idea");
  });

  it("drops (never rejects on) a malformed or overlong email", () => {
    expect(sanitizeBugReport({ description: "hi", email: "not-an-email" })?.email).toBeUndefined();
    expect(sanitizeBugReport({ description: "hi", email: "two words@x.com" })?.email).toBeUndefined();
    expect(
      sanitizeBugReport({ description: "hi", email: `a@${"b".repeat(MAX_EMAIL_CHARS)}.com` })?.email,
    ).toBeUndefined();
    expect(sanitizeBugReport({ description: "hi", email: "  a@b.com  " })?.email).toBe("a@b.com");
  });

  it("copies only the known diagnostic fields, clamped", () => {
    const report = sanitizeBugReport({
      description: "hi",
      diagnostics: {
        app_version: "1.0.66",
        device_model: "m".repeat(MAX_DIAGNOSTIC_CHARS + 40),
        secret_injected_key: "should never survive",
        os_version: 15.5,
      },
    });
    expect(report?.diagnostics).toEqual({
      app_version: "1.0.66",
      device_model: "m".repeat(MAX_DIAGNOSTIC_CHARS),
    });
    expect(JSON.stringify(report)).not.toContain("secret_injected_key");
  });

  it("omits diagnostics entirely when the block is empty or malformed", () => {
    expect(sanitizeBugReport({ description: "hi", diagnostics: {} })?.diagnostics).toBeUndefined();
    expect(sanitizeBugReport({ description: "hi", diagnostics: "1.0.66" })?.diagnostics).toBeUndefined();
    expect(sanitizeBugReport({ description: "hi", diagnostics: [] })?.diagnostics).toBeUndefined();
  });
});

describe("rate-limit keys", () => {
  it("buckets by UTC day", () => {
    const justBeforeMidnight = Date.UTC(2026, 6, 20, 23, 59, 59);
    const justAfterMidnight = Date.UTC(2026, 6, 21, 0, 0, 1);
    expect(utcDayBucket(justBeforeMidnight)).toBe("2026-07-20");
    expect(utcDayBucket(justAfterMidnight)).toBe("2026-07-21");
    expect(rateLimitKey("abc", justBeforeMidnight)).toBe("bugreport-rl:2026-07-20:abc");
    expect(rateLimitKey("abc", justAfterMidnight)).not.toBe(rateLimitKey("abc", justBeforeMidnight));
  });

  it("puts the day before the client hash so stale buckets prune by prefix", () => {
    expect(rateLimitKey("abc", Date.UTC(2026, 6, 20)).startsWith("bugreport-rl:2026-07-20:")).toBe(true);
  });
});

describe("bugReportKey", () => {
  it("orders lexicographically by time", () => {
    const earlier = bugReportKey(Date.UTC(2026, 6, 20, 10, 0, 0), "aaaa");
    const later = bugReportKey(Date.UTC(2026, 6, 20, 10, 0, 1), "aaaa");
    expect(earlier < later).toBe(true);
    expect(earlier.startsWith(BUG_REPORT_PREFIX)).toBe(true);
  });
});

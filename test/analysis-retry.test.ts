// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isRetryableFailure } from "../src/session-do.js";

// A failed analysis pass is HELD for retry (window kept, cursor not advanced)
// only when the failure looks transient — the provider was momentarily away,
// not refusing our request. This pins that classification: get it wrong toward
// "retryable" and a genuinely-bad request loops until the cap; get it wrong
// toward "terminal" and a cold-model/rate-limit blip silently drops a window.

describe("isRetryableFailure", () => {
  it("holds when there is no HTTP status (network error / timeout / refusal)", () => {
    expect(isRetryableFailure({ message: "fetch failed" })).toBe(true);
    expect(isRetryableFailure({ message: "timed out", status: undefined })).toBe(true);
  });

  it("holds on the provider's back-off signals: 429, 408, and any 5xx", () => {
    expect(isRetryableFailure({ message: "rate limited", status: 429 })).toBe(true);
    expect(isRetryableFailure({ message: "request timeout", status: 408 })).toBe(true);
    expect(isRetryableFailure({ message: "overloaded", status: 503 })).toBe(true);
    expect(isRetryableFailure({ message: "bad gateway", status: 502 })).toBe(true);
    expect(isRetryableFailure({ message: "server error", status: 500 })).toBe(true);
  });

  it("does NOT hold on our-fault 4xx — those loop, they don't heal", () => {
    expect(isRetryableFailure({ message: "bad request", status: 400 })).toBe(false);
    expect(isRetryableFailure({ message: "unauthorized", status: 401 })).toBe(false);
    expect(isRetryableFailure({ message: "forbidden", status: 403 })).toBe(false);
    expect(isRetryableFailure({ message: "not found", status: 404 })).toBe(false);
  });

  it("treats a clean (no-failure) pass as not-retryable", () => {
    expect(isRetryableFailure(undefined)).toBe(false);
  });
});

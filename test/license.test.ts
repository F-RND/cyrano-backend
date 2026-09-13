// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { generateLicenseKey } from "../src/license.js";

describe("generateLicenseKey", () => {
  it("formats CYRANO-XXXX-XXXX-XXXX-XXXX (four groups) from the unambiguous alphabet", () => {
    const key = generateLicenseKey();
    // Four groups distinguishes a Pro license from the three-group promo code.
    // The "CYRANO" prefix itself contains an O, so pin the group charset only.
    expect(key).toMatch(/^CYRANO-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it("is longer / higher-entropy than a promo code (four groups vs three)", () => {
    expect(generateLicenseKey().split("-")).toHaveLength(5); // prefix + 4 groups
  });

  it("is unique across many calls", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateLicenseKey()));
    expect(keys.size).toBe(200);
  });

  it("honors a custom prefix", () => {
    expect(generateLicenseKey("TEST")).toMatch(/^TEST-/);
  });
});

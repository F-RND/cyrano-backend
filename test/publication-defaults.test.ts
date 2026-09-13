// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

function request(path: string): Request {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("token-less feature publication defaults", () => {
  it.each(["/appstore/link", "/appstore/notifications"])(
    "fails closed for %s unless App Store support is explicitly enabled",
    async (path) => {
      const res = await worker.fetch(request(path), {} as Env);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("app store integration disabled");
    },
  );

  it("does not touch the registry when free-cold enrollment is not explicitly enabled", async () => {
    const get = vi.fn();
    const env = { REGISTRY_DO: { get } } as unknown as Env;
    const res = await worker.fetch(request("/free-cold/enroll"), env);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("free-cold enrollment disabled");
    expect(get).not.toHaveBeenCalled();
  });
});

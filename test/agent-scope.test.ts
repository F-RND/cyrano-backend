// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isAllowedAgentOperation } from "../src/index.js";

// The audit's top backend finding: an agent key (sold as a limited,
// revocable pull/push credential) could reach /review, DELETE, /redact, and
// even a WebSocket upgrade, because the DO dispatches on path suffix with no
// notion of the /agent/ prefix. This pins the allowlist that now gates the
// agent routes to exactly context-read and results-push.
describe("isAllowedAgentOperation", () => {
  const req = (method: string) => new Request("https://x", { method });

  it("allows GET /context (the poll)", () => {
    expect(isAllowedAgentOperation(req("GET"), "/context")).toBe(true);
  });

  it("allows POST /results (the push)", () => {
    expect(isAllowedAgentOperation(req("POST"), "/results")).toBe(true);
  });

  it("blocks the full-transcript /review read", () => {
    expect(isAllowedAgentOperation(req("GET"), "/review")).toBe(false);
  });

  it("blocks DELETE (purge)", () => {
    expect(isAllowedAgentOperation(req("DELETE"), "")).toBe(false);
    expect(isAllowedAgentOperation(req("DELETE"), "/results")).toBe(false);
  });

  it("blocks /redact", () => {
    expect(isAllowedAgentOperation(req("POST"), "/redact")).toBe(false);
  });

  it("blocks a WebSocket upgrade path", () => {
    expect(isAllowedAgentOperation(req("GET"), "/ws")).toBe(false);
  });

  it("blocks method/path mismatches", () => {
    expect(isAllowedAgentOperation(req("POST"), "/context")).toBe(false);
    expect(isAllowedAgentOperation(req("GET"), "/results")).toBe(false);
  });
});

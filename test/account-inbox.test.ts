// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { inboxKeyFor } from "../src/index.js";

// The account-inbox routing key:
// the agent push and the client stream must resolve to the SAME DO instance
// for a given account, or a ping never reaches the client. A tenant/relay
// account is keyed by its userId; an operator/self-host deployment is one
// account, so both sides meet at a single fixed "operator" inbox.
describe("inboxKeyFor", () => {
  it("keys a tenant/relay account by its userId", () => {
    expect(inboxKeyFor({ kind: "user", userId: "relay_abc123" })).toBe("user:relay_abc123");
  });

  it("keys the operator/self-host deployment to one shared inbox", () => {
    expect(inboxKeyFor({ kind: "operator" })).toBe("operator");
  });

  it("gives two tenants distinct inboxes", () => {
    expect(inboxKeyFor({ kind: "user", userId: "a" })).not.toBe(
      inboxKeyFor({ kind: "user", userId: "b" }),
    );
  });

  it("never collides a tenant named 'operator' with the operator inbox", () => {
    expect(inboxKeyFor({ kind: "user", userId: "operator" })).toBe("user:operator");
    expect(inboxKeyFor({ kind: "user", userId: "operator" })).not.toBe(
      inboxKeyFor({ kind: "operator" }),
    );
  });
});

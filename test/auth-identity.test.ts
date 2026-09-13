// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  encodeIdentity,
  forwardWithIdentity,
  identityFromUrl,
  sessionAccessAllowed,
} from "../src/auth.js";

// The core of the multi-tenant auth model (2026-07-13): a session created
// under a tenant token is only reachable by that tenant or the operator; a
// session with no owner (self-host / operator-created) stays open to
// anyone the router already authorized, exactly as before tenant users
// existed. This is the single rule SessionDO.fetch() gates every request
// on, so it's pinned here precisely.
describe("sessionAccessAllowed", () => {
  it("allows anyone into an ownerless session (self-host / operator-created)", () => {
    expect(sessionAccessAllowed({ kind: "operator" }, undefined)).toBe(true);
    expect(sessionAccessAllowed({ kind: "user", userId: "alice" }, undefined)).toBe(true);
  });

  it("lets the operator into any tenant's session (superuser/debug escape hatch)", () => {
    expect(sessionAccessAllowed({ kind: "operator" }, "alice")).toBe(true);
  });

  it("lets the owning tenant into their own session", () => {
    expect(sessionAccessAllowed({ kind: "user", userId: "alice" }, "alice")).toBe(true);
  });

  it("blocks a different tenant from a session they don't own", () => {
    expect(sessionAccessAllowed({ kind: "user", userId: "mallory" }, "alice")).toBe(false);
  });
});

describe("identity encode/decode round trip", () => {
  it("round-trips the operator identity through a URL", () => {
    const url = new URL("https://x/session/s1/review");
    url.searchParams.set("_identity", encodeIdentity({ kind: "operator" }));
    expect(identityFromUrl(url)).toEqual({ kind: "operator" });
  });

  it("round-trips a tenant identity through a URL", () => {
    const url = new URL("https://x/session/s1/review");
    url.searchParams.set("_identity", encodeIdentity({ kind: "user", userId: "alice-id" }));
    expect(identityFromUrl(url)).toEqual({ kind: "user", userId: "alice-id" });
  });

  it("defaults to operator when the marker is absent — matches pre-tenancy behavior", () => {
    const url = new URL("https://x/session/s1/review");
    expect(identityFromUrl(url)).toEqual({ kind: "operator" });
  });

  it("defaults to operator on a malformed marker rather than throwing", () => {
    const url = new URL("https://x/session/s1/review?_identity=garbage");
    expect(identityFromUrl(url)).toEqual({ kind: "operator" });
  });
});

describe("forwardWithIdentity", () => {
  it("preserves method, headers, and the identity marker when cloning a request", () => {
    const original = new Request("https://x/session/s1/redact", {
      method: "POST",
      headers: { authorization: "Bearer abc", "content-type": "application/json" },
    });
    const forwarded = forwardWithIdentity(original, { kind: "user", userId: "alice-id" });
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("authorization")).toBe("Bearer abc");
    expect(identityFromUrl(new URL(forwarded.url))).toEqual({ kind: "user", userId: "alice-id" });
  });

  it("preserves a websocket upgrade's headers (the mechanism the WS path relies on)", () => {
    const original = new Request("https://x/session/s1/ws", {
      headers: {
        authorization: "Bearer abc",
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAA==",
        "sec-websocket-version": "13",
      },
    });
    const forwarded = forwardWithIdentity(original, { kind: "operator" });
    expect(forwarded.headers.get("upgrade")).toBe("websocket");
    expect(forwarded.headers.get("sec-websocket-key")).toBe("AAAAAAAAAAAAAAAAAAAAAA==");
    expect(identityFromUrl(new URL(forwarded.url))).toEqual({ kind: "operator" });
  });
});

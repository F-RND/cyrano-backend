// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  isEntitled,
  narrowestRetention,
  RELAY_PLAN,
  RELAY_RETENTION_CEILING_MS,
  relayRetentionAction,
  sessionAnalysisAccess,
} from "../src/entitlement.js";
import { retentionAfterFrame } from "../src/session-do.js";

// Pro live relay. The critical server
// invariant: a `pro-relay` identity exists so a Pro user's live session can
// transit the Worker for the agent loop — it must NEVER receive hosted analysis
// on the operator's key. `isEntitled` default-allows identities with no
// subscription and no promo (which is exactly what a relay identity looks
// like), so the guard lives in the session-level gate keyed on the plan. These
// tests pin both halves of that arrangement.

describe("sessionAnalysisAccess", () => {
  it("forces a pro-relay identity out of hosted analysis, whatever the registry's entitled flag said", () => {
    expect(sessionAnalysisAccess({ entitled: true, plan: RELAY_PLAN })).toEqual({
      userEntitled: false,
      relayOnly: true,
      hostedRelay: true,
    });
    expect(sessionAnalysisAccess({ entitled: false, plan: RELAY_PLAN })).toEqual({
      userEntitled: false,
      relayOnly: true,
      hostedRelay: true,
    });
    expect(sessionAnalysisAccess({ plan: RELAY_PLAN })).toEqual({
      userEntitled: false,
      relayOnly: true,
      hostedRelay: true,
    });
  });

  it("passes the entitled flag through unchanged for every non-relay plan", () => {
    expect(sessionAnalysisAccess({ entitled: true, plan: "annual" })).toEqual({
      userEntitled: true,
      relayOnly: false,
      hostedRelay: false,
    });
    expect(sessionAnalysisAccess({ entitled: false, plan: "monthly" })).toEqual({
      userEntitled: false,
      relayOnly: false,
      hostedRelay: false,
    });
    expect(sessionAnalysisAccess({ entitled: true, plan: null })).toEqual({
      userEntitled: true,
      relayOnly: false,
      hostedRelay: false,
    });
  });

  it("fails open (entitled, not relay) when the entitlement fetch yielded nothing", () => {
    // Mirrors the hello-path catch: a registry hiccup must not kill a paying
    // session's analysis, and must never mark it relay-only.
    expect(sessionAnalysisAccess({})).toEqual({
      userEntitled: true,
      relayOnly: false,
      hostedRelay: false,
    });
  });

  it("hostedRelay tracks the PLAN, never a client's own assertion", () => {
    // The retention ceiling keys on this, and a self-hoster's client asserts
    // relay_only over the wire for its OWN Worker. If hostedRelay could be set
    // that way, our retention policy would start deleting data off someone
    // else's server.
    expect(sessionAnalysisAccess({ plan: RELAY_PLAN }).hostedRelay).toBe(true);
    expect(sessionAnalysisAccess({ entitled: true }).hostedRelay).toBe(false);
    expect(sessionAnalysisAccess({ entitled: true, plan: "annual" }).hostedRelay).toBe(false);
  });

  it("relayOnly is never true without userEntitled false — relay_only copy implies analysis is off", () => {
    for (const ent of [
      {},
      { entitled: true },
      { entitled: false },
      { plan: RELAY_PLAN },
      { entitled: true, plan: RELAY_PLAN },
      { entitled: false, plan: "annual" },
    ]) {
      const access = sessionAnalysisAccess(ent);
      if (access.relayOnly) expect(access.userEntitled).toBe(false);
    }
  });
});

// The retention ceiling (documentation/PLAN-REMOTE.md option C). What makes
// "Remote stores nothing after the call" literally true rather than
// true-unless-you-pinned-it.
describe("relayRetentionAction", () => {
  const DAY = 24 * 60 * 60_000;
  const act = (over: Partial<Parameters<typeof relayRetentionAction>[0]> = {}) =>
    relayRetentionAction({
      retention: "24h",
      hostedRelay: true,
      retain24hMs: DAY,
      ...over,
    });

  it("caps a 24h relayed session at the ceiling", () => {
    expect(act()).toEqual({
      kind: "purge_after",
      afterMs: RELAY_RETENTION_CEILING_MS,
      ceiling: true,
    });
  });

  it("PURGES A PINNED relayed session at the ceiling", () => {
    // The case the whole thing exists for: pinning is a statement about the
    // user's own archive on their device, never a licence for an indefinite
    // copy on our server. Without this, "there is no database of your
    // conversations" is false for anyone who ever pinned one.
    expect(act({ retention: "pinned" })).toEqual({
      kind: "purge_after",
      afterMs: RELAY_RETENTION_CEILING_MS,
      ceiling: true,
    });
  });

  it("clamps, never extends — ephemeral still purges immediately", () => {
    expect(act({ retention: "ephemeral" })).toEqual({ kind: "purge_now" });
    expect(act({ retention: "ephemeral", hostedRelay: false })).toEqual({ kind: "purge_now" });
  });

  it("honours a retention SHORTER than the ceiling instead of rounding it up", () => {
    // More-private-never-less. A user who asked for ten minutes gets ten.
    const tenMinutes = 10 * 60_000;
    expect(act({ retain24hMs: tenMinutes })).toEqual({
      kind: "purge_after",
      afterMs: tenMinutes,
      ceiling: false,
    });
  });

  it("leaves a SELF-HOSTED relay's retention entirely alone", () => {
    // Their Worker, their data, their policy. Our ceiling covers our claim
    // about our deployment and must not reach onto someone else's machine.
    expect(act({ hostedRelay: false })).toEqual({
      kind: "purge_after",
      afterMs: DAY,
      ceiling: false,
    });
    expect(act({ hostedRelay: false, retention: "pinned" })).toEqual({ kind: "keep" });
  });

  it("flags the ceiling case so the caller can pick the unconditional alarm", () => {
    // `ceiling: true` is what selects the `relay_ttl` alarm purpose. The
    // ordinary "retention" purpose exempts pinned sessions from the purge, so
    // reusing it here would set an alarm that fires and then keeps the session.
    expect(act({ retention: "pinned" }).kind === "purge_after" && act({ retention: "pinned" })).
      toMatchObject({ ceiling: true });
    expect(act({ hostedRelay: false })).toMatchObject({ ceiling: false });
  });

  it("never returns keep for a hosted relay session", () => {
    for (const retention of ["ephemeral", "24h", "pinned"] as const) {
      expect(relayRetentionAction({ retention, hostedRelay: true, retain24hMs: DAY }).kind).not.toBe(
        "keep",
      );
    }
  });
});

// The one-way valve behind mid-session retention updates: a session tag
// applied mid-call ("tag it media") may shorten the server copy's life, and
// nothing — a tag removal, a stale reconnect hello — may lengthen it back.
describe("narrowestRetention", () => {
  it("keeps the tier that keeps less", () => {
    expect(narrowestRetention("pinned", "ephemeral")).toBe("ephemeral");
    expect(narrowestRetention("ephemeral", "pinned")).toBe("ephemeral");
    expect(narrowestRetention("pinned", "24h")).toBe("24h");
    expect(narrowestRetention("24h", "pinned")).toBe("24h");
    expect(narrowestRetention("24h", "ephemeral")).toBe("ephemeral");
  });

  it("is a no-op on equal tiers — the guard SessionDO uses to skip the write", () => {
    for (const tier of ["ephemeral", "24h", "pinned"] as const) {
      expect(narrowestRetention(tier, tier)).toBe(tier);
    }
  });

  it("cannot widen: a session narrowed to ephemeral stays ephemeral against every later claim", () => {
    for (const tier of ["ephemeral", "24h", "pinned"] as const) {
      expect(narrowestRetention("ephemeral", tier)).toBe("ephemeral");
    }
  });

  it("ignores a malformed wire tier instead of storing it", () => {
    // The wire type is a TypeScript fiction — a frame can carry any value.
    // An unknown tier persisted into meta would read as "neither ephemeral
    // nor 24h" in every purge path and fall through to keep-forever.
    for (const junk of ["forever", "", "PINNED", 42, null, undefined, { tier: "24h" }]) {
      expect(narrowestRetention("24h", junk)).toBe("24h");
      expect(narrowestRetention("ephemeral", junk)).toBe("ephemeral");
    }
  });

  it("fails a corrupt STORED tier to ephemeral, not to the update's claim", () => {
    // meta written before the validation existed could hold garbage. Keep
    // nothing when the copy's provenance is unknown — a valid update must not
    // launder a corrupt tier up to its own.
    expect(narrowestRetention("forever", "pinned")).toBe("ephemeral");
    expect(narrowestRetention(undefined, "24h")).toBe("ephemeral");
    expect(narrowestRetention(null, null)).toBe("ephemeral");
  });
});

// The frame-level gate in front of narrowestRetention, shared by the
// `session.retention` handler and reconnect hellos. Retention is a deletion
// control, so a frame that doesn't name THIS session must change nothing.
describe("retentionAfterFrame", () => {
  const meta = { session_id: "sess-a", retention: "pinned" } as const;

  it("narrows when the frame names this session", () => {
    expect(retentionAfterFrame(meta, { session_id: "sess-a", retention: "ephemeral" })).toBe(
      "ephemeral",
    );
  });

  it("ignores a frame naming a different session, even a narrowing one", () => {
    expect(retentionAfterFrame(meta, { session_id: "sess-b", retention: "ephemeral" })).toBeNull();
  });

  it("returns null on a no-op or widening claim — the callers' skip-the-write guard", () => {
    expect(retentionAfterFrame(meta, { session_id: "sess-a", retention: "pinned" })).toBeNull();
    expect(
      retentionAfterFrame(
        { session_id: "sess-a", retention: "ephemeral" },
        { session_id: "sess-a", retention: "pinned" },
      ),
    ).toBeNull();
  });

  it("still fails a corrupt stored tier to ephemeral, but only for this session's frames", () => {
    const corrupt = { session_id: "sess-a", retention: "forever" as never };
    expect(retentionAfterFrame(corrupt, { session_id: "sess-a", retention: "pinned" })).toBe(
      "ephemeral",
    );
    expect(retentionAfterFrame(corrupt, { session_id: "sess-b", retention: "pinned" })).toBeNull();
  });
});

describe("isEntitled vs pro-relay", () => {
  it("default-allows a relay-shaped user (no sub, no promo) — proving the session gate is load-bearing", () => {
    // If this ever starts returning false, the plan-keyed session gate is no
    // longer the only thing standing between a relay session and our LLM
    // spend — revisit sessionAnalysisAccess before "fixing" this test.
    expect(isEntitled({}, Date.now())).toBe(true);
  });
});

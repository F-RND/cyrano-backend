// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampConfidence,
  normalizeSeq,
  validAsks,
  validCommitments,
  validDecisions,
  validSubtext,
  validSuggestions,
} from "../src/analysis/validate.js";

// The audit found `tool_choice` forces a tool call but not a well-formed
// one — malformed model output used to flow `undefined` fields straight into
// hot state and onto the wire. These pin that a bad item is dropped, a good
// item is normalized, and the fixed "literal" fields are stamped server-side
// rather than trusted from the model.
describe("analysis output validation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps transcript-derived attribution text out of logs unless explicitly enabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const speakers = new Map<number, "USER">([[1, "USER"]]);

    validCommitments([{ text: "private transcript text", source_seq: 1 }], speakers);
    expect(log).not.toHaveBeenCalled();

    validCommitments([{ text: "test fixture text", source_seq: 1 }], speakers, undefined, true);
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]![0])).toContain("test fixture text");
  });

  it("drops items with no usable text but keeps the good ones", () => {
    const out = validCommitments([
      { text: "Send the deck Friday", source_seq: 3 },
      { text: "", source_seq: 4 },
      { source_seq: 5 },
      { text: "   ", source_seq: 6 },
      "not even an object",
      null,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("Send the deck Friday");
  });

  it("returns [] for a non-array (model returned an object or null)", () => {
    expect(validCommitments(undefined)).toEqual([]);
    expect(validAsks({ asks: "oops" })).toEqual([]);
    expect(validSubtext(null)).toEqual([]);
  });

  it("stamps the server-owned literal fields regardless of model output", () => {
    const [commitment] = validCommitments([{ text: "x", owner: "OTHER", answered: "yes" }]);
    expect(commitment!.owner).toBe("USER");

    const [ask] = validAsks([{ text: "y", requested_by: "USER", answered: true }]);
    expect(ask!.requested_by).toBe("OTHER");
    expect(ask!.answered).toBe(false);

    const [sub] = validSubtext([
      { text: "z", label: "hesitation", speculation: false, confidence: 0.9 },
    ]);
    expect(sub!.speculation).toBe(true);

    const [sug] = validSuggestions([{ text: "w", dismissible: false }]);
    expect(sug!.dismissible).toBe(true);
  });

  it("attributes commitment owner by the source line's speaker when a map is supplied", () => {
    const speakerBySeq = new Map<number, "USER" | "OTHER" | "SYSTEM" | "UNKNOWN">([
      [1, "USER"],
      [2, "OTHER"],
      [3, "SYSTEM"],
      [4, "UNKNOWN"],
    ]);
    const out = validCommitments(
      [
        { text: "I'll send the deck", source_seq: 1 },
        { text: "They'll sign by Friday", source_seq: 2 },
        { text: "Feed speaker will circulate notes", source_seq: 3 },
        { text: "Someone will follow up", source_seq: 4 },
        { text: "Unmapped line defaults to counterpart", source_seq: 9 },
      ],
      speakerBySeq,
    );
    expect(out.map((c) => c.owner)).toEqual(["USER", "OTHER", "SYSTEM", "OTHER", "OTHER"]);
  });

  it("keeps the legacy USER default when no speaker map is supplied", () => {
    // Pre-ownership callers pass no map; every commitment stays ours so nothing
    // silently reattributes.
    const [c] = validCommitments([{ text: "x", source_seq: 2 }]);
    expect(c!.owner).toBe("USER");
  });

  it("attaches owner_slot only to a SYSTEM commitment whose source line carried a slot", () => {
    const speakerBySeq = new Map<number, "USER" | "OTHER" | "SYSTEM" | "UNKNOWN">([
      [1, "SYSTEM"],
      [2, "SYSTEM"],
      [3, "USER"],
      [4, "SYSTEM"],
    ]);
    // Slots ride on the diarized feed lines; the USER line has one too (which
    // must be ignored), and seq 4 is a SYSTEM line with no slot at all.
    const slotBySeq = new Map<number, number>([
      [1, 2],
      [2, 5],
      [3, 9],
    ]);
    const out = validCommitments(
      [
        { text: "Speaker 2 will circulate notes", source_seq: 1 },
        { text: "Speaker 5 will dig into staging", source_seq: 2 },
        { text: "I'll send the deck", source_seq: 3 },
        { text: "Unslotted feed voice will follow up", source_seq: 4 },
      ],
      speakerBySeq,
      slotBySeq,
    );
    expect(out.map((c) => c.owner)).toEqual(["SYSTEM", "SYSTEM", "USER", "SYSTEM"]);
    expect(out.map((c) => c.owner_slot)).toEqual([2, 5, undefined, undefined]);
    // A USER-owned commitment never carries a slot even when its line had one,
    // and the key is truly absent (additive on the wire), not just undefined.
    expect("owner_slot" in out[2]!).toBe(false);
  });

  it("attaches requested_by_slot only to a SYSTEM ask whose source line carried a slot", () => {
    const speakerBySeq = new Map<number, "USER" | "OTHER" | "SYSTEM" | "UNKNOWN">([
      [1, "SYSTEM"],
      [2, "OTHER"],
    ]);
    const slotBySeq = new Map<number, number>([
      [1, 3],
      [2, 7],
    ]);
    const out = validAsks(
      [
        { text: "Can you confirm the date?", source_seq: 1 },
        { text: "Do you have a hard stop?", source_seq: 2 },
      ],
      speakerBySeq,
      slotBySeq,
    );
    expect(out.map((a) => a.requested_by)).toEqual(["SYSTEM", "OTHER"]);
    // Slot only on the SYSTEM ask; the in-room OTHER ask stays slot-less even
    // though seq 2 had a slot in the map.
    expect(out.map((a) => a.requested_by_slot)).toEqual([3, undefined]);
  });

  it("emits no slot fields when no slot map is supplied (old callers)", () => {
    const speakerBySeq = new Map<number, "USER" | "OTHER" | "SYSTEM" | "UNKNOWN">([[1, "SYSTEM"]]);
    const [c] = validCommitments([{ text: "Feed voice will follow up", source_seq: 1 }], speakerBySeq);
    expect(c!.owner).toBe("SYSTEM");
    expect("owner_slot" in c!).toBe(false);
    const [a] = validAsks([{ text: "Can you review?", source_seq: 1 }], speakerBySeq);
    expect(a!.requested_by).toBe("SYSTEM");
    expect("requested_by_slot" in a!).toBe(false);
  });

  it("rejects subtext with an out-of-enum label", () => {
    expect(validSubtext([{ text: "z", label: "made_up_label" }])).toEqual([]);
    expect(validSubtext([{ text: "z", label: "hesitation", confidence: 0.8 }])).toHaveLength(1);
  });

  it("attributes a decision's owner/owner_slot like a commitment and defaults status to decided", () => {
    const speakerBySeq = new Map<number, "USER" | "OTHER" | "SYSTEM" | "UNKNOWN">([
      [1, "SYSTEM"],
      [2, "USER"],
    ]);
    const slotBySeq = new Map<number, number>([[1, 5]]);
    const out = validDecisions(
      [
        { text: "Sully explores staging and reports back", status: "tentative", source_seq: 1 },
        { text: "Announce test launches in the bugs channel", source_seq: 2 },
      ],
      speakerBySeq,
      slotBySeq,
    );
    expect(out.map((d) => d.owner)).toEqual(["SYSTEM", "USER"]);
    expect(out[0]!.owner_slot).toBe(5);
    expect(out[0]!.status).toBe("tentative");
    // Missing status defaults to the firmer "decided"; a USER owner carries no slot.
    expect(out[1]!.status).toBe("decided");
    expect("owner_slot" in out[1]!).toBe(false);
  });

  it("drops a decision with an out-of-enum status but keeps a valid one", () => {
    expect(validDecisions([{ text: "x", status: "maybe" }])).toEqual([]);
    expect(validDecisions([{ text: "x", status: "decided" }])).toHaveLength(1);
  });

  it("floors hesitation confidence but leaves the other labels unfloored", () => {
    // 2026-07-22 QA feedback: filler-triggered hesitation swamped the useful
    // reads. A hesitation below 0.6 — including one with MISSING confidence
    // (defaulted to 0.5) — drops; the rare labels survive even when tentative.
    expect(validSubtext([{ text: "z", label: "hesitation", confidence: 0.55 }])).toEqual([]);
    expect(validSubtext([{ text: "z", label: "hesitation" }])).toEqual([]);
    expect(validSubtext([{ text: "z", label: "hesitation", confidence: 0.6 }])).toHaveLength(1);
    expect(
      validSubtext([{ text: "z", label: "swallowed_disagreement", confidence: 0.2 }]),
    ).toHaveLength(1);
    expect(
      validSubtext([{ text: "z", label: "enthusiasm_mismatch" }]),
    ).toHaveLength(1);
  });

  it("normalizes missing/garbage confidence and source_seq", () => {
    const [c] = validCommitments([{ text: "x" }]);
    expect(c!.confidence).toBe(0.5);
    expect(c!.source_seq).toBe(0);
    expect(c!.inferred_deadline).toBeNull();
  });

  it("clamps confidence into [0,1] and coerces NaN", () => {
    expect(clampConfidence(1.7)).toBe(1);
    expect(clampConfidence(-0.3)).toBe(0);
    expect(clampConfidence(0.42)).toBe(0.42);
    expect(clampConfidence(NaN)).toBe(0.5);
    expect(clampConfidence(undefined)).toBe(0.5);
  });

  it("rejects negative/non-integer source_seq down to 0", () => {
    expect(normalizeSeq(-1)).toBe(0);
    expect(normalizeSeq(2.5)).toBe(0);
    expect(normalizeSeq(7)).toBe(7);
    expect(normalizeSeq(undefined)).toBe(0);
  });
});

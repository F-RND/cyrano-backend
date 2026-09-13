// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_SEGMENTS,
  parseAgentContextQuery,
  projectSegment,
  rejectAtExtraction,
  scopeToFocus,
  selectTranscript,
  speakerLabel,
  triageAsks,
} from "../src/agent-context.js";
import { agentSourceLabel, sanitizeAgentNote } from "../src/session-do.js";
import { chatGPTMCPTesting } from "../src/chatgpt-mcp.js";
import type { AskExtraction, TranscriptSegment } from "../src/types.js";

function segment(seq: number, text: string, over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    session_id: "s",
    seq,
    t_start: seq * 1000,
    t_end: seq * 1000 + 900,
    speaker: "OTHER",
    confidence: 1,
    text,
    final: true,
    ...over,
  };
}

const SESSION = [
  ...Array.from({ length: 140 }, (_, i) => segment(i + 1, `filler line ${i + 1}`)),
  segment(141, "What model are we going to run this on?", { speaker: "SYSTEM", speaker_slot: 2 }),
  ...Array.from({ length: 100 }, (_, i) => segment(i + 142, `more filler ${i + 142}`)),
  segment(242, "They could stop giving us model access entirely.", { speaker: "SYSTEM", speaker_slot: 3 }),
  ...Array.from({ length: 86 }, (_, i) => segment(i + 243, `gpu talk ${i + 243}`)),
];

describe("agent transcript windowing", () => {
  it("defaults to the same 40-segment tail the endpoint always returned", () => {
    const selection = selectTranscript(SESSION, parseAgentContextQuery(new URLSearchParams()));
    expect(selection.segments).toHaveLength(40);
    expect(selection.range.to).toBe(328);
    expect(selection.range.latest_seq).toBe(328);
    expect(selection.range.total_stored).toBe(328);
    // The whole complaint in one assertion: a consumer must be able to SEE
    // that the window isn't the conversation.
    expect(selection.range.has_more_before).toBe(true);
    expect(selection.range.has_more_after).toBe(false);
  });

  it("resolves a single cited seq into the lines around it", () => {
    const query = parseAgentContextQuery(new URLSearchParams({ around_seq: "141", span: "2" }));
    const selection = selectTranscript(SESSION, query);
    expect(selection.segments.map((s) => s.seq)).toEqual([139, 140, 141, 142, 143]);
    expect(selection.segments[2]!.text).toContain("What model");
    expect(selection.spans).toHaveLength(0);
  });

  it("resolves several cited seqs at once as spans, newest window intact", () => {
    const query = parseAgentContextQuery(new URLSearchParams({ around_seq: "141,242", span: "1" }));
    const selection = selectTranscript(SESSION, query);
    expect(selection.spans.map((s) => [s.from, s.to])).toEqual([[140, 142], [241, 243]]);
    // The tail still rides along, because a live session's newest ground is
    // what a poller cannot do without.
    expect(selection.segments).toHaveLength(40);
  });

  it("finds topic ground anywhere in the session, not just the tail", () => {
    const query = parseAgentContextQuery(new URLSearchParams({ search: "model access, what model", span: "1" }));
    const selection = selectTranscript(SESSION, query);
    const seqs = selection.spans.flatMap((s) => s.matched_seqs);
    expect(seqs).toContain(141);
    expect(seqs).toContain(242);
    expect(selection.spans.some((s) => s.matched.includes("what model"))).toBe(true);
  });

  it("paginates backwards with since_seq/until_seq and reports what is left", () => {
    const query = parseAgentContextQuery(new URLSearchParams({ since_seq: "100", until_seq: "150" }));
    const selection = selectTranscript(SESSION, query);
    expect(selection.range.from).toBe(111); // 40-segment limit clips the front
    expect(selection.range.to).toBe(150);
    expect(selection.range.truncated).toBe(true);
    expect(selection.range.has_more_after).toBe(true);
  });

  it("keeps a named seq when keyword hits compete for the last span slot", () => {
    // The failure this guards: a workflow searches its focus AND names the
    // seqs the extracted state cited, recent keyword hits fill every span
    // slot, and the payload comes back holding everything except the evidence
    // it went to fetch.
    const query = parseAgentContextQuery(
      new URLSearchParams({ search: "gpu talk", around_seq: "141", span: "1" }),
    );
    const selection = selectTranscript(SESSION, query);
    expect(selection.spans.some((s) => s.from <= 141 && s.to >= 141)).toBe(true);
    expect(selection.spans.length).toBeLessThanOrEqual(8);
  });

  it("never exceeds the per-response segment ceiling", () => {
    const query = parseAgentContextQuery(
      new URLSearchParams({ limit: "300", search: "filler", span: "100" }),
    );
    const selection = selectTranscript(SESSION, query);
    const total = selection.segments.length + selection.spans.reduce((n, s) => n + s.segments.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_AGENT_SEGMENTS);
    expect(selection.range.truncated).toBe(true);
  });

  it("clamps limit and span rather than trusting the caller", () => {
    const query = parseAgentContextQuery(
      new URLSearchParams({ limit: "9999", span: "9999", since_seq: "-4" }),
    );
    expect(query.limit).toBe(MAX_AGENT_SEGMENTS);
    expect(query.span).toBe(100);
    expect(query.sinceSeq).toBeNull();
  });
});

describe("speaker attribution", () => {
  it("never calls a person SYSTEM", () => {
    expect(speakerLabel({ speaker: "SYSTEM", speaker_slot: 2 })).toBe("Speaker 2 (on the call)");
    expect(speakerLabel({ speaker: "SYSTEM" })).toBe("Someone on the call");
    expect(speakerLabel({ speaker: "USER" })).toBe("You");
    expect(speakerLabel({ speaker: "OTHER" })).toBe("Other person (in the room)");
    expect(speakerLabel({ speaker: "UNKNOWN" })).toBe("Unattributed");
  });

  it("renames diarization confidence so it can't be read as ASR certainty", () => {
    const line = projectSegment(segment(1, "for you to have a stock of syrup", { confidence: 1 }));
    expect(line.diarization_confidence).toBe(1);
    expect(line).not.toHaveProperty("confidence");
    expect(line.final).toBe(true);
  });
});

describe("open-ask triage", () => {
  const ask = (text: string, confidence = 0.8, source_seq = 1): AskExtraction => ({
    text,
    requested_by: "OTHER",
    answered: false,
    confidence,
    source_seq,
  });

  it("separates real asks from the debris that shared the list with them", () => {
    const { actionable, filtered } = triageAsks([
      ask("Can you send the budget numbers before Friday?", 0.9, 10),
      ask("What the fuck?", 0.9, 11),
      ask("Right?", 0.9, 12),
      ask("Are you doing?", 0.9, 13),
      ask("Would there be value in running it locally?", 0.8, 14),
      ask("Would there be value in running this locally?", 0.8, 20),
      ask("maybe something about the thing", 0.2, 15),
      ask(`So ${"orchestrating teammates ".repeat(25)}`, 0.9, 16),
    ]);

    expect(actionable.map((a) => a.source_seq)).toEqual([10, 14]);
    const reasons = Object.fromEntries(filtered.map((f) => [f.ask.source_seq, f.reason]));
    expect(reasons[11]).toBe("rhetorical");
    expect(reasons[12]).toBe("rhetorical");
    expect(reasons[13]).toBe("rhetorical");
    expect(reasons[20]).toBe("duplicate");
    expect(reasons[15]).toBe("low_confidence");
    expect(reasons[16]).toBe("not_a_request");
  });

  it("keeps a question that merely contains a filler word", () => {
    const { actionable } = triageAsks([ask("Is the migration plan right?")]);
    expect(actionable).toHaveLength(1);
  });

  it("drops only content-free fragments at extraction time", () => {
    // The extraction-time filter is narrower on purpose: a weak or duplicated
    // ask still reaches the app, where the user can judge it.
    expect(rejectAtExtraction(ask("What the fuck?"))).toBe(true);
    expect(rejectAtExtraction(ask("Right?"))).toBe(true);
    expect(rejectAtExtraction(ask("maybe something", 0.1))).toBe(false);
    expect(rejectAtExtraction(ask("Can you send the numbers?"))).toBe(false);
  });
});

describe("topic scoping", () => {
  it("returns nothing rather than something unrelated", () => {
    const items = [
      { text: "She was going to do it on production, we'll point her at beta", source_seq: 75 },
      { text: "We need more tokens to move faster on the model side", source_seq: 160 },
    ];
    expect(scopeToFocus(items, "model availability and tokens").map((i) => i.source_seq)).toEqual([160]);
    expect(scopeToFocus(items, "quarterly hiring plan")).toEqual([]);
    expect(scopeToFocus(items, null)).toHaveLength(2);
  });
});

describe("agent-filed notes", () => {
  it("clamps and tags a note instead of refusing a remote round trip", () => {
    const note = sanitizeAgentNote(
      { text: `  ${"x".repeat(600)}  `, kind: "reminder", owner: "  Mario  ", due_at: "2026-08-01" },
      "ChatGPT",
      328,
    );
    expect(note).not.toBeNull();
    expect(note!.text).toHaveLength(500);
    expect(note!.kind).toBe("reminder");
    expect(note!.owner).toBe("Mario");
    expect(note!.due_at).toBe("2026-08-01");
    expect(note!.source).toBe("ChatGPT");
    expect(note!.anchor_seq).toBe(328);
  });

  it("refuses an empty note and falls back to a plain kind", () => {
    expect(sanitizeAgentNote({ text: "   " }, "Claude", 1)).toBeNull();
    expect(sanitizeAgentNote({ text: "note", kind: "nonsense" as never }, "Claude", 1)!.kind).toBe("note");
  });

  it("takes the filing client's name from the connection, sanitized", () => {
    const request = (value: string) =>
      new Request("https://session/results", { headers: { "x-cyrano-agent-source": value } });
    expect(agentSourceLabel(request("ChatGPT"))).toBe("ChatGPT");
    expect(agentSourceLabel(request("<script>x</script>"))).toBe("scriptxscript");
    expect(agentSourceLabel(new Request("https://session/results"))).toBe("Connected assistant");
  });
});

describe("MCP retrieval arguments", () => {
  it("passes through only the retrieval arguments it recognises", () => {
    const params = chatGPTMCPTesting.contextQueryFromArgs({
      search: " model access ",
      around_seq: 149,
      limit: 80,
      nonsense: "drop me",
      since_seq: -3,
    });
    expect(params.get("search")).toBe("model access");
    expect(params.get("around_seq")).toBe("149");
    expect(params.get("limit")).toBe("80");
    expect(params.get("since_seq")).toBeNull();
    expect(params.get("nonsense")).toBeNull();
    expect([...chatGPTMCPTesting.contextQueryFromArgs({})]).toEqual([]);
  });

  it("collects the seqs the extracted state cites, newest first, in reading order", () => {
    const seqs = chatGPTMCPTesting.citedSeqs({
      open_asks_actionable: [{ source_seq: 149 }, { source_seq: 246 }],
      hot_state: {
        recent_commitments: [{ source_seq: 160 }],
        decisions: [{ source_seq: 179 }],
        last_commitment: { source_seq: 75 },
        latest_suggestion: { source_seq: 300 },
        open_asks: [{ source_seq: 149 }],
      },
    }, 4);
    // 300, 246, 179, 160 are the four newest of the six cited; 149 and 75 fall
    // outside the budget, and the survivors read forwards.
    expect(seqs).toEqual([160, 179, 246, 300]);
  });

  it("names what relates to the focus, and says plainly when nothing does", () => {
    const scoped = chatGPTMCPTesting.focusRelevantState({
      open_asks_actionable: [{ text: "Can we get more tokens to move faster?", source_seq: 160 }],
      hot_state: {
        recent_commitments: [
          { text: "She was going to do it on production, we'll point at beta", source_seq: 75 },
        ],
        decisions: [],
      },
    }, "model availability and tokens");

    expect(scoped).toContain("more tokens");
    expect(scoped).toContain("seq 160");
    // The 0.4-confidence production/beta commitment is about something else —
    // returning it under this focus is what made the original answer wrong.
    expect(scoped).not.toContain("point at beta");
    expect(scoped).toContain("Commitments: none in this session relate to");
    expect(scoped).toContain("Decisions: none in this session relate to");
  });

  it("survives a context payload with no extracted state at all", () => {
    expect(chatGPTMCPTesting.citedSeqs({})).toEqual([]);
    expect(chatGPTMCPTesting.citedSeqs({ hot_state: null })).toEqual([]);
  });
});

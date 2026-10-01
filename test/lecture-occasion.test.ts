// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// The session occasion: a session is a conversation (every session before this
// existed) or a lecture, with the user either listening or teaching. A lecture
// swaps the combined pass's system prompt and never extracts subtext; nothing
// else about the pass moves. Pinned here:
//
//  - the wire value is sanitized everywhere it arrives (hello,
//    session.occasion, POST /analyze) and anything unknown reads as
//    "conversation"; session.occasion is routed like session.retention;
//  - the conversation pass is byte-for-byte the request it was before
//    occasions existed — the same analysis.json object handed to callTool, the
//    same body on the wire — whether the occasion is omitted, explicit, or junk;
//  - both lecture roles send their own prompt with analysis.json's name and
//    schemas unchanged, and come back with subtext empty;
//  - the occasion rides meta into the live tick AND the price-test shadow call.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pass-through spy: every call still reaches the real client (and the stubbed
// fetch below), but the tool object it was handed can be checked for identity.
vi.mock("../src/llm/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/client.js")>();
  return { ...actual, callTool: vi.fn(actual.callTool) };
});

import analysisTool from "../schemas/analysis.json";
import lecturePrompts from "../src/analysis/lecture-prompts.json";
import { callTool } from "../src/llm/client.js";
import { combinedAnalysisTool, runCombinedAnalysis } from "../src/analysis/passes.js";
import { reanalyzeTranscript } from "../src/analysis/reanalyze.js";
import { occasionAfterFrame, SessionDO } from "../src/session-do.js";
import worker from "../src/index.js";
import { sanitizeOccasion, SESSION_OCCASIONS, type SessionOccasionWire, type TranscriptSegment } from "../src/types.js";
import type { Env } from "../src/env.js";

const T0 = Date.parse("2026-09-26T10:00:00.000Z");
const config = { baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-test", model: "claude-sonnet-5" };
const LECTURES = [
  ["lecture.listening", lecturePrompts.listening],
  ["lecture.teaching", lecturePrompts.teaching],
] as const;

const window: TranscriptSegment[] = [
  { session_id: "s", seq: 1, t_start: 0, t_end: 1, speaker: "OTHER", confidence: 1, text: "Finish the Okafor problem set by Friday", final: true },
  { session_id: "s", seq: 2, t_start: 1, t_end: 2, speaker: "OTHER", confidence: 1, text: "The midterm moves to the ninth", final: true },
];

/** A model reply carrying one valid item of every kind, subtext included, so
 * an empty subtext in the result can only have come from the lecture rule. */
const FULL_REPLY = {
  commitments: [{ text: "Finish the Okafor problem set", owner: "OTHER", inferred_deadline: null, confidence: 0.9, source_seq: 1 }],
  asks: [],
  subtext: [{ text: "OTHER may be swallowing disagreement about the date", label: "swallowed_disagreement", confidence: 0.7, source_seq: 2 }],
  suggestions: [{ text: "Rework the Okafor example", outcome: "ready for the midterm", dismissible: true, source_seq: 1 }],
  decisions: [{ text: "Midterm moves to the ninth", status: "decided", source_seq: 2 }],
};

function toolReply(input: unknown): Response {
  return new Response(
    JSON.stringify({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "extract_analysis", input }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Every Messages request body the stubbed fetch saw, as the exact string sent. */
function sentBodies(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].body as string);
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  vi.mocked(callTool).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sanitizeOccasion", () => {
  it("passes the three wire values through", () => {
    for (const occasion of SESSION_OCCASIONS) expect(sanitizeOccasion(occasion)).toBe(occasion);
    expect([...SESSION_OCCASIONS]).toEqual(["conversation", "lecture.listening", "lecture.teaching"]);
  });

  it("reads anything else as a conversation", () => {
    for (const junk of [undefined, null, "", "lecture", "seminar", "LECTURE.LISTENING", " lecture.teaching", 42, true, {}, ["lecture.listening"]]) {
      expect(sanitizeOccasion(junk)).toBe("conversation");
    }
  });
});

// The pure rule behind a `session.occasion` frame, pinned the way relay.test.ts
// pins retentionAfterFrame.
describe("occasionAfterFrame", () => {
  const meta = { session_id: "sess-a", occasion: "conversation" as const };

  it("returns the sanitized occasion for a frame naming this session", () => {
    expect(occasionAfterFrame(meta, { session_id: "sess-a", occasion: "lecture.teaching" })).toBe("lecture.teaching");
    expect(
      occasionAfterFrame({ ...meta, occasion: "lecture.teaching" }, { session_id: "sess-a", occasion: "lecture.listening" }),
    ).toBe("lecture.listening");
  });

  it("ignores a frame naming a different session", () => {
    expect(occasionAfterFrame(meta, { session_id: "sess-b", occasion: "lecture.teaching" })).toBeNull();
  });

  it("switches back to a conversation on request or on an unknown name — it is not a one-way valve", () => {
    const lecture = { session_id: "sess-a", occasion: "lecture.listening" as const };
    expect(occasionAfterFrame(lecture, { session_id: "sess-a", occasion: "conversation" })).toBe("conversation");
    expect(occasionAfterFrame(lecture, { session_id: "sess-a", occasion: "lecture.napping" })).toBe("conversation");
  });

  it("ignores a frame with no string occasion, so a malformed one can't downgrade a live lecture", () => {
    const lecture = { session_id: "sess-a", occasion: "lecture.teaching" as const };
    for (const occasion of [undefined, null, 42, true, {}, ["lecture.teaching"]]) {
      expect(occasionAfterFrame(lecture, { session_id: "sess-a", occasion })).toBeNull();
    }
  });

  it("has nothing to write when the occasion doesn't change, including on a meta stored before occasions", () => {
    expect(occasionAfterFrame(meta, { session_id: "sess-a", occasion: "conversation" })).toBeNull();
    expect(occasionAfterFrame({ session_id: "sess-a" }, { session_id: "sess-a", occasion: "seminar" })).toBeNull();
    expect(occasionAfterFrame({ session_id: "sess-a" }, { session_id: "sess-a", occasion: "lecture.listening" })).toBe(
      "lecture.listening",
    );
  });
});

describe("lecture-prompts.json", () => {
  it("holds exactly the two roles, each telling the model subtext is always empty", () => {
    expect(Object.keys(lecturePrompts).sort()).toEqual(["listening", "teaching"]);
    for (const prompt of [lecturePrompts.listening, lecturePrompts.teaching]) {
      expect(prompt).toContain("SUBTEXT: always an empty array in a lecture.");
      // The Swift literal's shape: paragraphs, no indentation, no trailing newline.
      expect(prompt).not.toMatch(/\n$/);
      expect(prompt).not.toMatch(/^ /m);
    }
    expect(lecturePrompts.listening).not.toBe(lecturePrompts.teaching);
  });
});

describe("combinedAnalysisTool", () => {
  it("is analysis.json itself — the same object — for a conversation", () => {
    expect(combinedAnalysisTool("conversation")).toBe(analysisTool);
    expect(combinedAnalysisTool("seminar" as SessionOccasionWire)).toBe(analysisTool);
  });

  it.each(LECTURES)("%s swaps the system prompt and nothing else", (occasion, prompt) => {
    const tool = combinedAnalysisTool(occasion);
    const { system_prompt, ...rest } = tool;
    const { system_prompt: _conversationPrompt, ...analysisRest } = analysisTool;
    expect(system_prompt).toBe(prompt);
    expect(rest).toEqual(analysisRest);
    // All five categories stay required, so missing-category detection and
    // validation behave exactly as they do for a conversation.
    expect((tool.output_schema as { required: string[] }).required).toEqual([
      "commitments",
      "asks",
      "subtext",
      "suggestions",
      "decisions",
    ]);
    // The shared JSON was not mutated by building the variant.
    expect(analysisTool.system_prompt).not.toBe(prompt);
  });
});

describe("runCombinedAnalysis by occasion", () => {
  it("sends the pre-occasion request byte for byte when the occasion is omitted, explicit, or unknown", async () => {
    const fetchMock = vi.fn(async () => toolReply(FULL_REPLY));
    vi.stubGlobal("fetch", fetchMock);

    const omitted = await runCombinedAnalysis(config, window, ["Known task"], ["Known ask?"]);
    const explicit = await runCombinedAnalysis(config, window, ["Known task"], ["Known ask?"], [], "conversation");
    const unknown = await runCombinedAnalysis(config, window, ["Known task"], ["Known ask?"], [], "seminar" as SessionOccasionWire);

    // callTool was handed the imported analysis.json object every time.
    const tools = vi.mocked(callTool).mock.calls.map((call) => call[1]);
    expect(tools).toHaveLength(3);
    for (const tool of tools) expect(tool).toBe(analysisTool);

    // The wire body, rebuilt independently from analysis.json the way the
    // client composed it before occasions existed.
    const expected = JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: [{ type: "text", text: analysisTool.system_prompt, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            now: new Date(T0).toISOString(),
            known_commitments: ["Known task"],
            known_open_asks: ["Known ask?"],
            transcript_window: window.map((s) => ({ seq: s.seq, speaker: s.speaker, text: s.text })),
          }),
        },
      ],
      tools: [{ name: analysisTool.name, description: analysisTool.description, input_schema: analysisTool.output_schema }],
      tool_choice: { type: "tool", name: "extract_analysis" },
    });
    expect(sentBodies(fetchMock)).toEqual([expected, expected, expected]);

    // Same outputs, subtext included.
    expect(explicit).toEqual(omitted);
    expect(unknown).toEqual(omitted);
    expect(omitted.result.subtext).toHaveLength(1);
    expect(omitted.failure).toBeUndefined();
  });

  it.each(LECTURES)("%s sends its own prompt with analysis.json's tool and input, and empties subtext", async (occasion, prompt) => {
    const fetchMock = vi.fn(async () => toolReply(FULL_REPLY));
    vi.stubGlobal("fetch", fetchMock);

    const conversation = await runCombinedAnalysis(config, window, [], []);
    const lecture = await runCombinedAnalysis(config, window, [], [], [], occasion);

    const [conversationBody, lectureBody] = sentBodies(fetchMock).map((b) => JSON.parse(b));
    expect(lectureBody.system[0].text).toBe(prompt);
    expect(lectureBody.system[0].cache_control).toEqual({ type: "ephemeral" });
    // Everything but the system prompt is the conversation request.
    expect({ ...lectureBody, system: null }).toEqual({ ...conversationBody, system: null });
    expect(vi.mocked(callTool).mock.calls[1]![1]).toBe(combinedAnalysisTool(occasion));

    expect(lecture.failure).toBeUndefined();
    expect(lecture.result.subtext).toEqual([]);
    // The other four kinds validate exactly as they would in a conversation.
    expect({ ...lecture.result, subtext: null }).toEqual({ ...conversation.result, subtext: null });
    expect(lecture.result.commitments).toHaveLength(1);
    expect(lecture.result.decisions).toHaveLength(1);
  });

  it("does not report a lecture's subtext as missing when the reply leaves it out", async () => {
    const { subtext: _dropped, ...noSubtext } = FULL_REPLY;
    vi.stubGlobal("fetch", vi.fn(async () => toolReply(noSubtext)));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const lecture = await runCombinedAnalysis(config, window, [], [], [], "lecture.listening");
    expect(lecture.missingCategories).toBeUndefined();
    expect(lecture.result.subtext).toEqual([]);

    // A conversation still flags it — the gap is real there.
    const conversation = await runCombinedAnalysis(config, window, [], []);
    expect(conversation.missingCategories).toEqual(["subtext"]);
  });
});

describe("reanalyzeTranscript by occasion", () => {
  it("runs every window as the requested occasion, and as a conversation by default", async () => {
    const fetchMock = vi.fn(async () => toolReply(FULL_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    const lines = window.map(({ seq, speaker, text }) => ({ seq, speaker, text }));

    const lecture = await reanalyzeTranscript(config, lines, "lecture.teaching");
    const conversation = await reanalyzeTranscript(config, lines);

    const systems = sentBodies(fetchMock).map((b) => JSON.parse(b).system[0].text);
    expect(systems).toEqual([lecturePrompts.teaching, analysisTool.system_prompt]);
    expect(lecture.result.subtext).toEqual([]);
    expect(conversation.result.subtext).toHaveLength(1);
  });
});

describe("POST /analyze occasion", () => {
  const env = {
    AUTH_TOKEN: "t",
    LLM_API_KEY: "sk-OURS",
    LLM_BASE_URL: "https://api.anthropic.com/v1",
    LLM_MODEL: "claude-haiku-4-5",
  } as unknown as Env;

  async function analyze(extra: Record<string, unknown>): Promise<{ status: number; json: any; system: string }> {
    const fetchMock = vi.fn(async () => toolReply(FULL_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    const res = await worker.fetch(
      new Request("https://worker.example/analyze", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({
          transcript: window.map(({ seq, speaker, text }) => ({ seq, speaker, text })),
          ...extra,
        }),
      }),
      env,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    return { status: res.status, json: await res.json(), system: JSON.parse(sentBodies(fetchMock)[0]!).system[0].text };
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it.each(LECTURES)("threads %s from the body into the pass", async (occasion, prompt) => {
    const { status, json, system } = await analyze({ occasion });
    expect(status).toBe(200);
    expect(system).toBe(prompt);
    expect(json.subtext).toEqual([]);
    expect(json.commitments).toHaveLength(1);
  });

  it("runs the conversation pass when the field is absent or unrecognised", async () => {
    for (const extra of [{}, { occasion: "conversation" }, { occasion: "seminar" }, { occasion: 7 }]) {
      const { status, json, system } = await analyze(extra);
      expect(status).toBe(200);
      expect(system).toBe(analysisTool.system_prompt);
      expect(json.subtext).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// SessionDO: the occasion on meta, and the tick that reads it. Same shape of
// harness as session-cost-do.test.ts — a real SessionDO on fake storage and a
// fake socket, with the provider stubbed at fetch.
// ---------------------------------------------------------------------------

class FakeStorage {
  readonly map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.map.clear();
  }
  async list<T>(opts: { prefix?: string; start?: string; limit?: number; reverse?: boolean } = {}): Promise<Map<string, T>> {
    const keys = [...this.map.keys()]
      .filter((k) => !opts.prefix || k.startsWith(opts.prefix))
      .filter((k) => opts.start === undefined || k >= opts.start)
      .sort();
    if (opts.reverse) keys.reverse();
    const out = new Map<string, T>();
    for (const key of keys) {
      out.set(key, this.map.get(key) as T);
      if (opts.limit !== undefined && out.size >= opts.limit) break;
    }
    return out;
  }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
  async transaction<T>(fn: (txn: FakeStorage) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class FakeSocket {
  attachment: unknown = null;
  readonly sent: Array<{ type: string; [k: string]: unknown }> = [];
  serializeAttachment(v: unknown): void {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
}

const SESSION_ID = "sess_occasion_1";

function makeSession(envOver: Record<string, string> = {}) {
  const storage = new FakeStorage();
  const sockets: FakeSocket[] = [];
  const ctx = {
    storage,
    acceptWebSocket: (ws: FakeSocket) => sockets.push(ws),
    getWebSockets: () => sockets,
  } as unknown as DurableObjectState;
  const registry = { fetch: async () => Response.json({ ok: true }) };
  const env = {
    LLM_API_KEY: "sk-OURS",
    LLM_BASE_URL: "https://api.anthropic.com/v1",
    LLM_MODEL: "claude-haiku-4-5",
    AUTH_TOKEN: "op",
    REGISTRY_DO: { get: () => registry, idFromName: (n: string) => n },
    ...envOver,
  } as unknown as Env;
  const session = new SessionDO(ctx, env);

  /** Connect as the operator (what fetch's upgrade branch does after its
   * ownership gate) and send a hello with the given extra fields. */
  async function hello(extra: Record<string, unknown> = {}): Promise<FakeSocket> {
    const ws = new FakeSocket();
    ws.serializeAttachment({ identity: { kind: "operator" } });
    sockets.push(ws);
    await session.webSocketMessage(
      ws as unknown as WebSocket,
      JSON.stringify({ type: "hello", session_id: SESSION_ID, retention: "24h", input_route: "built_in_mic", ...extra }),
    );
    expect(ws.sent[0]).toMatchObject({ type: "hello.ack" });
    return ws;
  }
  async function frame(ws: FakeSocket, message: Record<string, unknown>): Promise<void> {
    await session.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(message));
  }
  async function occasion(): Promise<unknown> {
    return (await storage.get<{ occasion?: unknown }>("meta"))?.occasion;
  }
  /** Four final segments with enough words to clear the gate: one tick. */
  async function speakOneTick(ws: FakeSocket): Promise<void> {
    const lines = [
      "please finish the okafor problem set by friday",
      "the midterm moves to the ninth in the usual room",
      "make sure you know the proof for the exam",
      "I will post the slides tonight after class",
    ];
    for (const [i, text] of lines.entries()) {
      if (i === 3) vi.setSystemTime(Date.now() + 45_000);
      await frame(ws, {
        type: "transcript",
        segment: { session_id: SESSION_ID, seq: i + 1, t_start: i * 1000, t_end: i * 1000 + 900, speaker: "OTHER", confidence: 1, text, final: true },
      });
    }
  }
  return { session, storage, hello, frame, occasion, speakOneTick };
}

describe("SessionDO occasion", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("stores the hello's occasion on a new session", async () => {
    const s = makeSession();
    await s.hello({ occasion: "lecture.listening" });
    expect(await s.occasion()).toBe("lecture.listening");
  });

  it("stores conversation for a new session whose hello omits the field or carries junk", async () => {
    const omitted = makeSession();
    await omitted.hello();
    expect(await omitted.occasion()).toBe("conversation");

    for (const junk of ["seminar", "", 3, null, { role: "teaching" }]) {
      const s = makeSession();
      await s.hello({ occasion: junk });
      expect(await s.occasion()).toBe("conversation");
    }
  });

  it("a reconnect hello changes the occasion only when it carries the field", async () => {
    const s = makeSession();
    await s.hello({ occasion: "lecture.teaching" });

    // An older client's reconnect hello says nothing about the occasion.
    await s.hello();
    expect(await s.occasion()).toBe("lecture.teaching");

    await s.hello({ occasion: "lecture.listening" });
    expect(await s.occasion()).toBe("lecture.listening");

    // Present but unrecognised is still present: it sanitizes to conversation.
    await s.hello({ occasion: "lecture.napping" });
    expect(await s.occasion()).toBe("conversation");
  });

  it("session.occasion switches the live session, sanitized, with no reply frame", async () => {
    const s = makeSession();
    const ws = await s.hello();
    expect(await s.occasion()).toBe("conversation");

    await s.frame(ws, { type: "session.occasion", session_id: SESSION_ID, occasion: "lecture.teaching" });
    expect(await s.occasion()).toBe("lecture.teaching");

    await s.frame(ws, { type: "session.occasion", session_id: SESSION_ID, occasion: "office.hours" });
    expect(await s.occasion()).toBe("conversation");

    expect(ws.sent.map((m) => m.type)).toEqual(["hello.ack"]);
  });

  it("session.occasion naming another session changes nothing", async () => {
    const s = makeSession();
    const ws = await s.hello({ occasion: "lecture.listening" });
    await s.frame(ws, { type: "session.occasion", session_id: "sess_someone_else", occasion: "lecture.teaching" });
    await s.frame(ws, { type: "session.occasion", occasion: "lecture.teaching" });
    expect(await s.occasion()).toBe("lecture.listening");
    expect(ws.sent.map((m) => m.type)).toEqual(["hello.ack"]);
  });

  it("drops a frame type it doesn't know without an error — what lets a new client talk to an old server", async () => {
    // An old deployment sees session.occasion exactly as this one sees this frame.
    const s = makeSession();
    const ws = await s.hello({ occasion: "lecture.listening" });
    const before = structuredClone(await s.storage.get("meta"));
    await s.frame(ws, { type: "some.future_frame", occasion: "lecture.teaching" });
    expect(ws.sent.map((m) => m.type)).toEqual(["hello.ack"]);
    expect(await s.storage.get("meta")).toEqual(before);
  });

  it("the live tick runs the session's occasion, and a conversation session the untouched prompt", async () => {
    const fetchMock = vi.fn(async () => toolReply(FULL_REPLY));
    vi.stubGlobal("fetch", fetchMock);

    const lecture = makeSession();
    await lecture.speakOneTick(await lecture.hello({ occasion: "lecture.listening" }));
    const conversation = makeSession();
    await conversation.speakOneTick(await conversation.hello());

    const systems = sentBodies(fetchMock).map((b) => JSON.parse(b).system[0].text);
    expect(systems).toEqual([lecturePrompts.listening, analysisTool.system_prompt]);
    expect(vi.mocked(callTool).mock.calls[1]![1]).toBe(analysisTool);
  });

  it("a mid-session session.occasion reaches the next tick", async () => {
    const fetchMock = vi.fn(async () => toolReply(FULL_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    const s = makeSession();
    const ws = await s.hello();
    await s.frame(ws, { type: "session.occasion", session_id: SESSION_ID, occasion: "lecture.teaching" });
    await s.speakOneTick(ws);
    expect(JSON.parse(sentBodies(fetchMock)[0]!).system[0].text).toBe(lecturePrompts.teaching);
  });

  /** The agent context read, as the MCP server and agent keys make it. */
  async function agentContext(s: ReturnType<typeof makeSession>): Promise<{ text: string; body: Record<string, unknown> }> {
    const response = await s.session.fetch(new Request(`https://session/agent/sessions/${SESSION_ID}/context`));
    expect(response.status).toBe(200);
    const text = await response.text();
    return { text, body: JSON.parse(text) as Record<string, unknown> };
  }

  it("names a lecture and its role in the agent context, right after `ended`", async () => {
    for (const occasion of ["lecture.listening", "lecture.teaching"] as const) {
      const s = makeSession();
      await s.hello({ occasion });
      const { body } = await agentContext(s);
      expect(body.occasion).toBe(occasion);
      expect(Object.keys(body).slice(0, 5)).toEqual(["session_id", "retention", "ended", "occasion", "recent_segments"]);
    }

    // A mid-session switch reaches the next read, both ways.
    const s = makeSession();
    const ws = await s.hello();
    await s.frame(ws, { type: "session.occasion", session_id: SESSION_ID, occasion: "lecture.teaching" });
    expect((await agentContext(s)).body.occasion).toBe("lecture.teaching");
    await s.frame(ws, { type: "session.occasion", session_id: SESSION_ID, occasion: "conversation" });
    expect((await agentContext(s)).body).not.toHaveProperty("occasion");
  });

  it("leaves a conversation's agent context byte-for-byte as it was, old metas included", async () => {
    const conversation = makeSession();
    await conversation.hello();
    const { text, body } = await agentContext(conversation);
    expect(body).not.toHaveProperty("occasion");
    expect(Object.keys(body)).toEqual([
      "session_id",
      "retention",
      "ended",
      "recent_segments",
      "transcript_range",
      "transcript_notes",
      "hot_state",
      "hot_state_lag_seq",
      "open_asks_actionable",
      "open_asks_filtered",
      "session_notes",
      "agent_messages",
      "attachments",
    ]);

    // A lecture's payload is that same text with the one key added.
    const lecture = makeSession();
    await lecture.hello({ occasion: "lecture.listening" });
    const { occasion, ...rest } = (await agentContext(lecture)).body;
    expect(occasion).toBe("lecture.listening");
    expect(JSON.stringify(rest)).toBe(text);

    // A meta stored before occasions existed has no field at all.
    const old = makeSession();
    await old.hello();
    const meta = await old.storage.get<Record<string, unknown>>("meta");
    delete meta!.occasion;
    await old.storage.put("meta", meta);
    expect((await agentContext(old)).text).toBe(text);
  });

  it("the price-test shadow call prices the lecture prompt the session actually ran", async () => {
    const fetchMock = vi.fn(async () => toolReply(FULL_REPLY));
    vi.stubGlobal("fetch", fetchMock);
    const s = makeSession({
      PRICE_TEST_ENABLED: "true",
      PRICE_TEST_TARGETS: JSON.stringify([
        { label: "shadow", provider: "anthropic", baseUrl: "https://shadow.example/v1", model: "claude-haiku-4-5", keyEnv: "SHADOW_KEY" },
      ]),
      SHADOW_KEY: "sk-shadow",
    });
    await s.speakOneTick(await s.hello({ occasion: "lecture.teaching" }));

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      "https://api.anthropic.com/v1/messages",
      "https://shadow.example/v1/messages",
    ]);
    for (const body of sentBodies(fetchMock)) {
      expect(JSON.parse(body).system[0].text).toBe(lecturePrompts.teaching);
    }
  });
});

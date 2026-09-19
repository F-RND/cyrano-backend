// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// The per-session cost path THROUGH the Durable Objects: a real SessionDO on
// fake storage and a fake socket, a stubbed provider, and a real RegistryDO on
// the other end of the `_session_cost` post. Proves the wiring the pure tests
// cannot: that a hosted analysis tick's usage lands in `cost:session`, that a
// live `GET /cost` read includes it, that session end logs ONE `SESSION_COST`
// line, files the finished row, and hands it to the registry, and that
// `_session_costs` then lists it with the per-model rollup.
//
// The operator's own session is the case exercised on purpose: it has no
// owner, so it never reaches the per-user meter — it is exactly the session
// you run to try a candidate model, and before this work it left no cost
// record anywhere.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDO } from "../src/session-do.js";
import { RegistryDO } from "../src/registry-do.js";
import { forwardWithIdentity } from "../src/auth.js";
import type { Env } from "../src/env.js";
import type { SessionCostRow } from "../src/session-cost.js";

class FakeStorage {
  readonly map = new Map<string, unknown>();
  alarmAt: number | null = null;

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
  /** The subset of DurableObjectStorage.list the two DOs use: prefix, start
   * (inclusive), startAfter, end (exclusive), reverse, limit. `start` matters —
   * segmentsSince() pages the transcript with it, and a fake that ignored it
   * re-analyzed the whole transcript on the end flush. */
  async list<T>(
    opts: { prefix?: string; start?: string; startAfter?: string; end?: string; limit?: number; reverse?: boolean } = {},
  ): Promise<Map<string, T>> {
    const keys = [...this.map.keys()]
      .filter((k) => !opts.prefix || k.startsWith(opts.prefix))
      .filter((k) => opts.start === undefined || k >= opts.start)
      .filter((k) => opts.startAfter === undefined || k > opts.startAfter)
      .filter((k) => opts.end === undefined || k < opts.end)
      .sort();
    if (opts.reverse) keys.reverse();
    const out = new Map<string, T>();
    for (const key of keys) {
      out.set(key, this.map.get(key) as T);
      if (opts.limit !== undefined && out.size >= opts.limit) break;
    }
    return out;
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
  async transaction<T>(fn: (txn: FakeStorage) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class FakeSocket {
  attachment: unknown = null;
  readonly sent: unknown[] = [];
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

/** Enough of an Anthropic Messages reply to satisfy the combined pass. */
function analysisReply(usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }): Response {
  return new Response(
    JSON.stringify({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          name: "extract_analysis",
          input: { commitments: [], asks: [], subtext: [], suggestions: [], decisions: [] },
        },
      ],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeHarness(envOver: Partial<Env> = {}) {
  const registryStorage = new FakeStorage();
  const registryCtx = {
    storage: registryStorage,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  } as unknown as DurableObjectState;
  // Built after `env` exists so the registry sees the same Env.
  let registry: RegistryDO;
  const registryPosts: string[] = [];
  const registryStub = {
    fetch: async (input: string | Request, init?: RequestInit) => {
      const req = typeof input === "string" ? new Request(input, init) : input;
      registryPosts.push(`${req.method} ${new URL(req.url).pathname}`);
      return registry.fetch(req);
    },
  };

  const sockets: FakeSocket[] = [];
  const sessionStorage = new FakeStorage();
  const sessionCtx = {
    storage: sessionStorage,
    acceptWebSocket: (ws: FakeSocket) => sockets.push(ws),
    getWebSockets: () => sockets,
  } as unknown as DurableObjectState;

  const env = {
    LLM_API_KEY: "sk-OURS",
    LLM_BASE_URL: "https://api.anthropic.com/v1",
    LLM_MODEL: "claude-haiku-4-5",
    AUTH_TOKEN: "op",
    REGISTRY_DO: { get: () => registryStub, idFromName: (n: string) => n },
    SESSION_DO: { get: () => null, idFromName: (n: string) => n },
    ...envOver,
  } as unknown as Env;
  registry = new RegistryDO(registryCtx, env);
  const session = new SessionDO(sessionCtx, env);
  return { session, sessionStorage, registry, registryStorage, registryPosts, sockets, env };
}

const SESSION_ID = "sess_cost_1";

/** A request as index.ts forwards it to the DO: the operator's resolved
 * identity stamped onto the URL by the real encoder. */
function asOperator(path: string, init?: RequestInit): Request {
  return forwardWithIdentity(new Request(`https://backend/session/${SESSION_ID}${path}`, init), { kind: "operator" });
}

/**
 * Connect as the operator and send the client's hello. The upgrade itself
 * cannot run under Node (a 101 Response is not constructible here), so this
 * does what SessionDO.fetch's upgrade branch does after the ownership gate —
 * stamp the resolved identity on the socket and accept it — then drives the
 * hello frame through the real webSocketMessage.
 */
async function connectOperator(h: ReturnType<typeof makeHarness>): Promise<FakeSocket> {
  const ws = new FakeSocket();
  ws.serializeAttachment({ identity: { kind: "operator" } });
  h.sockets.push(ws);
  await h.session.webSocketMessage(
    ws as unknown as WebSocket,
    JSON.stringify({ type: "hello", session_id: SESSION_ID, retention: "24h", input_route: "built_in_mic" }),
  );
  expect(ws.sent[0]).toMatchObject({ type: "hello.ack" });
  return ws;
}

async function speak(h: ReturnType<typeof makeHarness>, ws: FakeSocket, seq: number, text: string): Promise<void> {
  await h.session.webSocketMessage(
    ws as unknown as WebSocket,
    JSON.stringify({
      type: "transcript",
      segment: { session_id: SESSION_ID, seq, t_start: seq * 1000, t_end: seq * 1000 + 900, speaker: "USER", confidence: 1, text, final: true },
    }),
  );
}

describe("SessionDO per-session cost, end to end", () => {
  const T0 = Date.parse("2026-09-18T10:00:00.000Z");
  let fetchMock: ReturnType<typeof vi.fn>;
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    fetchMock = vi.fn(async () => analysisReply({ input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("records a hosted tick by pass, serves it live, logs and files it at end, and lists it at the registry", async () => {
    const h = makeHarness();
    const ws = await connectOperator(h);

    // Four final segments trigger a tick; the words clear the gate.
    await speak(h, ws, 1, "we should ship the pricing page by friday");
    await speak(h, ws, 2, "I will send the draft to sam tomorrow morning");
    await speak(h, ws, 3, "can you confirm the budget number with finance");
    vi.setSystemTime(T0 + 45_000);
    await speak(h, ws, 4, "yes I will confirm it and get back to you");

    // One combined-analysis call went out on our key, to the primary leg.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]!.body as string);
    expect(body.model).toBe("claude-haiku-4-5");

    // Persisted per (provider, model, pass). Haiku $1/$5 with cache read 0.1x:
    // 1000 * 1 + 500 * 0.1 + 100 * 5 = 1000 + 50 + 500 = 1550 micro-$.
    const stored = await h.sessionStorage.get<{ buckets: unknown[]; byokCalls: number }>("cost:session");
    expect(stored?.buckets).toEqual([
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        pass: "extract_analysis",
        calls: 1,
        inputTokens: 1500,
        outputTokens: 100,
        micros: 1550,
        basis: "exact",
      },
    ]);

    // Live read: the row so far, measured to now, with the transcript size.
    vi.setSystemTime(T0 + 60_000);
    const liveRes = await h.session.fetch(asOperator("/cost"));
    expect(liveRes.status).toBe(200);
    const live = (await liveRes.json()) as SessionCostRow;
    expect(live).toMatchObject({
      session_id: SESSION_ID,
      owner_user_id: null,
      ended_at: null,
      duration_ms: 60_000,
      transcript_segments: 4,
      transcript_words: 35,
      configured_provider: "anthropic",
      configured_model: "claude-haiku-4-5",
      calls: 1,
      micros: 1550,
      usd: 0.00155,
      // 1550 micro-$ over one minute.
      usd_per_minute: 0.00155,
      basis: "exact",
      unpriced_models: [],
      passes: [{ pass: "extract_analysis", calls: 1, input_tokens: 1500, output_tokens: 100, micros: 1550, basis: "exact" }],
    });

    // Nothing has been logged or filed yet — the session is live.
    expect(logs.filter((l) => l.startsWith("SESSION_COST "))).toEqual([]);
    expect(h.registryPosts).not.toContain("POST /_session_cost");

    // End it. The forced end-flush re-analyzes nothing (no pending segments),
    // then endSessionInternal emits the report before the retention alarm.
    vi.setSystemTime(T0 + 90_000);
    await h.session.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "session.end" }));

    const lines = logs.filter((l) => l.startsWith("SESSION_COST "));
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!.slice("SESSION_COST ".length)) as SessionCostRow;
    expect(logged).toMatchObject({
      session_id: SESSION_ID,
      ended_at: "2026-09-18T10:01:30.000Z",
      duration_ms: 90_000,
      transcript_words: 35,
      micros: 1550,
      // 1550 / 1.5 min = 1033.33 → 0.001033
      usd_per_minute: 0.001033,
    });
    // No transcript text anywhere in the line.
    expect(lines[0]).not.toMatch(/pricing page|finance|sam/);

    // Filed with the session, and the ended session answers from the file
    // even though its transcript may be purged by now.
    const filed = await h.sessionStorage.get<SessionCostRow>("cost:report");
    expect(filed).toEqual(logged);
    const endedRes = await h.session.fetch(asOperator("/cost"));
    expect(await endedRes.json()).toEqual(logged);

    // Handed to the registry, which re-validated and stored it under a key
    // that sorts by end time, and lists it back with the per-model rollup.
    expect(h.registryPosts).toContain("POST /_session_cost");
    const listing = (await (await h.registry.fetch(new Request("https://registry/_session_costs?limit=10"))).json()) as {
      returned: number;
      sessions: SessionCostRow[];
      by_model: Array<{ model: string; sessions: number; micros: number; usd_per_minute: number | null }>;
      totals: { micros: number };
    };
    expect(listing.returned).toBe(1);
    expect(listing.sessions[0]).toEqual(logged);
    expect(listing.by_model).toEqual([
      expect.objectContaining({ provider: "anthropic", model: "claude-haiku-4-5", sessions: 1, micros: 1550, usd_per_minute: 0.001033 }),
    ]);
    expect(listing.totals.micros).toBe(1550);
    expect([...h.registryStorage.map.keys()].filter((k) => k.startsWith("sessioncost:"))).toHaveLength(1);
  });

  it("prices an OpenRouter candidate as the hosted primary at its listed rate, and flags an unlisted one", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  tool_calls: [
                    {
                      function: {
                        name: "extract_analysis",
                        arguments: JSON.stringify({ commitments: [], asks: [], subtext: [], suggestions: [], decisions: [] }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 2000, completion_tokens: 200 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    // The model under test, switched by config alone: the primary leg on the
    // OpenAI-compatible wire at OpenRouter.
    const listed = makeHarness({
      LLM_PROVIDER: "openrouter",
      LLM_BASE_URL: "https://openrouter.ai/api/v1",
      LLM_MODEL: "z-ai/glm-4.5-air",
    });
    const ws = await connectOperator(listed);
    for (let i = 1; i <= 4; i++) await speak(listed, ws, i, "some real words in this line of transcript");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    // z-ai/glm-4.5-air $0.13/$0.85: 2000 * 0.13 + 200 * 0.85 = 260 + 170 = 430.
    const row = (await (
      await listed.session.fetch(asOperator("/cost"))
    ).json()) as SessionCostRow;
    expect(row).toMatchObject({
      configured_provider: "openrouter",
      configured_model: "z-ai/glm-4.5-air",
      micros: 430,
      priced_micros: 430,
      estimated_micros: 0,
      basis: "configured",
      unpriced_models: [],
    });

    // Same session shape on a model nobody has listed: still counted, at the
    // defensive estimate, and SAID SO — never a $0 row.
    fetchMock.mockClear();
    const unlisted = makeHarness({
      LLM_PROVIDER: "openrouter",
      LLM_BASE_URL: "https://openrouter.ai/api/v1",
      LLM_MODEL: "some-lab/never-listed",
    });
    const ws2 = await connectOperator(unlisted);
    for (let i = 1; i <= 4; i++) await speak(unlisted, ws2, i, "some real words in this line of transcript");
    const row2 = (await (
      await unlisted.session.fetch(asOperator("/cost"))
    ).json()) as SessionCostRow;
    // Sonnet estimate $3/$15: 2000 * 3 + 200 * 15 = 6000 + 3000 = 9000.
    expect(row2).toMatchObject({
      micros: 9000,
      priced_micros: 0,
      estimated_micros: 9000,
      basis: "estimated",
      unpriced_models: ["openrouter/some-lab/never-listed"],
    });
  });
});

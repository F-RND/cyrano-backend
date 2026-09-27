// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { chatGPTMCPTesting } from "../src/chatgpt-mcp.js";
import { chatGPTRegistryTesting } from "../src/registry-do.js";
import { AGENT_NOTE_KINDS } from "../src/types.js";

describe("ChatGPT MCP metadata", () => {
  it("uses the public HTTPS /mcp endpoint as the OAuth resource", () => {
    const request = new Request("https://api.cyrano.example/mcp");
    expect(chatGPTMCPTesting.resourceFor(request)).toBe("https://api.cyrano.example/mcp");
  });

  it("requires authorization code + S256 PKCE + the exact MCP resource", () => {
    const request = new Request("https://api.cyrano.example/oauth/authorize");
    const valid = new URLSearchParams({
      response_type: "code",
      client_id: "client",
      redirect_uri: "https://chatgpt.com/callback",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      resource: "https://api.cyrano.example/mcp",
      scope: "context:read context:write",
    });
    expect(chatGPTMCPTesting.validAuthorizationQuery(valid, request)).toBeNull();

    const noPKCE = new URLSearchParams(valid);
    noPKCE.delete("code_challenge");
    expect(chatGPTMCPTesting.validAuthorizationQuery(noPKCE, request)).toContain("PKCE");

    const wrongResource = new URLSearchParams(valid);
    wrongResource.set("resource", "https://attacker.example/mcp");
    expect(chatGPTMCPTesting.validAuthorizationQuery(wrongResource, request)).toContain("resource");

    const excessScope = new URLSearchParams(valid);
    excessScope.set("scope", "context:read admin");
    expect(chatGPTMCPTesting.validAuthorizationQuery(excessScope, request)).toContain("scope");
  });

  it("tells the user where their code will go and who says they are asking", async () => {
    const { pairingRequester, pairingPage } = chatGPTMCPTesting;
    // A client_id as RegistryDO mints it: base64url(JSON registration).signature.
    const payload = btoa(JSON.stringify({
      clientName: "Claude <script>",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      issuedAt: 1,
    })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const params = new URLSearchParams({
      client_id: `cyrano_chatgpt_${payload}.sig`,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    });
    expect(pairingRequester(params)).toEqual({
      clientName: "Claude <script>",
      redirectHost: "claude.ai",
    });
    const html = await pairingPage(params).text();
    // The host is the one thing an attacker's registration cannot dress up.
    expect(html).toContain("Code will be sent to");
    expect(html).toContain("claude.ai");
    // The self-reported name is shown, escaped, and labelled as self-reported.
    expect(html).toContain("Client calls itself");
    expect(html).toContain("Claude &lt;script&gt;");
    expect(html).not.toContain("<script>");

    // An undecodable client_id still names the host; garbage yields nothing.
    expect(pairingRequester(new URLSearchParams({
      client_id: "whatever",
      redirect_uri: "https://evil.test/cb",
    }))).toEqual({ clientName: null, redirectHost: "evil.test" });
    expect(pairingRequester(new URLSearchParams({ redirect_uri: "javascript:alert(1)" })))
      .toEqual({ clientName: null, redirectHost: null });
    const bare = await pairingPage(new URLSearchParams()).text();
    expect(bare).not.toContain("Code will be sent to");
  });

  it("lets the pairing form redirect back to the client that started the flow", () => {
    const { pairingCSP, cspOriginFor } = chatGPTMCPTesting;

    // Safari and Firefox enforce form-action across the 302, so the client's
    // own origin has to be named or every browser pairing dead-ends there.
    const chatgpt = new URLSearchParams({
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    });
    expect(pairingCSP(chatgpt)).toContain("form-action 'self' https://chatgpt.com;");

    const claude = new URLSearchParams({ redirect_uri: "https://claude.ai/api/mcp/auth_callback" });
    expect(pairingCSP(claude)).toContain("form-action 'self' https://claude.ai;");

    // Ports survive (native clients loop back through one), paths never do.
    expect(cspOriginFor("http://localhost:33418/callback")).toBe("http://localhost:33418");
    expect(cspOriginFor("https://example.test:8443/cb?x=1")).toBe("https://example.test:8443");

    // Anything that isn't a plain http(s) origin falls back to 'self' alone
    // rather than letting a crafted redirect_uri write the header.
    for (const bad of ["", "not a url", "javascript:alert(1)", "cursor://cb", "http://evil.test/cb"]) {
      expect(cspOriginFor(bad)).toBeNull();
    }
    expect(pairingCSP(new URLSearchParams())).toContain("form-action 'self';");
    expect(pairingCSP(new URLSearchParams({ redirect_uri: "http://evil.test/cb" })))
      .toContain("form-action 'self';");

    // The rest of the policy stays locked down.
    expect(pairingCSP(chatgpt)).toContain("default-src 'none'");
    expect(pairingCSP(chatgpt)).toContain("frame-ancestors 'none'");
  });

  it("marks reads and writes accurately for ChatGPT confirmation policy", () => {
    const [read, write] = chatGPTMCPTesting.tools;
    expect(read?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(write?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    });
  });
});

describe("ChatGPT pairing and signed client ids", () => {
  it("generates human-readable pairing codes with enough random characters", () => {
    const codes = new Set(
      Array.from({ length: 50 }, () => chatGPTRegistryTesting.randomPairingCode()),
    );
    expect(codes.size).toBe(50);
    for (const code of codes) {
      expect(code).toMatch(/^CYR-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  it("round-trips URL-safe base64 without padding", () => {
    const original = new TextEncoder().encode("https://chatgpt.com/oauth/callback?x=1");
    const encoded = chatGPTRegistryTesting.base64URL(original);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(chatGPTRegistryTesting.decodeBase64URL(encoded)).toEqual(original);
  });

  it("signs client metadata deterministically and detects tampering", async () => {
    const signature = await chatGPTRegistryTesting.hmacBase64URL("secret", "payload");
    expect(signature).toBe(await chatGPTRegistryTesting.hmacBase64URL("secret", "payload"));
    expect(chatGPTRegistryTesting.constantTimeEqual(signature, `${signature.slice(0, -1)}x`)).toBe(false);
  });
});

describe("Pairing code failures are distinguishable", () => {
  const { chatGPTPairingFailure, pairTombstoneTTLMs } = chatGPTRegistryTesting;
  const now = 1_800_000_000_000;
  const live = (outcome: "used" | "expired") => ({
    outcome,
    at: now,
    expiresAt: now + pairTombstoneTTLMs,
  });

  it("separates a spent code from a lapsed one from one that never existed", () => {
    expect(chatGPTPairingFailure(live("used"), now)).toBe("pairing_already_used");
    expect(chatGPTPairingFailure(live("expired"), now)).toBe("pairing_expired");
    expect(chatGPTPairingFailure(undefined, now)).toBe("invalid_pairing_code");
  });

  it("stops claiming a code was real once its tombstone ages out", () => {
    const stale = { outcome: "used" as const, at: now, expiresAt: now - 1 };
    expect(chatGPTPairingFailure(stale, now)).toBe("invalid_pairing_code");
  });

  it("keeps a tombstone explainable for a full day, so same-session retries land", () => {
    const tombstone = live("used");
    expect(chatGPTPairingFailure(tombstone, now + 23 * 60 * 60 * 1000)).toBe("pairing_already_used");
    expect(chatGPTPairingFailure(tombstone, now + 25 * 60 * 60 * 1000)).toBe("invalid_pairing_code");
  });

  it("gives each failure its own remedy rather than one collapsed string", () => {
    const { pairingFailureMessage } = chatGPTMCPTesting;
    const used = pairingFailureMessage("pairing_already_used");
    const expired = pairingFailureMessage("pairing_expired");
    const unknown = pairingFailureMessage("invalid_pairing_code");

    expect(new Set([used, expired, unknown]).size).toBe(3);
    expect(used).toContain("already been used");
    expect(expired).toContain("expired");
    expect(unknown).toContain("typos");
    // Every one has to tell the user where to get a working code.
    for (const message of [used, expired, unknown]) {
      expect(message).toContain("Settings → Connections");
    }
    // Anything unrecognized stays generic instead of guessing.
    expect(pairingFailureMessage("invalid_client")).toBe("Cyrano could not authorize this connection.");
    expect(pairingFailureMessage(undefined)).toBe("Cyrano could not authorize this connection.");
  });
});

describe("Connector generalization", () => {
  it("maps client families to labels and install URLs, defaulting legacy empty bodies to ChatGPT", () => {
    expect(chatGPTMCPTesting.connectorClient(undefined)).toEqual(
      chatGPTMCPTesting.connectorClients.chatgpt,
    );
    expect(chatGPTMCPTesting.connectorClient("")).toEqual(
      chatGPTMCPTesting.connectorClients.chatgpt,
    );
    expect(chatGPTMCPTesting.connectorClient("claude")).toEqual({
      label: "Claude",
      installUrl: "https://claude.ai/new#customize/connectors",
    });
    expect(chatGPTMCPTesting.connectorClient("Claude")).toEqual(
      chatGPTMCPTesting.connectorClient("claude"),
    );
    // "other" has no install URL: we don't know where that client configures
    // connectors, and a wrong deep link is worse than none.
    expect(chatGPTMCPTesting.connectorClient("other").installUrl).toBeUndefined();
    // Free-form names are capped and used verbatim.
    expect(chatGPTMCPTesting.connectorClient("x".repeat(200)).label).toHaveLength(80);
  });

  it("exposes cyrano_workflow as a read-only tool", () => {
    expect(chatGPTMCPTesting.workflowTool.name).toBe("cyrano_workflow");
    expect(chatGPTMCPTesting.workflowTool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    const schema = chatGPTMCPTesting.workflowTool.inputSchema;
    expect(schema.properties.workflow.enum).toEqual([
      "review",
      "catch_me_up",
      "to_requirements",
      "follow_ups",
      "prep",
      "watch_notes",
      "listen",
    ]);
  });

  it("points the watch_notes loop at the remote note tool", () => {
    // watch_notes was absent from the remote surface until a note-filing tool
    // existed for the loop to write into; the loop must name the REMOTE tools,
    // since the local bridge's don't exist here.
    const directive = chatGPTMCPTesting.watchNotesDirective("budget figures");
    expect(directive).toContain("cyrano_add_session_note");
    expect(directive).toContain("cyrano_get_live_context");
    expect(directive).toContain("budget figures");
    expect(directive).not.toMatch(/cyrano_send[^_]/);
    expect(chatGPTMCPTesting.watchNotesDirective(null)).toContain("worth remembering");
  });

  it("builds workflow tasks with an optional focus and rejects unknown workflows", () => {
    expect(chatGPTMCPTesting.workflowTask("review", null)).toContain("gaps, risks, contradictions");
    expect(chatGPTMCPTesting.workflowTask("review", "pricing")).toContain("Focus especially on: pricing.");
    expect(chatGPTMCPTesting.workflowTask("prep", "the Acme call")).toContain("the Acme call");
    expect(chatGPTMCPTesting.workflowTask("catch_me_up", null)).toContain("Decided, Still open");
    expect(chatGPTMCPTesting.workflowTask("watch_notes", null)).toBeNull();
    expect(chatGPTMCPTesting.workflowTask("nonsense", null)).toBeNull();
  });

  it("keeps the listen loop on remote tool names only", () => {
    expect(chatGPTMCPTesting.listenDirective).toContain("cyrano_get_live_context");
    expect(chatGPTMCPTesting.listenDirective).toContain("cyrano_send_reply");
    // The local bridge's tools don't exist here; instructing a remote client
    // to call them would dead-end the loop.
    expect(chatGPTMCPTesting.listenDirective).not.toContain("cyrano_await_question");
    expect(chatGPTMCPTesting.listenDirective).not.toMatch(/cyrano_send[^_]/);
  });
});

describe("Empty reads explain themselves", () => {
  const { inactiveReason, inactiveDetail } = chatGPTMCPTesting;

  it("separates 'a device is relaying but idle' from 'nothing ever reached this account'", () => {
    // Presence is the only evidence the Worker has that a device is pointed at
    // this account at all, so it's what splits "start a session" from "your
    // sessions never leave your device / you're on the wrong account".
    expect(inactiveReason({ sessionId: null, presenceAt: 1_700_000_000_000 })).toBe("no_active_session");
    expect(inactiveReason({ sessionId: null, presenceAt: null })).toBe("never_relayed");
  });

  it("names the three fixes a client would otherwise have to guess between", () => {
    // The reported failure: {"sessions": []} with no way to tell retention from
    // scope from a wrong account. Each reason has to carry its own next step.
    expect(inactiveDetail("never_relayed")).toMatch(/relay/i);
    expect(inactiveDetail("never_relayed")).toMatch(/same Cyrano account/i);
    expect(inactiveDetail("no_active_session")).toMatch(/start a session/i);
    expect(inactiveDetail("session_expired")).toMatch(/retention/i);
    // None of them may read as "the user has no sessions" — that conclusion is
    // what sent the reporting assistant off to third-party transcripts.
    for (const reason of ["never_relayed", "no_active_session", "session_expired"] as const) {
      expect(inactiveDetail(reason).length).toBeGreaterThan(40);
    }
  });

  it("declares reason/detail/account in the output schema that forbids extra keys", () => {
    // outputSchema is additionalProperties:false and strict clients validate
    // structuredContent against it — an undeclared diagnostic field is a tool
    // error, not extra help.
    const schema = chatGPTMCPTesting.getContextTool.outputSchema;
    expect(schema.additionalProperties).toBe(false);
    for (const key of ["active", "context", "reason", "detail", "account"]) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
    expect(schema.properties.reason.enum).toEqual([
      "never_relayed",
      "no_active_session",
      "session_expired",
    ]);
    // The workflow tool returns the same vocabulary when it comes back empty.
    const workflowSchema = chatGPTMCPTesting.workflowTool.outputSchema;
    expect(Object.keys(workflowSchema.properties)).toContain("reason");
    expect(Object.keys(workflowSchema.properties)).toContain("account");
  });
});

describe("Refused writes explain themselves", () => {
  const { agentResultsFailure, addNoteTool, getContextTool, tools } = chatGPTMCPTesting;

  it("turns the DO's session_ended 409 into a sentence with the next step", () => {
    // The reported failure: an assistant saw only `results_failed_409`, read it
    // as a transient conflict, retried twice, and had nothing to tell the user.
    // The DO had said why in the body the Worker threw away.
    const text = agentResultsFailure(409, JSON.stringify({ error: "session_ended" }));
    expect(text).toMatch(/^session_ended\./);
    expect(text).toMatch(/has ended/i);
    expect(text).toMatch(/do not retry/i);
    expect(text).toMatch(/NOT saved/);
    expect(text).toMatch(/new session/i);
    expect(text).not.toContain("results_failed");
  });

  it("keeps the status and the body for every other refusal", () => {
    expect(agentResultsFailure(400, JSON.stringify({ error: "invalid_json" }))).toBe(
      "results_failed_400: invalid_json",
    );
    expect(agentResultsFailure(403, "forbidden")).toBe("results_failed_403: forbidden");
    expect(agentResultsFailure(500, "")).toBe("results_failed_500");
    // A 409 that isn't session_ended must stay distinguishable from one that is.
    expect(agentResultsFailure(409, JSON.stringify({ error: "something_else" }))).toBe(
      "results_failed_409: something_else",
    );
  });

  it("declares `writable` in the strict context schema and requires it", () => {
    // An ended session is still readable for its retention window, so
    // `active: true` alone doesn't say whether a note would land.
    const schema = getContextTool.outputSchema;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toContain("writable");
    expect(schema.required).toContain("writable");
    expect(schema.properties.writable.description).toMatch(/ended/i);
  });

  it("tells the assistant about the write window before it calls", () => {
    expect(addNoteTool.description).toMatch(/while the session is running/i);
    expect(addNoteTool.description).toMatch(/writable/);
    expect(addNoteTool.description).toMatch(/not saved/i);
    const reply = tools.find((t) => t.name === "cyrano_send_reply");
    expect(reply?.description).toMatch(/while the session is running/i);
  });
});

describe("cyrano_add_session_note kinds", () => {
  it("offers exactly the kinds the server keeps, study_cue included and explained", () => {
    // A kind the tool offered but sanitizeAgentNote didn't know would land as
    // a plain note with no error; one it knew but didn't offer is unreachable.
    const kind = chatGPTMCPTesting.addNoteTool.inputSchema.properties.kind;
    expect(kind.enum).toEqual(AGENT_NOTE_KINDS);
    expect(kind.enum).toContain("study_cue");
    expect(kind.description).toMatch(/"study_cue" is something the lecturer flagged for the exam or study guide/);
    expect(kind.description).toMatch(/lecture sessions/);
    expect(chatGPTMCPTesting.addNoteTool.description).toMatch(/study cue/);
  });
});

describe("cyrano_get_session origin read", () => {
  it("asks the device for the whole transcript, not its live-poll tail", () => {
    // The device's /context defaults to the most recent 80 lines. The tool
    // promises "the whole session as the user's sharing rules allow", so the
    // forwarded query must say so — a 60-minute call came back as its last
    // ~15 minutes with nothing in the payload saying it was cut.
    expect(chatGPTMCPTesting.sessionOriginQuery("sess-1")).toEqual({
      session: "sess-1",
      transcript: "full",
    });
  });
});

// ---- Origin-pull tools, end to end through the MCP handler ----
//
// A fake registry (token → a user with both scopes) and a fake account inbox
// (the cached index, and a scripted device behind /origin), so each test reads
// exactly what an assistant would get back.

type McpEnv = Parameters<typeof chatGPTMCPTesting.handleMCP>[1];
type Forwarded = { method: string; path: string; query: Record<string, string>; client: string | null };

function fakeEnv(options: {
  index?: unknown;
  origin?: (forwarded: Forwarded) => Response;
  scope?: string;
}): { env: McpEnv; forwarded: Forwarded[]; indexReads: () => number } {
  const forwarded: Forwarded[] = [];
  let indexReads = 0;
  const stub = (answer: (url: URL, init?: RequestInit) => Response) => ({
    fetch: async (input: string | URL, init?: RequestInit) => answer(new URL(String(input)), init),
  });
  const env = {
    REGISTRY_DO: {
      idFromName: (name: string) => name,
      get: () => stub(() => Response.json({
        valid: true,
        kind: "user",
        user_id: "u-1",
        scope: options.scope ?? "context:read context:write",
        client_name: "Claude",
        label: "Claude",
      })),
    },
    ACCOUNT_INBOX_DO: {
      idFromName: (name: string) => name,
      get: () => stub((url, init) => {
        if (url.pathname === "/index") {
          indexReads += 1;
          return Response.json({ index: options.index ?? null, device_online: false });
        }
        const body = JSON.parse(String(init?.body)) as Forwarded;
        forwarded.push(body);
        return options.origin
          ? options.origin(body)
          : Response.json({ device_online: false }, { status: 503 });
      }),
    },
  };
  return { env: env as unknown as McpEnv, forwarded, indexReads: () => indexReads };
}

async function rpc(env: McpEnv, method: string, params?: Record<string, unknown>) {
  const response = await chatGPTMCPTesting.handleMCP(new Request("https://api.cyrano.example/mcp", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  }), env);
  return response.json() as Promise<{
    result?: {
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      tools?: Array<{ name: string }>;
      instructions?: string;
    };
    error?: { code: number; message: string };
  }>;
}

async function callTool(env: McpEnv, name: string, args: Record<string, unknown> = {}) {
  const reply = await rpc(env, "tools/call", { name, arguments: args });
  expect(reply.result?.isError).toBeUndefined();
  return reply.result?.structuredContent as Record<string, unknown>;
}

const device = (status: number, body: unknown) =>
  () => Response.json({ status, body, device: "Jo's MacBook" });
const ACCOUNT = { kind: "user", user_id: "u-1", connection: "Claude" };

describe("cyrano_get_session through the shared origin read", () => {
  it("forwards exactly the read it always did", async () => {
    const { env, forwarded } = fakeEnv({ origin: device(200, { title: "Standup" }) });
    expect(await callTool(env, "cyrano_get_session", { session_id: " sess-1 " })).toEqual({
      ok: true,
      session: { title: "Standup" },
      device: "Jo's MacBook",
      account: ACCOUNT,
    });
    expect(forwarded).toEqual([{
      method: "GET",
      path: "/context",
      query: { session: "sess-1", transcript: "full" },
      client: "Claude",
    }]);
  });

  it("names each way the device can fail to answer, in the same words", async () => {
    const cases: Array<[number, string, string]> = [
      [503, "device_unreachable", "The user's device is asleep or offline, so the conversation could not be fetched. Cyrano does not keep a copy on its servers — this content only exists on their device. Ask them to wake it and try again."],
      [504, "device_timed_out", "The user's device is connected but did not answer in time. Try once more; if it keeps happening, their device may be busy or on a poor connection."],
      [429, "too_many_requests", "Too many session reads are in flight for this account. Wait for the ones you already issued, then continue one at a time — do not retry in a loop."],
    ];
    for (const [status, reason, detail] of cases) {
      const { env } = fakeEnv({ origin: () => Response.json({}, { status }) });
      expect(await callTool(env, "cyrano_get_session", { session_id: "sess-1" })).toEqual({
        ok: false,
        reason,
        detail,
        account: ACCOUNT,
      });
    }
  });

  it("relays the device's own refusal, and its 404 as no_such_session", async () => {
    const gone = fakeEnv({ origin: device(404, { error: "no session with that id" }) });
    expect(await callTool(gone.env, "cyrano_get_session", { session_id: "sess-1" })).toEqual({
      ok: false,
      reason: "no_such_session",
      detail: "no session with that id",
      account: ACCOUNT,
    });
    const scoped = fakeEnv({ origin: device(403, { error: "outside your sharing scope" }) });
    expect(await callTool(scoped.env, "cyrano_get_session", { session_id: "sess-1" })).toMatchObject({
      reason: "refused_by_device",
      detail: "outside your sharing scope",
    });
    const mute = fakeEnv({ origin: device(403, null) });
    expect(await callTool(mute.env, "cyrano_get_session", { session_id: "sess-1" })).toMatchObject({
      reason: "refused_by_device",
      detail: "The user's device declined to serve that session.",
    });
    // A broker answer with no device envelope reads as a refusal, not success.
    const junk = fakeEnv({ origin: () => new Response("not json") });
    expect(await callTool(junk.env, "cyrano_get_session", { session_id: "sess-1" })).toMatchObject({
      ok: false,
      reason: "refused_by_device",
    });
  });

  it("asks for an id before it asks the device anything", async () => {
    const { env, forwarded } = fakeEnv({ origin: device(200, {}) });
    expect(await callTool(env, "cyrano_get_session", { session_id: "  " })).toEqual({
      ok: false,
      reason: "missing_session_id",
      detail: "Call cyrano_list_sessions first and pass one of its `id` values.",
      account: ACCOUNT,
    });
    expect(forwarded).toEqual([]);
  });
});

describe("Tag tools over origin-pull", () => {
  const { tagSlug, tagsFromIndex, tagContextOriginQuery, listTagsTool, tagContextTool, listSessionsTool } =
    chatGPTMCPTesting;

  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 8, 1, 14); // 2026-09-01T14:00:00Z
  const ROWS = [
    { id: "s4", title: "BIO 201, week 4", started_at: T0 + 21 * DAY, tags: ["BIO 201"], stored: true },
    { id: "s3", title: "Acme sync", started_at: T0 + 14 * DAY, tags: ["Acme Corp."] },
    { id: "s2", title: "BIO 201, week 2", started_at: T0 + 7 * DAY, tags: ["BIO 201", "Café"] },
    { id: "s1", title: "BIO 201, week 1", started_at: T0, tags: ["bio 201"] },
    { id: "s0", title: "Untagged", started_at: T0 - DAY },
  ];
  const INDEX = { sessions: ROWS, built_at: T0 + 30 * DAY, device: "Jo's MacBook", scope: "all" };
  const COURSE = {
    code: "BIO 201",
    title: "Cell Biology",
    instructor: "Dr. Okafor",
    meetings: ["Tue 10:00–11:15", "Thu 10:00–11:15"],
    term_start: "2026-08-24T04:00:00Z",
    term_end: "2026-12-11T05:00:00Z",
    upcoming_exams: [{ name: "Midterm", date: "2026-10-15T14:00:00Z" }],
  };
  const offline = () => Response.json({ device_online: false }, { status: 503 });
  const slow = () => Response.json({ device_online: true, timed_out: true }, { status: 504 });

  it("folds tag names to the slugs the device resolves", () => {
    // Every expected value here is SessionTag.slug(from:) run on the same
    // input by the Swift toolchain, edge cases included.
    const swift: Array<[string, string]> = [
      ["Acme Corp.", "acme-corp"],
      ["Café", "cafe"],
      ["  R&D  ", "r-d"],
      ["!!!", ""],
      ["Straße", "strasse"],
      ["ıstanbul", "stanbul"],
      ["İstanbul", "istanbul"],
      ["ＦＵＬＬ width", "full-width"],
      ["ﬁle", "file"],
      ["CS 101: Intro", "cs-101-intro"],
      ["Ångström Øresund Æsir Łódź", "angstrom-resund-sir-odz"],
      ["数学 101", "101"],
      ["#acme", "acme"],
      ["a-very-long-course-name-that-goes-past-thirty-two", "a-very-long-course-name-that-goe"],
      ["ǅemal", "emal"],
      ["Ⅻ roman", "roman"],
      ["²nd", "nd"],
    ];
    for (const [name, slug] of swift) expect([name, tagSlug(name)]).toEqual([name, slug]);
  });

  it("rebuilds a tag list from index rows: one entry per slug, newest first", () => {
    expect(tagsFromIndex(ROWS)).toEqual([
      // "bio 201" on the oldest row folds into the same tag; the newest
      // row's spelling is the one shown.
      { name: "BIO 201", slug: "bio-201", sessions: 3, last_used: "2026-09-22T14:00:00Z" },
      { name: "Acme Corp.", slug: "acme-corp", sessions: 1, last_used: "2026-09-15T14:00:00Z" },
      { name: "Café", slug: "cafe", sessions: 1, last_used: "2026-09-08T14:00:00Z" },
    ]);
    // A row listing one tag twice counts once; junk rows and slugless names
    // are skipped rather than invented into tags.
    expect(tagsFromIndex([
      { id: "a", started_at: T0, tags: ["Lab", "lab", "!!!"] },
      null,
      "junk",
      { id: "b", tags: ["Lab"] },
    ])).toEqual([{ name: "Lab", slug: "lab", sessions: 2, last_used: "2026-09-01T14:00:00Z" }]);
  });

  it("lists tags from the device untouched, course included", async () => {
    const tags = [
      { name: "BIO 201", slug: "bio-201", sessions: 3, last_used: "2026-09-22T14:00:00Z", course: COURSE },
      { name: "Acme", slug: "acme", sessions: 1 },
    ];
    const { env, forwarded, indexReads } = fakeEnv({
      index: INDEX,
      origin: device(200, { tags, withheld: 1 }),
    });
    const result = await callTool(env, "cyrano_list_tags");
    expect(result).toEqual({
      ok: true,
      tags,
      withheld: 1,
      source: "device",
      device: "Jo's MacBook",
      account: ACCOUNT,
    });
    expect((result.tags as Array<{ course?: unknown }>)[0]?.course).toEqual(COURSE);
    expect(forwarded).toEqual([{ method: "GET", path: "/tags", query: {}, client: "Claude" }]);
    // The live answer is the whole answer; the index is not consulted.
    expect(indexReads()).toBe(0);
  });

  it("falls back to the index when the Mac is offline or slow, and says what is missing", async () => {
    for (const [origin, lead] of [[offline, /asleep or offline/], [slow, /did not answer in time/]] as const) {
      const { env } = fakeEnv({ index: INDEX, origin });
      const result = await callTool(env, "cyrano_list_tags");
      expect(result).toEqual({
        ok: true,
        tags: tagsFromIndex(ROWS),
        source: "index",
        notice: expect.stringMatching(lead),
        built_at: INDEX.built_at,
        account: ACCOUNT,
      });
      // Course details and the hidden-tag count live only on the Mac; the
      // copy must not look like a course with no schedule.
      expect(result.notice).toMatch(/Course details/);
      expect(result.notice).toMatch(/hidden from assistants/);
      expect(result.notice).toMatch(/missing here, not absent/);
      expect(result).not.toHaveProperty("withheld");
      expect(JSON.stringify(result.tags)).not.toContain("course");
    }
  });

  it("reports the device state plainly when there is no index to fall back on", async () => {
    const none = fakeEnv({ origin: offline });
    expect(await callTool(none.env, "cyrano_list_tags")).toEqual({
      ok: false,
      reason: "device_unreachable",
      detail: expect.stringContaining("so their tag list could not be fetched"),
      account: ACCOUNT,
    });
    // Too many reads in flight is not "offline": no fallback, no index read.
    const busy = fakeEnv({ index: INDEX, origin: () => Response.json({}, { status: 429 }) });
    expect(await callTool(busy.env, "cyrano_list_tags")).toMatchObject({
      ok: false,
      reason: "too_many_requests",
    });
    expect(busy.indexReads()).toBe(0);
    const refused = fakeEnv({ index: INDEX, origin: device(403, { error: "Reading past sessions remotely is turned off" }) });
    expect(await callTool(refused.env, "cyrano_list_tags")).toEqual({
      ok: false,
      reason: "refused_by_device",
      detail: "Reading past sessions remotely is turned off",
      account: ACCOUNT,
    });
  });

  it("forwards a tag rollup and relays the device's document as is", async () => {
    const rollup = {
      day: "2026-09-26T04:00:00Z",
      sections: [{ title: "Decided", items: ["Lab reports move to Fridays"], note: null }],
      tag: "BIO 201",
      truncated: true,
      considered: 23,
    };
    const { env, forwarded, indexReads } = fakeEnv({ index: INDEX, origin: device(200, rollup) });
    expect(await callTool(env, "cyrano_tag_context", { tag: " BIO 201 ", limit: 5 })).toEqual({
      ok: true,
      ...rollup,
      source: "device",
      device: "Jo's MacBook",
      account: ACCOUNT,
    });
    expect(forwarded).toEqual([{
      method: "GET",
      path: "/tag_context",
      query: { tag: "BIO 201", limit: "5" },
      client: "Claude",
    }]);
    expect(indexReads()).toBe(0);

    // The device's own empty-rollup diagnosis comes through as its words.
    const empty = { day: rollup.day, sections: [], reason: "noStoredSessions", notice: "No sessions carry the tag \"Physics\"." };
    const none = fakeEnv({ origin: device(200, empty) });
    expect(await callTool(none.env, "cyrano_tag_context", { tag: "Physics" })).toMatchObject({ ok: true, ...empty });
  });

  it("hands over the tagged sessions from the index when the Mac can't build the rollup", async () => {
    const { env } = fakeEnv({ index: INDEX, origin: offline });
    const result = await callTool(env, "cyrano_tag_context", { tag: "#bio-201" });
    expect(result).toEqual({
      ok: false,
      reason: "device_unreachable",
      detail: expect.stringContaining("cyrano_get_session"),
      tag: "#bio-201",
      source: "index",
      sessions: [ROWS[0], ROWS[2], ROWS[3]],
      built_at: INDEX.built_at,
      account: ACCOUNT,
    });
    expect(result.detail).toMatch(/asleep or offline/);
    expect(result.detail).toMatch(/`stored`/);
    expect(result.detail).toMatch(/session by session, not from the distilled rollup/);

    // Bounded like the rollup, and says so the same way.
    const capped = await callTool(env, "cyrano_tag_context", { tag: "BIO 201", limit: 2 });
    expect(capped.sessions).toEqual([ROWS[0], ROWS[2]]);
    expect(capped).toMatchObject({ truncated: true, considered: 3 });

    const slowEnv = fakeEnv({ index: INDEX, origin: slow });
    expect(await callTool(slowEnv.env, "cyrano_tag_context", { tag: "café" })).toMatchObject({
      reason: "device_timed_out",
      detail: expect.stringContaining("Try once more"),
      sessions: [ROWS[2]],
    });
  });

  it("says why the fallback list is empty", async () => {
    const unknown = fakeEnv({ index: INDEX, origin: offline });
    expect(await callTool(unknown.env, "cyrano_tag_context", { tag: "Physics" })).toMatchObject({
      reason: "device_unreachable",
      sessions: [],
      detail: expect.stringContaining("No session in the index the Mac last published carries this tag"),
    });
    const noIndex = fakeEnv({ origin: offline });
    const result = await callTool(noIndex.env, "cyrano_tag_context", { tag: "BIO 201" });
    expect(result).toMatchObject({ reason: "device_unreachable", sessions: [] });
    expect(result.detail).toMatch(/No session index has been published/);
    expect(result).not.toHaveProperty("built_at");
  });

  it("validates tag_context arguments the way the local tool does", async () => {
    const { env, forwarded } = fakeEnv({ index: INDEX, origin: device(200, {}) });
    for (const args of [{}, { tag: "   " }, { tag: 42 }]) {
      expect(await callTool(env, "cyrano_tag_context", args)).toEqual({
        ok: false,
        reason: "missing_tag",
        detail: expect.stringContaining("cyrano_list_tags"),
        account: ACCOUNT,
      });
    }
    expect(forwarded).toEqual([]);

    // The limit is clamped into the device's 1…20, not refused; a value that
    // isn't a number is dropped so the device applies its default.
    expect(tagContextOriginQuery({ tag: "x", limit: 50 })).toEqual({ tag: "x", limit: "20" });
    expect(tagContextOriginQuery({ tag: "x", limit: 0 })).toEqual({ tag: "x", limit: "1" });
    expect(tagContextOriginQuery({ tag: "x", limit: -3 })).toEqual({ tag: "x", limit: "1" });
    expect(tagContextOriginQuery({ tag: "x", limit: 3.7 })).toEqual({ tag: "x", limit: "3" });
    expect(tagContextOriginQuery({ tag: "x", limit: "7" })).toEqual({ tag: "x", limit: "7" });
    for (const limit of ["abc", "", undefined, null, Number.NaN]) {
      expect(tagContextOriginQuery({ tag: "x", limit })).toEqual({ tag: "x" });
    }
    expect(tagContextOriginQuery({ tag: "y".repeat(200) })?.tag).toHaveLength(80);

    expect(tagContextTool.inputSchema.required).toEqual(["tag"]);
    expect(tagContextTool.inputSchema.properties.limit).toMatchObject({ minimum: 1, maximum: 20 });
    expect(listTagsTool.inputSchema.properties).toEqual({});
  });

  it("describes both tools for a remote client: read-only, and honest about the fallback", () => {
    for (const tool of [listTagsTool, tagContextTool]) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      // cyrano_today is a local-bridge tool; naming it here sends an
      // assistant after a tool it cannot call.
      expect(tool.description).not.toContain("cyrano_today");
    }
    expect(listTagsTool.description).toContain("`course`");
    expect(listTagsTool.description).toContain("`withheld`");
    expect(listTagsTool.description).toContain('`source: "index"`');
    expect(tagContextTool.description).toMatch(/`truncated`.*`considered`/);
    expect(tagContextTool.description).toContain("cyrano_get_session");
  });

  it("filters cyrano_list_sessions by a tag's name or slug", async () => {
    const { env } = fakeEnv({ index: INDEX });
    const all = await callTool(env, "cyrano_list_sessions");
    expect(all.sessions).toEqual(ROWS);
    expect(all).not.toHaveProperty("filtered");

    const ids = async (args: Record<string, unknown>) =>
      ((await callTool(env, "cyrano_list_sessions", args)).sessions as Array<{ id: string }>).map((s) => s.id);
    expect(await ids({ tag: "BIO 201" })).toEqual(["s4", "s2", "s1"]);
    expect(await ids({ tag: "bio-201" })).toEqual(["s4", "s2", "s1"]);
    expect(await ids({ tag: "#acme-corp" })).toEqual(["s3"]);
    expect(await ids({ tag: "ACME CORP" })).toEqual(["s3"]);
    expect(await ids({ tag: "cafe" })).toEqual(["s2"]);
    // The cap applies to what matched, not to the index before filtering.
    expect(await ids({ tag: "bio 201", limit: 2 })).toEqual(["s4", "s2"]);
    // A blank tag is no filter.
    expect(await ids({ tag: "  " })).toEqual(["s4", "s3", "s2", "s1", "s0"]);

    const filtered = await callTool(env, "cyrano_list_sessions", { tag: "BIO 201" });
    expect(filtered).toMatchObject({ filtered: true, built_at: INDEX.built_at, scope: "all" });
    expect(filtered).not.toHaveProperty("notice");

    // An empty filtered list must not read as "the user has no sessions".
    const miss = await callTool(env, "cyrano_list_sessions", { tag: "Physics" });
    expect(miss).toMatchObject({ sessions: [], filtered: true });
    expect(miss.notice).toMatch(/No session in the index carries the tag "Physics"/);
    expect(miss.notice).toMatch(/cyrano_list_tags/);

    const noIndex = fakeEnv({});
    expect((await callTool(noIndex.env, "cyrano_list_sessions", { tag: "BIO 201" })).notice)
      .toMatch(/No session index has been published/);

    expect(listSessionsTool.inputSchema.properties.tag.type).toBe("string");
    expect(listSessionsTool.inputSchema.properties.tag.description).toMatch(/cyrano_list_tags/);
  });

  it("registers both tools under context:read, and only there", async () => {
    const read = fakeEnv({ scope: "context:read" });
    const listed = (await rpc(read.env, "tools/list")).result?.tools?.map((t) => t.name);
    expect(listed).toEqual([
      "cyrano_get_live_context",
      "cyrano_workflow",
      "cyrano_list_sessions",
      "cyrano_get_session",
      "cyrano_list_tags",
      "cyrano_tag_context",
    ]);
    const unknown = await rpc(read.env, "tools/call", { name: "cyrano_today", arguments: {} });
    expect(unknown.error?.message).toContain("cyrano_list_tags, cyrano_tag_context");

    const write = fakeEnv({ scope: "context:write", origin: device(200, { tags: [], withheld: 0 }) });
    const writeListed = (await rpc(write.env, "tools/list")).result?.tools?.map((t) => t.name);
    expect(writeListed).toEqual(["cyrano_add_session_note", "cyrano_send_reply"]);
    const refused = await rpc(write.env, "tools/call", { name: "cyrano_list_tags", arguments: {} });
    expect(refused.error?.code).toBe(-32602);
    expect(write.forwarded).toEqual([]);

    const init = await rpc(read.env, "initialize", { protocolVersion: "2025-06-18" });
    const instructions = init.result?.instructions ?? "";
    expect(instructions).toContain("watch_notes");
    expect(instructions).toContain("cyrano_list_tags");
    expect(instructions).toContain("cyrano_tag_context");
  });
});

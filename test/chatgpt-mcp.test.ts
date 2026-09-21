// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { chatGPTMCPTesting } from "../src/chatgpt-mcp.js";
import { chatGPTRegistryTesting } from "../src/registry-do.js";

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

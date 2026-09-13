// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { messagesForAgent } from "../src/session-do.js";
import { isAgentContextRead } from "../src/index.js";
import { agentLabelFromUrl, forwardWithAgent } from "../src/auth.js";
import type { AgentDirectMessage } from "../src/types.js";

// Several agents can hold keys to the same account, and every one of them polls
// the same /agent/latest/context. Before addressing, a directed question went to
// all of them and whichever answered first won — so "which agent am I talking
// to?" had no answer, and connecting the same agent twice under two names made
// it worse. These pin the routing rule.

const msg = (id: string, target?: string): AgentDirectMessage => ({
  id,
  text: `q-${id}`,
  at: 1,
  answered: false,
  ...(target ? { target } : {}),
});

describe("messagesForAgent", () => {
  it("shows an addressed question only to its addressee", () => {
    const messages = [msg("a", "hermes"), msg("b", "second-claw")];
    expect(messagesForAgent(messages, "hermes").map((m) => m.id)).toEqual(["a"]);
    expect(messagesForAgent(messages, "second-claw").map((m) => m.id)).toEqual(["b"]);
  });

  it("shows an unaddressed question to everyone (pre-addressing behavior)", () => {
    const messages = [msg("a"), msg("b", "hermes")];
    expect(messagesForAgent(messages, "hermes").map((m) => m.id)).toEqual(["a", "b"]);
    expect(messagesForAgent(messages, "other").map((m) => m.id)).toEqual(["a"]);
  });

  it("gives an unlabeled caller only the unaddressed ones", () => {
    // A request that arrived without an agent label (an operator poking the DO
    // directly) must not inherit another agent's questions.
    const messages = [msg("a"), msg("b", "hermes")];
    expect(messagesForAgent(messages, null).map((m) => m.id)).toEqual(["a"]);
  });
});

describe("agent label forwarding", () => {
  it("round-trips the label index.ts attaches", () => {
    const forwarded = forwardWithAgent(new Request("https://x/agent/sessions/s1/context"), {
      identity: { kind: "operator" },
      label: "hermes claw",
      receivesContext: true,
    });
    expect(agentLabelFromUrl(new URL(forwarded.url))).toBe("hermes claw");
  });

  it("reads null when nothing attached one", () => {
    expect(agentLabelFromUrl(new URL("https://x/agent/sessions/s1/context"))).toBeNull();
  });
});

describe("isAgentContextRead", () => {
  const req = (method: string) => new Request("https://x", { method });

  it("is the context poll, on either route form", () => {
    expect(isAgentContextRead(req("GET"), "/context")).toBe(true);
  });

  it("is not the results push — a muted agent may still hand work back", () => {
    expect(isAgentContextRead(req("POST"), "/results")).toBe(false);
  });
});

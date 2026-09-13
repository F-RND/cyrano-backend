// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { RegistryDO } from "../src/registry-do.js";
import type { Env } from "../src/env.js";

// Same in-memory ctx trick as account-inbox-push.test.ts: validateChatGPTToken
// only reads/writes ctx.storage, so a Map is enough to drive the real handler.
class FakeStorage {
  readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.map) {
      if (key.startsWith(prefix)) out.set(key, value as T);
    }
    return out;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const RESOURCE = "https://cyrano.example/mcp";
const TOKEN = "cyrano_chatgpt_access_test";

async function seededRegistry(expiresAt: number) {
  const storage = new FakeStorage();
  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  } as unknown as DurableObjectState;
  const registry = new RegistryDO(ctx, {} as Env);

  const identity = { kind: "user" as const, userId: "u1" };
  const accessHash = await sha256Hex(TOKEN);
  const connectionId = "conn-1";
  storage.map.set(`chatgpt-access:${accessHash}`, {
    identity,
    connectionId,
    clientId: "cyrano_chatgpt_x.y",
    resource: RESOURCE,
    scope: "context:read context:write",
    expiresAt,
  });
  storage.map.set(`chatgpt-connection:user:u1:${connectionId}`, {
    id: connectionId,
    identity,
    label: "ChatGPT",
    clientId: "cyrano_chatgpt_x.y",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    accessHash,
    refreshHash: "refresh-hash",
  });
  return { registry, storage, accessKey: `chatgpt-access:${accessHash}` };
}

function validate(body: unknown): Request {
  return new Request("https://registry/_chatgpt/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("validateChatGPTToken", () => {
  it("validates a live token for the right resource", async () => {
    const { registry } = await seededRegistry(Date.now() + 60_000);

    const res = await registry.fetch(validate({ token: TOKEN, resource: RESOURCE }));

    expect(await res.json()).toMatchObject({ valid: true, kind: "user", user_id: "u1" });
  });

  // Expiry is the only reason to destroy the record. A mismatched audience is
  // "not valid here", not "revoke this connection" — deleting on mismatch means
  // one request to a second hostname (a custom domain beside workers.dev)
  // silently kills a working connection whose record still reads as active.
  it("refuses a token for the wrong resource WITHOUT deleting it", async () => {
    const { registry, storage, accessKey } = await seededRegistry(Date.now() + 60_000);

    const wrong = await registry.fetch(
      validate({ token: TOKEN, resource: "https://other.example/mcp" }),
    );

    expect(await wrong.json()).toMatchObject({ valid: false });
    expect(storage.map.has(accessKey)).toBe(true);

    // …and the token still works against its own resource afterwards.
    const right = await registry.fetch(validate({ token: TOKEN, resource: RESOURCE }));
    expect(await right.json()).toMatchObject({ valid: true });
  });

  it("deletes an expired token on validation", async () => {
    const { registry, storage, accessKey } = await seededRegistry(Date.now() - 1);

    const res = await registry.fetch(validate({ token: TOKEN, resource: RESOURCE }));

    expect(await res.json()).toMatchObject({ valid: false });
    expect(storage.map.has(accessKey)).toBe(false);
  });

  it("rejects an unknown token", async () => {
    const { registry } = await seededRegistry(Date.now() + 60_000);

    const res = await registry.fetch(validate({ token: "nope", resource: RESOURCE }));

    expect(await res.json()).toMatchObject({ valid: false });
  });
});

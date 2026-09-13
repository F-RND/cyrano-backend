// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { AccountInboxDO } from "../src/account-inbox-do.js";
import type { Env } from "../src/env.js";

// AccountInboxDO.handlePush only ever touches ctx.storage and
// ctx.getWebSockets(), so an in-memory pair of those is enough to exercise the
// real code path — no miniflare, same shape as the rest of the suite.
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

class FakeSocket {
  readonly sent: string[] = [];
  send(frame: string): void {
    this.sent.push(frame);
  }
}

function makeInbox(sockets: FakeSocket[] = []) {
  const storage = new FakeStorage();
  const ctx = { storage, getWebSockets: () => sockets } as unknown as DurableObjectState;
  return { inbox: new AccountInboxDO(ctx, {} as Env), storage, sockets };
}

function push(body: unknown): Request {
  return new Request("https://inbox/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("AccountInboxDO push idempotency", () => {
  it("delivers a first push to every connected socket", async () => {
    const socket = new FakeSocket();
    const { inbox, storage } = makeInbox([socket]);

    const res = await inbox.fetch(push({ text: "build finished", id: "run-42" }));

    expect(await res.json()).toMatchObject({ ok: true, id: "run-42", delivered: 1 });
    expect(socket.sent).toHaveLength(1);
    expect(storage.map.has("ping:run-42")).toBe(true);
  });

  // The bug this guards: overwriting `ping:<id>` kept storage at one entry, but
  // the fan-out ran again — so an agent retrying after a timeout buzzed the
  // user twice for one event.
  it("does not re-deliver a retried push with the same id", async () => {
    const socket = new FakeSocket();
    const { inbox, storage } = makeInbox([socket]);

    await inbox.fetch(push({ text: "build finished", id: "run-42" }));
    const retry = await inbox.fetch(push({ text: "build finished", id: "run-42" }));

    expect(await retry.json()).toMatchObject({ id: "run-42", delivered: 0, duplicate: true });
    expect(socket.sent).toHaveLength(1);
    expect([...storage.map.keys()].filter((k) => k.startsWith("ping:"))).toHaveLength(1);
  });

  it("treats distinct ids as distinct pings", async () => {
    const socket = new FakeSocket();
    const { inbox, storage } = makeInbox([socket]);

    await inbox.fetch(push({ text: "one", id: "run-1" }));
    await inbox.fetch(push({ text: "two", id: "run-2" }));

    expect(socket.sent).toHaveLength(2);
    expect([...storage.map.keys()].filter((k) => k.startsWith("ping:"))).toHaveLength(2);
  });

  it("mints an id when the agent supplies one that isn't a plain slug", async () => {
    const { inbox, storage } = makeInbox();

    const res = await inbox.fetch(push({ text: "hello", id: "not a slug/../.." }));
    const body = (await res.json()) as { id: string };

    expect(body.id).not.toBe("not a slug/../..");
    expect(storage.map.has(`ping:${body.id}`)).toBe(true);
  });

  it("mints an id when none is supplied, so two identical pushes both land", async () => {
    const socket = new FakeSocket();
    const { inbox } = makeInbox([socket]);

    await inbox.fetch(push({ text: "same text" }));
    await inbox.fetch(push({ text: "same text" }));

    expect(socket.sent).toHaveLength(2);
  });

  it("rejects an empty ping without touching storage", async () => {
    const { inbox, storage } = makeInbox();

    const res = await inbox.fetch(push({ text: "   " }));

    expect(res.status).toBe(400);
    expect(storage.map.size).toBe(0);
  });
});

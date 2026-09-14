// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { RegistryDO } from "../src/registry-do.js";
import type { Env } from "../src/env.js";

// Same in-memory ctx trick as chatgpt-token-validate.test.ts, plus `transaction`
// — appStoreLink is transactional (a rotation that half-applied would leave an
// identity with no usable token), and no existing fake implemented it.
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

  // Good enough for these tests: run the body against this same storage. It
  // does not model rollback, so it proves the happy path and the key layout,
  // not atomicity under failure.
  async transaction<T>(fn: (txn: FakeStorage) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function registry() {
  const storage = new FakeStorage();
  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  } as unknown as DurableObjectState;
  return { registry: new RegistryDO(ctx, {} as Env), storage };
}

function link(body: unknown): Request {
  return new Request("https://registry/_appstore_link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const OTID = "2000000012345";
const LABEL = `apple_${OTID}`;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("registry _appstore_link", () => {
  it("mints a tenant token and indexes it for lookup", async () => {
    const { registry: reg, storage } = registry();
    const res = await reg.fetch(
      link({ original_transaction_id: OTID, plan: "monthly", sub_status: "active" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user_id: string; rotated: boolean };

    expect(body.token).toMatch(/^cyrano_user_[0-9a-f]{48}$/);
    expect(body.rotated).toBe(false);

    const user = storage.map.get(`user:${LABEL}`) as Record<string, unknown>;
    expect(user).toMatchObject({ label: LABEL, plan: "monthly", subStatus: "active" });
    // Never the raw token on the record.
    expect(user.hash).toBe(await sha256Hex(body.token));
    expect(JSON.stringify(user)).not.toContain(body.token);

    // The three indexes auth and the notification path depend on.
    expect(storage.map.get(`user-id:${body.user_id}`)).toBe(LABEL);
    expect(storage.map.get(`user-hash:${await sha256Hex(body.token)}`)).toBe(LABEL);
    expect(storage.map.get(`user-subscription:apple:${OTID}`)).toBe(LABEL);
  });

  it("rotates on re-link and invalidates the previous token", async () => {
    // This is the case a restore on a second device hits: the client has no
    // token, only the receipt. It must come away with a working one.
    const { registry: reg, storage } = registry();
    const first = (await (await reg.fetch(link({ original_transaction_id: OTID, plan: "monthly" }))).json()) as {
      token: string;
      user_id: string;
    };
    const second = (await (await reg.fetch(link({ original_transaction_id: OTID, plan: "monthly" }))).json()) as {
      token: string;
      user_id: string;
      rotated: boolean;
    };

    expect(second.rotated).toBe(true);
    expect(second.token).not.toBe(first.token);
    // Same identity, so usage/history survive the rotation.
    expect(second.user_id).toBe(first.user_id);
    // The old secret no longer resolves.
    expect(storage.map.get(`user-hash:${await sha256Hex(first.token)}`)).toBeUndefined();
    expect(storage.map.get(`user-hash:${await sha256Hex(second.token)}`)).toBe(LABEL);
  });

  it("carries a plan change through on re-link but keeps prior fields when omitted", async () => {
    const { registry: reg, storage } = registry();
    await reg.fetch(link({ original_transaction_id: OTID, plan: "monthly", sub_status: "active" }));
    await reg.fetch(link({ original_transaction_id: OTID, plan: "annual" }));

    const user = storage.map.get(`user:${LABEL}`) as Record<string, unknown>;
    expect(user.plan).toBe("annual");
    expect(user.subStatus).toBe("active");
  });

  it("rejects a request with no transaction id", async () => {
    const { registry: reg } = registry();
    const res = await reg.fetch(link({ plan: "monthly" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "missing_transaction_id" });
  });

  it("keeps a sandbox purchase off the paying subscriber's identity", async () => {
    // TestFlight, App Review and any sandbox tester share the production
    // originalTransactionId space, and this route ROTATES. Without the split,
    // a reviewer's link would hand a real customer's tenant a new token and
    // silently 401 every device they own.
    const { registry: reg, storage } = registry();
    const paid = (await (
      await reg.fetch(link({ original_transaction_id: OTID, environment: "Production", plan: "annual" }))
    ).json()) as { token: string; user_id: string };
    const sandbox = (await (
      await reg.fetch(link({ original_transaction_id: OTID, environment: "Sandbox", plan: "monthly" }))
    ).json()) as { token: string; user_id: string; rotated: boolean };

    expect(sandbox.rotated).toBe(false);
    expect(sandbox.user_id).not.toBe(paid.user_id);
    // The paying customer's token still resolves, to the paying identity.
    expect(storage.map.get(`user-hash:${await sha256Hex(paid.token)}`)).toBe(LABEL);
    expect(storage.map.get(`user:${LABEL}`)).toMatchObject({ plan: "annual" });
    // And the sandbox tenant is a separate record under a separate index key.
    expect(storage.map.get(`user-subscription:apple:sandbox:${OTID}`)).toBe(`apple_sandbox_${OTID}`);
    expect(storage.map.get(`user:apple_sandbox_${OTID}`)).toMatchObject({ plan: "monthly" });
  });

  it("defaults a body with no environment to the production namespace", async () => {
    const { registry: reg, storage } = registry();
    await reg.fetch(link({ original_transaction_id: OTID, plan: "monthly" }));
    expect(storage.map.get(`user-subscription:apple:${OTID}`)).toBe(LABEL);
  });

  it("keeps Apple and Stripe records separate in the shared subscription index", async () => {
    // The namespaced id is what stops an Apple originalTransactionId from ever
    // resolving to a Stripe subscription's tenant, or vice versa.
    const { registry: reg, storage } = registry();
    await reg.fetch(link({ original_transaction_id: "sub_123", plan: "monthly" }));
    expect(storage.map.get("user-subscription:apple:sub_123")).toBe("apple_sub_123");
    expect(storage.map.get("user-subscription:sub_123")).toBeUndefined();
  });
});

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

type Linked = { token: string; user_id: string; relinked: boolean; active_tokens: number };

async function linkOnce(reg: RegistryDO, body: unknown): Promise<Linked> {
  return (await (await reg.fetch(link(body))).json()) as Linked;
}

/** What a bearer token resolves to on a real request (auth.ts resolveIdentity). */
async function resolve(reg: RegistryDO, token: string): Promise<{ valid: boolean; userId?: string }> {
  const res = await reg.fetch(
    new Request("https://registry/_validate_user", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  return (await res.json()) as { valid: boolean; userId?: string };
}

// Must match APPSTORE_TOKENS_PER_TENANT in registry-do.ts. The eviction test
// links CAP + 1 times; each link is one SHA-256 and a few map writes, so 31
// is still well under a second.
const CAP = 30;

function subscription(body: unknown): Request {
  return new Request("https://registry/_subscription", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type StoredUsage = {
  periodStart: number;
  spendMicros: number;
  lifetimeSpendMicros: number;
  legs: unknown[];
};

function usageOf(storage: FakeStorage): StoredUsage | undefined {
  return (storage.map.get(`user:${LABEL}`) as { usage?: StoredUsage }).usage;
}

/** Puts spend on the tenant's meter as a metered call would. */
function spend(storage: FakeStorage, micros: number): void {
  const user = storage.map.get(`user:${LABEL}`) as { usage: StoredUsage };
  user.usage = {
    ...user.usage,
    spendMicros: user.usage.spendMicros + micros,
    lifetimeSpendMicros: user.usage.lifetimeSpendMicros + micros,
    legs: [{ provider: "anthropic", model: "m", micros }],
  };
}

const PERIOD = Date.parse("2026-10-01T00:00:00Z");
const NEXT_PERIOD = Date.parse("2026-11-01T00:00:00Z");
const OLDER_PERIOD = Date.parse("2026-09-01T00:00:00Z");

describe("registry _appstore_link", () => {
  it("mints a tenant token and indexes it for lookup", async () => {
    const { registry: reg, storage } = registry();
    const res = await reg.fetch(
      link({ original_transaction_id: OTID, plan: "monthly", sub_status: "active" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Linked;

    expect(body.token).toMatch(/^cyrano_user_[0-9a-f]{48}$/);
    expect(body.relinked).toBe(false);
    expect(body.active_tokens).toBe(1);

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

  it("keeps the first device's token working when a second device links", async () => {
    // The bug this guards: a restore, a renewal re-provision or a launch with
    // no token on device B used to ROTATE the tenant's only token, so device
    // A read "Not recognised" on a paid subscription, and A's own re-link
    // then signed out B. Both must come away with a working token.
    const { registry: reg, storage } = registry();
    const deviceA = await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly" });
    const deviceB = await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly" });

    expect(deviceB.relinked).toBe(true);
    expect(deviceB.active_tokens).toBe(2);
    expect(deviceB.token).not.toBe(deviceA.token);
    // Same identity, so usage/history and entitlement stay per tenant.
    expect(deviceB.user_id).toBe(deviceA.user_id);

    // Both tokens resolve, to the same user.
    expect(await resolve(reg, deviceA.token)).toMatchObject({ valid: true, userId: deviceA.user_id });
    expect(await resolve(reg, deviceB.token)).toMatchObject({ valid: true, userId: deviceA.user_id });

    // Device A re-linking (its own renewal) does not sign B out either.
    const deviceAAgain = await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly" });
    expect(await resolve(reg, deviceB.token)).toMatchObject({ valid: true });
    expect(await resolve(reg, deviceAAgain.token)).toMatchObject({ valid: true });

    // One record, one subscription index entry: no per-device tenants.
    const users = [...storage.map.keys()].filter((k) => k.startsWith("user:"));
    expect(users).toEqual([`user:${LABEL}`]);
    // Still never a raw token on the record.
    const record = JSON.stringify(storage.map.get(`user:${LABEL}`));
    for (const t of [deviceA.token, deviceB.token, deviceAAgain.token]) expect(record).not.toContain(t);
  });

  it(`evicts the oldest token once a tenant holds ${CAP}`, async () => {
    const { registry: reg, storage } = registry();
    const tokens: string[] = [];
    for (let i = 0; i < CAP; i++) {
      tokens.push((await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly" })).token);
    }
    // At the cap, every one of them is live.
    for (const t of tokens) expect(await resolve(reg, t)).toMatchObject({ valid: true });

    const next = await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly" });
    expect(next.active_tokens).toBe(CAP);
    // The oldest is gone, index and all; everything newer still works.
    const [oldest = "", ...newer] = tokens;
    expect(await resolve(reg, oldest)).toEqual({ valid: false });
    expect(storage.map.get(`user-hash:${await sha256Hex(oldest)}`)).toBeUndefined();
    for (const t of [...newer, next.token]) expect(await resolve(reg, t)).toMatchObject({ valid: true });

    const user = storage.map.get(`user:${LABEL}`) as { hash: string; deviceHashes: string[] };
    expect(user.hash).toBe(await sha256Hex(next.token));
    expect(user.deviceHashes).toHaveLength(CAP - 1);
  });

  it("revoking the tenant kills every device's token", async () => {
    const { registry: reg, storage } = registry();
    const a = await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly" });
    const b = await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly" });

    const res = await reg.fetch(new Request(`https://registry/users/${LABEL}`, { method: "DELETE" }));
    expect(res.status).toBe(200);

    expect(await resolve(reg, a.token)).toEqual({ valid: false });
    expect(await resolve(reg, b.token)).toEqual({ valid: false });
    expect([...storage.map.keys()].filter((k) => k.startsWith("user-hash:"))).toEqual([]);
  });

  it("relinks a record stored before per-device tokens without a migration", async () => {
    // Every App Store tenant in production today has `hash` and no
    // `deviceHashes`. Its one live token must survive the first relink.
    const { registry: reg, storage } = registry();
    const legacyToken = "cyrano_user_legacy";
    const legacyHash = await sha256Hex(legacyToken);
    storage.map.set(`user:${LABEL}`, {
      userId: "legacy-user",
      label: LABEL,
      hash: legacyHash,
      createdAt: 1,
      plan: "annual",
      subStatus: "active",
      stripeSubscriptionId: `apple:${OTID}`,
    });
    storage.map.set("user-id:legacy-user", LABEL);
    storage.map.set(`user-hash:${legacyHash}`, LABEL);
    storage.map.set(`user-subscription:apple:${OTID}`, LABEL);

    const relink = await linkOnce(reg, { original_transaction_id: OTID, plan: "annual" });
    expect(relink).toMatchObject({ user_id: "legacy-user", relinked: true, active_tokens: 2 });
    expect(await resolve(reg, legacyToken)).toMatchObject({ valid: true, userId: "legacy-user" });
    expect(await resolve(reg, relink.token)).toMatchObject({ valid: true, userId: "legacy-user" });
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
    // originalTransactionId space, and a link rewrites the tenant's plan and
    // evicts its oldest token. Without the split, a reviewer's link would do
    // both to a real customer's tenant.
    const { registry: reg, storage } = registry();
    const paid = (await (
      await reg.fetch(link({ original_transaction_id: OTID, environment: "Production", plan: "annual" }))
    ).json()) as { token: string; user_id: string };
    const sandbox = (await (
      await reg.fetch(link({ original_transaction_id: OTID, environment: "Sandbox", plan: "monthly" }))
    ).json()) as Linked;

    expect(sandbox.relinked).toBe(false);
    // And sandbox keeps working: App Review buys in sandbox.
    expect(await resolve(reg, sandbox.token)).toMatchObject({ valid: true, userId: sandbox.user_id });
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

  it("namespaces Apple records in the subscription index", async () => {
    // The namespaced id is what stops an Apple originalTransactionId from ever
    // resolving to a record keyed on the same bare string.
    const { registry: reg, storage } = registry();
    await reg.fetch(link({ original_transaction_id: "sub_123", plan: "monthly" }));
    expect(storage.map.get("user-subscription:apple:sub_123")).toBe("apple_sub_123");
    expect(storage.map.get("user-subscription:sub_123")).toBeUndefined();
  });
});

// The Worker sends the transaction's purchaseDate as period_start on EVERY
// link (appstore.ts), and relinks are routine: each device on the Apple ID,
// each launch without a token, each renewal each device sees. Only a newer
// billing period may reset the meter; otherwise a second device coming online
// mid-period zeroes the tenant's spend, and so could a subscriber replaying
// their own signed transaction.
describe("registry _appstore_link usage period", () => {
  it("gives a fresh tenant a meter aligned to the billing period", async () => {
    const { registry: reg, storage } = registry();
    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: PERIOD });
    expect(usageOf(storage)).toMatchObject({ periodStart: PERIOD, spendMicros: 0, lifetimeSpendMicros: 0 });
  });

  it("keeps spend when another device relinks with the same period", async () => {
    const { registry: reg, storage } = registry();
    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: PERIOD });
    spend(storage, 5_000_000);

    const second = await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: PERIOD });
    expect(second.relinked).toBe(true);
    expect(usageOf(storage)).toMatchObject({ periodStart: PERIOD, spendMicros: 5_000_000, lifetimeSpendMicros: 5_000_000 });
    expect(usageOf(storage)?.legs).toHaveLength(1);
  });

  it("keeps spend when a relink carries an older period", async () => {
    // A device replaying a stale transaction, or one that was offline over a
    // renewal and links with what it last saw.
    const { registry: reg, storage } = registry();
    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: PERIOD });
    spend(storage, 5_000_000);

    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: OLDER_PERIOD });
    expect(usageOf(storage)).toMatchObject({ periodStart: PERIOD, spendMicros: 5_000_000 });
  });

  it("resets spend and keeps the lifetime total on a newer period", async () => {
    const { registry: reg, storage } = registry();
    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: PERIOD });
    spend(storage, 5_000_000);

    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: NEXT_PERIOD });
    expect(usageOf(storage)).toMatchObject({
      periodStart: NEXT_PERIOD,
      spendMicros: 0,
      lifetimeSpendMicros: 5_000_000,
      legs: [],
    });
  });

  it("leaves the meter alone when the link carries no period", async () => {
    const { registry: reg, storage } = registry();
    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: PERIOD });
    spend(storage, 5_000_000);

    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly" });
    expect(usageOf(storage)).toMatchObject({ periodStart: PERIOD, spendMicros: 5_000_000 });
  });
});

// The notification path writes through the same subscription index and used
// to realign on every period_start too; a late or duplicated notification
// must not zero a period that is already under way.
describe("registry _subscription usage period", () => {
  const SUB = `apple:${OTID}`;

  async function notify(reg: RegistryDO, body: Record<string, unknown>) {
    const res = await reg.fetch(subscription({ stripe_subscription_id: SUB, ...body }));
    return (await res.json()) as { found: boolean };
  }

  it("keeps spend on a replayed notification for the current period", async () => {
    const { registry: reg, storage } = registry();
    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: PERIOD });
    spend(storage, 5_000_000);

    expect(await notify(reg, { sub_status: "active", period_start: PERIOD })).toEqual(
      expect.objectContaining({ found: true }),
    );
    expect(usageOf(storage)).toMatchObject({ periodStart: PERIOD, spendMicros: 5_000_000 });
  });

  it("keeps spend on a notification for an older period", async () => {
    const { registry: reg, storage } = registry();
    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: PERIOD });
    spend(storage, 5_000_000);

    await notify(reg, { sub_status: "active", period_start: OLDER_PERIOD });
    expect(usageOf(storage)).toMatchObject({ periodStart: PERIOD, spendMicros: 5_000_000 });
  });

  it("resets spend on a renewal and keeps the lifetime total", async () => {
    const { registry: reg, storage } = registry();
    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly", period_start: PERIOD });
    spend(storage, 5_000_000);

    await notify(reg, { sub_status: "active", period_start: NEXT_PERIOD, period_end: NEXT_PERIOD + 30 * 86_400_000 });
    expect(usageOf(storage)).toMatchObject({
      periodStart: NEXT_PERIOD,
      spendMicros: 0,
      lifetimeSpendMicros: 5_000_000,
    });
  });

  it("aligns a tenant that has no meter yet", async () => {
    const { registry: reg, storage } = registry();
    await linkOnce(reg, { original_transaction_id: OTID, plan: "monthly" });
    expect(usageOf(storage)).toBeUndefined();

    await notify(reg, { sub_status: "active", period_start: PERIOD });
    expect(usageOf(storage)).toMatchObject({ periodStart: PERIOD, spendMicros: 0 });
  });
});

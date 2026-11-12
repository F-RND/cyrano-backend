// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  ipPrefixForRateLimit,
  MAX_TERMS_BODY_BYTES,
  MAX_TERMS_FACT_CHARS,
  MIN_ACCEPTED_AT_MS,
  sanitizeTermsAcceptance,
  TERMS_GLOBAL_LIMIT_PER_DAY,
  TERMS_LIST_MAX_PAGES,
  TERMS_RATE_LIMIT_PER_DAY,
  termsAcceptanceKey,
  termsDebugFilter,
  termsFingerprintIndexKey,
  termsGlobalKey,
  termsRateLimitKey,
  termsTimeIndexKey,
  type StoredTermsAcceptance,
} from "../src/terms.js";
import { RegistryDO } from "../src/registry-do.js";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const INSTALL = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const OTHER = "11111111-2222-4333-8444-555555555555";
const FINGERPRINT = "a".repeat(64);

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    install_id: INSTALL,
    terms_version: 1,
    accepted_at_ms: NOW - 5_000,
    platform: "ios",
    channel: "app_store",
    app_version: "1.0.239",
    ...overrides,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The rate-limit bucket hash the registry derives for a connecting IP. */
async function clientHash(ip: string): Promise<string> {
  return (await sha256Hex(ipPrefixForRateLimit(ip))).slice(0, 16);
}

describe("sanitizeTermsAcceptance", () => {
  it("keeps a well-formed acceptance", () => {
    expect(sanitizeTermsAcceptance(body(), NOW)).toEqual({
      install_id: INSTALL,
      terms_version: 1,
      accepted_at_ms: NOW - 5_000,
      platform: "ios",
      channel: "app_store",
      app_version: "1.0.239",
      debug: false,
      fingerprint: null,
    });
  });

  it("normalizes the install id's case", () => {
    expect(sanitizeTermsAcceptance(body({ install_id: INSTALL.toUpperCase() }), NOW)?.install_id).toBe(INSTALL);
  });

  it.each([
    ["no install id", { install_id: undefined }],
    ["a non-UUID install id", { install_id: "not-a-uuid" }],
    ["a zero revision", { terms_version: 0 }],
    ["a fractional revision", { terms_version: 1.5 }],
    ["a string revision", { terms_version: "1" }],
  ])("refuses %s", (_label, overrides) => {
    expect(sanitizeTermsAcceptance(body(overrides), NOW)).toBeNull();
  });

  // The client takes a 400 as final, so a value the server has not heard of
  // yet must still be kept, just under a name that says so.
  it.each([
    ["an unknown platform", { platform: "android" }, { platform: "other", channel: "app_store" }],
    ["an unknown channel", { channel: "sideload" }, { platform: "ios", channel: "other" }],
    ["a missing platform", { platform: undefined }, { platform: "other", channel: "app_store" }],
    ["a non-string channel", { channel: 3 }, { platform: "ios", channel: "other" }],
  ])("stores %s as other", (_label, overrides, expected) => {
    expect(sanitizeTermsAcceptance(body(overrides), NOW)).toMatchObject(expected);
  });

  it("keeps a platform/channel pair that disagrees, as sent", () => {
    expect(sanitizeTermsAcceptance(body({ platform: "macos", channel: "app_store" }), NOW)).toMatchObject({
      platform: "macos",
      channel: "app_store",
    });
    expect(sanitizeTermsAcceptance(body({ platform: "ios", channel: "developer_id" }), NOW)).toMatchObject({
      platform: "ios",
      channel: "developer_id",
    });
  });

  it("refuses non-object bodies", () => {
    expect(sanitizeTermsAcceptance(null, NOW)).toBeNull();
    expect(sanitizeTermsAcceptance([body()], NOW)).toBeNull();
    expect(sanitizeTermsAcceptance("accept", NOW)).toBeNull();
  });

  it("drops an implausible device time but keeps the record", () => {
    expect(sanitizeTermsAcceptance(body({ accepted_at_ms: MIN_ACCEPTED_AT_MS - 1 }), NOW)?.accepted_at_ms).toBeNull();
    expect(sanitizeTermsAcceptance(body({ accepted_at_ms: NOW + 2 * 86_400_000 }), NOW)?.accepted_at_ms).toBeNull();
    expect(sanitizeTermsAcceptance(body({ accepted_at_ms: "yesterday" }), NOW)?.accepted_at_ms).toBeNull();
  });

  it("clamps the app version", () => {
    const long = "9".repeat(MAX_TERMS_FACT_CHARS + 10);
    expect(sanitizeTermsAcceptance(body({ app_version: long }), NOW)?.app_version).toHaveLength(MAX_TERMS_FACT_CHARS);
  });

  it("takes a fingerprint only from the Developer ID build", () => {
    const mac = sanitizeTermsAcceptance(
      body({ platform: "macos", channel: "developer_id", fingerprint: FINGERPRINT }),
      NOW,
    );
    expect(mac?.fingerprint).toBe(FINGERPRINT);
    const mas = sanitizeTermsAcceptance(
      body({ platform: "macos", channel: "mac_app_store", fingerprint: FINGERPRINT }),
      NOW,
    );
    expect(mas?.fingerprint).toBeNull();
    expect(sanitizeTermsAcceptance(body({ fingerprint: FINGERPRINT }), NOW)?.fingerprint).toBeNull();
    const malformed = sanitizeTermsAcceptance(
      body({ platform: "macos", channel: "developer_id", fingerprint: "xyz" }),
      NOW,
    );
    expect(malformed?.fingerprint).toBeNull();
  });

  it("reads debug only as a literal true", () => {
    expect(sanitizeTermsAcceptance(body({ debug: true }), NOW)?.debug).toBe(true);
    expect(sanitizeTermsAcceptance(body({ debug: "true" }), NOW)?.debug).toBe(false);
  });
});

describe("terms keys", () => {
  it("groups an install's revisions under one prefix, in order", () => {
    expect(termsAcceptanceKey(INSTALL, 2)).toBe(`terms:${INSTALL}:00002`);
    expect(termsAcceptanceKey(INSTALL, 10) > termsAcceptanceKey(INSTALL, 9)).toBe(true);
  });

  it("puts the day first in the counter keys", () => {
    expect(termsRateLimitKey("abc", NOW)).toBe("terms-rl:2026-11-11:abc");
    expect(termsGlobalKey(NOW)).toBe("terms-global:2026-11-11");
  });

  it("builds index keys that sort as their numbers do", () => {
    expect(termsFingerprintIndexKey(FINGERPRINT, 3, INSTALL)).toBe(`terms-fp:${FINGERPRINT}:00003:${INSTALL}`);
    expect(termsTimeIndexKey(NOW, INSTALL, 1)).toBe(`terms-t:0${NOW}:${INSTALL}:00001`);
    expect(termsTimeIndexKey(NOW + 1, INSTALL, 1) > termsTimeIndexKey(NOW, OTHER, 9)).toBe(true);
  });

  it("parses the debug filter", () => {
    expect(termsDebugFilter(null)).toBeUndefined();
    expect(termsDebugFilter("true")).toBe(true);
    expect(termsDebugFilter("FALSE")).toBe(false);
    expect(termsDebugFilter("yes")).toBeNull();
  });
});

describe("ipPrefixForRateLimit", () => {
  it("keeps IPv4 to its /24", () => {
    expect(ipPrefixForRateLimit("203.0.113.7")).toBe("203.0.113.0/24");
    expect(ipPrefixForRateLimit("203.0.113.200")).toBe("203.0.113.0/24");
    expect(ipPrefixForRateLimit("203.0.114.7")).toBe("203.0.114.0/24");
  });

  it("keeps IPv6 to its /48", () => {
    expect(ipPrefixForRateLimit("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1::/48");
    expect(ipPrefixForRateLimit("2001:DB8:1::9")).toBe("2001:db8:1::/48");
    expect(ipPrefixForRateLimit("2001:db8:2::9")).toBe("2001:db8:2::/48");
    expect(ipPrefixForRateLimit("::1")).toBe("0:0:0::/48");
    // IPv4-mapped: bucket by the embedded /24, not one shared /48.
    expect(ipPrefixForRateLimit("::ffff:203.0.113.7")).toBe("203.0.113.0/24");
    expect(ipPrefixForRateLimit("::ffff:cb00:7107")).toBe("203.0.113.0/24");
    expect(ipPrefixForRateLimit("fe80::1%en0")).toBe("fe80:0:0::/48");
  });

  it("is unknown for a missing or malformed address", () => {
    expect(ipPrefixForRateLimit(null)).toBe("unknown");
    expect(ipPrefixForRateLimit("")).toBe("unknown");
    expect(ipPrefixForRateLimit("   ")).toBe("unknown");
    expect(ipPrefixForRateLimit("203.0.113")).toBe("unknown");
    expect(ipPrefixForRateLimit("203.0.113.999")).toBe("unknown");
    expect(ipPrefixForRateLimit("2001:db8::1::2")).toBe("unknown");
    expect(ipPrefixForRateLimit("2001:db8:1:2:3:4:5:6:7")).toBe("unknown");
    expect(ipPrefixForRateLimit("2001:dbg::1")).toBe("unknown");
    expect(ipPrefixForRateLimit("not an ip")).toBe("unknown");
  });
});

type ListOptions = { prefix?: string; start?: string; end?: string; reverse?: boolean; limit?: number };

/** Enough of DurableObjectStorage for the terms handlers: list with
 * prefix/start/end/reverse/limit over sorted keys, get of a key array, put of
 * an object, and transaction(). Every operation yields a full turn of the
 * event loop (setImmediate, not a microtask: the handler's Web Crypto work
 * resolves off the microtask queue, so a microtask yield would still let one
 * handler finish before the other began) so two handlers in flight interleave
 * the way real I/O lets them; transaction() is a mutex over the whole store,
 * so a handler that does its check and its write inside one is serialized
 * against another, and a handler that does not is racing. A call log records
 * what was listed, for the index tests. */
class FakeStorage {
  readonly map = new Map<string, unknown>();
  readonly calls: Array<{ op: string; args: unknown }> = [];
  private lock: Promise<void> = Promise.resolve();

  private sortedKeys(): string[] {
    return [...this.map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  private readRaw<T>(key: string): T | undefined;
  private readRaw<T>(key: string[]): Map<string, T>;
  private readRaw<T>(key: string | string[]): T | undefined | Map<string, T> {
    if (Array.isArray(key)) {
      const out = new Map<string, T>();
      for (const k of key) if (this.map.has(k)) out.set(k, this.map.get(k) as T);
      return out;
    }
    return this.map.get(key) as T | undefined;
  }

  private writeRaw(keyOrEntries: string | Record<string, unknown>, value?: unknown): void {
    if (typeof keyOrEntries === "string") {
      this.map.set(keyOrEntries, value);
      return;
    }
    for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, v);
  }

  private deleteRaw(keys: string | string[]): number {
    let n = 0;
    for (const key of Array.isArray(keys) ? keys : [keys]) if (this.map.delete(key)) n += 1;
    return n;
  }

  private listRaw<T>(options: ListOptions): Map<string, T> {
    this.calls.push({ op: "list", args: options });
    let keys = this.sortedKeys().filter((key) => {
      if (options.prefix !== undefined && !key.startsWith(options.prefix)) return false;
      if (options.start !== undefined && key < options.start) return false;
      if (options.end !== undefined && key >= options.end) return false;
      return true;
    });
    if (options.reverse) keys = keys.reverse();
    if (options.limit !== undefined) keys = keys.slice(0, options.limit);
    const out = new Map<string, T>();
    for (const key of keys) out.set(key, this.map.get(key) as T);
    return out;
  }

  private static turn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(key: string[]): Promise<Map<string, T>>;
  async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
    await FakeStorage.turn();
    return Array.isArray(key) ? this.readRaw<T>(key) : this.readRaw<T>(key);
  }
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    await FakeStorage.turn();
    this.writeRaw(keyOrEntries, value);
  }
  async delete(keys: string | string[]): Promise<number> {
    await FakeStorage.turn();
    return this.deleteRaw(keys);
  }
  async list<T>(options: ListOptions = {}): Promise<Map<string, T>> {
    await FakeStorage.turn();
    return this.listRaw<T>(options);
  }

  async transaction<T>(fn: (txn: FakeStorage) => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      // Operations inside the transaction still yield, so a non-transactional
      // competitor gets every chance to slip in between them.
      return await fn(this);
    } finally {
      release();
    }
  }
}

function makeRegistry() {
  const storage = new FakeStorage();
  const ctx = {
    storage,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    waitUntil: () => {},
  } as unknown as DurableObjectState;
  return { registry: new RegistryDO(ctx, {} as Env), storage };
}

function submit(payload: unknown, ip = "203.0.113.7"): Request {
  return new Request("https://registry/_terms", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(payload),
  });
}

function acceptanceRows(storage: FakeStorage): StoredTermsAcceptance[] {
  return [...storage.map]
    .filter(([key]) => key.startsWith("terms:"))
    .map(([, value]) => value as StoredTermsAcceptance);
}

function keysWithPrefix(storage: FakeStorage, prefix: string): string[] {
  return [...storage.map.keys()].filter((key) => key.startsWith(prefix));
}

async function read(registry: RegistryDO, query = ""): Promise<{ acceptances: StoredTermsAcceptance[]; total: number }> {
  const response = await registry.fetch(new Request(`https://registry/_terms${query}`));
  expect(response.status).toBe(200);
  return (await response.json()) as { acceptances: StoredTermsAcceptance[]; total: number };
}

describe("RegistryDO /_terms", () => {
  it("stores an acceptance with the server's receipt time and no IP", async () => {
    const { registry, storage } = makeRegistry();
    const response = await registry.fetch(submit(body({ accepted_at_ms: Date.now() - 1_000 })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, recorded: true });

    const [row] = acceptanceRows(storage);
    expect(row).toMatchObject({ install_id: INSTALL, terms_version: 1, channel: "app_store", fingerprint_hash: null });
    expect(typeof row!.received_at_ms).toBe("number");
    expect(JSON.stringify([...storage.map.values()])).not.toContain("203.0.113.7");
  });

  it("writes the time index with the record, and the fingerprint index only when there is one", async () => {
    const { registry, storage } = makeRegistry();
    await registry.fetch(submit(body()));
    const [row] = acceptanceRows(storage);
    expect(storage.map.get(termsTimeIndexKey(row!.received_at_ms, INSTALL, 1))).toBe(termsAcceptanceKey(INSTALL, 1));
    expect(keysWithPrefix(storage, "terms-fp:")).toEqual([]);

    await registry.fetch(submit(body({ install_id: OTHER, platform: "macos", channel: "developer_id", fingerprint: FINGERPRINT })));
    const hash = await sha256Hex(FINGERPRINT);
    expect(storage.map.get(termsFingerprintIndexKey(hash, 1, OTHER))).toBe(termsAcceptanceKey(OTHER, 1));
    expect(keysWithPrefix(storage, "terms-t:")).toHaveLength(2);
  });

  it("keeps the first acceptance of a revision", async () => {
    const { registry, storage } = makeRegistry();
    const first = Date.now() - 60_000;
    await registry.fetch(submit(body({ accepted_at_ms: first })));
    const again = await registry.fetch(submit(body({ accepted_at_ms: Date.now() })));
    expect(await again.json()).toEqual({ ok: true, recorded: false });
    const rows = acceptanceRows(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accepted_at_ms).toBe(first);
    // A repeat is not a new acceptance: the counters are untouched.
    expect(storage.map.get(termsRateLimitKey(await clientHash("203.0.113.7"), Date.now()))).toBe(1);
    expect(storage.map.get(termsGlobalKey(Date.now()))).toBe(1);

    await registry.fetch(submit(body({ terms_version: 2 })));
    expect(acceptanceRows(storage)).toHaveLength(2);
  });

  it("lets exactly one of two concurrent identical submits record", async () => {
    const { registry, storage } = makeRegistry();
    const first = Date.now() - 60_000;
    const [a, b] = await Promise.all([
      registry.fetch(submit(body({ accepted_at_ms: first }))),
      registry.fetch(submit(body({ accepted_at_ms: first + 1 }))),
    ]);
    const outcomes = [await a.json(), await b.json()] as Array<{ recorded: boolean }>;
    expect(outcomes.filter((o) => o.recorded)).toHaveLength(1);
    const rows = acceptanceRows(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accepted_at_ms).toBe(first);
    expect(keysWithPrefix(storage, "terms-t:")).toHaveLength(1);
    expect(storage.map.get(termsGlobalKey(Date.now()))).toBe(1);
  });

  it("stores the Developer ID fingerprint only as the trial-key hash", async () => {
    const { registry, storage } = makeRegistry();
    await registry.fetch(submit(body({ platform: "macos", channel: "developer_id", fingerprint: FINGERPRINT })));
    const [row] = acceptanceRows(storage);
    expect(row!.fingerprint_hash).toBe(await sha256Hex(FINGERPRINT));
    expect(JSON.stringify(row)).not.toContain(FINGERPRINT);
  });

  it("records an unknown channel or platform as other, and still refuses a bad install id", async () => {
    const { registry, storage } = makeRegistry();
    expect((await registry.fetch(submit(body({ channel: "visionos_store", platform: "visionos" })))).status).toBe(200);
    expect(acceptanceRows(storage)[0]).toMatchObject({ platform: "other", channel: "other", app_version: "1.0.239" });
    expect((await registry.fetch(submit(body({ install_id: "nope" })))).status).toBe(400);
    expect(acceptanceRows(storage)).toHaveLength(1);
  });

  it("refuses malformed and oversized bodies", async () => {
    const { registry } = makeRegistry();
    const notJSON = new Request("https://registry/_terms", { method: "POST", body: "{" });
    expect((await registry.fetch(notJSON)).status).toBe(400);
    const huge = new Request("https://registry/_terms", { method: "POST", body: "x".repeat(5_000) });
    expect((await registry.fetch(huge)).status).toBe(413);
  });

  it("caps new acceptances per client per day", async () => {
    const { registry, storage } = makeRegistry();
    const now = Date.now();
    storage.map.set(termsRateLimitKey(await clientHash("198.51.100.9"), now), TERMS_RATE_LIMIT_PER_DAY);
    const response = await registry.fetch(submit(body(), "198.51.100.9"));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(acceptanceRows(storage)).toHaveLength(0);
    // Another network is unaffected.
    expect((await registry.fetch(submit(body(), "192.0.2.1"))).status).toBe(200);
  });

  it("buckets by network prefix: one /24 or /48 shares a counter, the next does not", async () => {
    const { registry, storage } = makeRegistry();
    const now = Date.now();
    await registry.fetch(submit(body(), "198.51.100.9"));
    await registry.fetch(submit(body({ install_id: OTHER }), "198.51.100.200"));
    expect(storage.map.get(termsRateLimitKey(await clientHash("198.51.100.9"), now))).toBe(2);
    await registry.fetch(submit(body({ terms_version: 2 }), "198.51.101.9"));
    expect(storage.map.get(termsRateLimitKey(await clientHash("198.51.101.9"), now))).toBe(1);

    await registry.fetch(submit(body({ terms_version: 3 }), "2001:db8:1::1"));
    await registry.fetch(submit(body({ terms_version: 4 }), "2001:db8:1:ffff::1"));
    expect(storage.map.get(termsRateLimitKey(await clientHash("2001:db8:1::1"), now))).toBe(2);
    await registry.fetch(submit(body({ terms_version: 5 }), "2001:db8:2::1"));
    expect(storage.map.get(termsRateLimitKey(await clientHash("2001:db8:2::1"), now))).toBe(1);

    // No header at all lands in the shared "unknown" bucket, never a crash.
    const headerless = new Request("https://registry/_terms", { method: "POST", body: JSON.stringify(body({ terms_version: 6 })) });
    expect((await registry.fetch(headerless)).status).toBe(200);
    expect(storage.map.get(termsRateLimitKey((await sha256Hex("unknown")).slice(0, 16), now))).toBe(1);
    expect(JSON.stringify([...storage.map.keys()])).not.toContain((await sha256Hex("198.51.100.9")).slice(0, 16));
  });

  it("prunes stale counter buckets by range, bounded, leaving today's alone", async () => {
    const { registry, storage } = makeRegistry();
    const now = Date.now();
    const todayKey = termsRateLimitKey("someoneelse", now);
    storage.map.set(todayKey, 5);
    for (let i = 0; i < 200; i += 1) {
      storage.map.set(termsRateLimitKey(`h${String(i).padStart(3, "0")}`, Date.UTC(2020, 0, 1 + (i % 28))), 3);
    }
    storage.map.set(termsGlobalKey(Date.UTC(2020, 0, 1)), 7);
    storage.map.set(termsGlobalKey(now), 7);

    expect((await registry.fetch(submit(body()))).status).toBe(200);

    const rlLists = storage.calls.filter(
      (c) => c.op === "list" && (c.args as ListOptions).start === "terms-rl:",
    );
    expect(rlLists).toHaveLength(1);
    expect(rlLists[0]!.args).toEqual({ start: "terms-rl:", end: termsRateLimitKey("", now), limit: 128 });
    expect(storage.calls.some((c) => c.op === "list" && (c.args as ListOptions).prefix === "terms-rl:")).toBe(false);

    const staleLeft = keysWithPrefix(storage, "terms-rl:2020-");
    expect(staleLeft).toHaveLength(200 - 128);
    expect(storage.map.get(todayKey)).toBe(5);
    expect(storage.map.has(termsGlobalKey(Date.UTC(2020, 0, 1)))).toBe(false);
    expect(storage.map.get(termsGlobalKey(now))).toBe(8);

    // The next recorded acceptance takes the rest.
    await registry.fetch(submit(body({ terms_version: 2 })));
    expect(keysWithPrefix(storage, "terms-rl:2020-")).toHaveLength(0);
  });

  it("refuses new acceptances once the day's global ceiling is reached", async () => {
    const { registry, storage } = makeRegistry();
    storage.map.set(termsGlobalKey(Date.now()), TERMS_GLOBAL_LIMIT_PER_DAY);
    const response = await registry.fetch(submit(body()));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(acceptanceRows(storage)).toHaveLength(0);
    expect(storage.map.get(termsGlobalKey(Date.now()))).toBe(TERMS_GLOBAL_LIMIT_PER_DAY);
    // A repeat of something already recorded is still acknowledged.
    storage.map.set(termsAcceptanceKey(INSTALL, 1), { install_id: INSTALL });
    expect(await (await registry.fetch(submit(body()))).json()).toEqual({ ok: true, recorded: false });
  });

  describe("operator read", () => {
    async function seeded() {
      const made = makeRegistry();
      const { registry, storage } = made;
      await registry.fetch(submit(body({ debug: true })));
      await registry.fetch(
        submit(body({ install_id: OTHER, platform: "macos", channel: "developer_id", fingerprint: FINGERPRINT })),
      );
      // Receipt times come from Date.now(); push the second record clearly
      // after the first so "newest first" is unambiguous.
      const second = storage.map.get(termsAcceptanceKey(OTHER, 1)) as StoredTermsAcceptance;
      const bumped = { ...second, received_at_ms: second.received_at_ms + 10_000 };
      storage.map.delete(termsTimeIndexKey(second.received_at_ms, OTHER, 1));
      storage.map.set(termsAcceptanceKey(OTHER, 1), bumped);
      storage.map.set(termsTimeIndexKey(bumped.received_at_ms, OTHER, 1), termsAcceptanceKey(OTHER, 1));
      storage.calls.length = 0;
      return made;
    }

    it("lists newest first through the time index, bounded by limit", async () => {
      const { registry, storage } = await seeded();
      const all = await read(registry);
      expect(all.acceptances.map((row) => row.install_id)).toEqual([OTHER, INSTALL]);
      expect(all.total).toBe(2);
      expect(storage.calls).toContainEqual({ op: "list", args: { prefix: "terms-t:", reverse: true, limit: 200 } });
      expect(storage.calls.some((c) => (c.args as ListOptions).prefix === "terms:")).toBe(false);

      storage.calls.length = 0;
      const one = await read(registry, "?limit=1");
      expect(one.acceptances.map((row) => row.install_id)).toEqual([OTHER]);
      expect(one.total).toBe(1);
      expect(storage.calls).toContainEqual({ op: "list", args: { prefix: "terms-t:", reverse: true, limit: 1 } });
    });

    it("filters by install id with a prefix list on its records", async () => {
      const { registry, storage } = await seeded();
      const one = await read(registry, `?install_id=${INSTALL}`);
      expect(one.acceptances.map((row) => row.install_id)).toEqual([INSTALL]);
      expect(storage.calls).toContainEqual({ op: "list", args: { prefix: `terms:${INSTALL}:` } });
      expect((await registry.fetch(new Request("https://registry/_terms?install_id=bad"))).status).toBe(400);
    });

    it("finds a machine through the fingerprint index, not a scan", async () => {
      const { registry, storage } = await seeded();
      const hash = await sha256Hex(FINGERPRINT);
      const byMachine = await read(registry, `?fingerprint_hash=${hash}`);
      expect(byMachine.acceptances.map((row) => row.install_id)).toEqual([OTHER]);
      const lists = storage.calls.filter((c) => c.op === "list").map((c) => c.args as ListOptions);
      expect(lists).toEqual([{ prefix: `terms-fp:${hash}:` }]);
      expect((await registry.fetch(new Request("https://registry/_terms?fingerprint_hash=zz"))).status).toBe(400);
      expect((await read(registry, `?fingerprint_hash=${"b".repeat(64)}`)).acceptances).toEqual([]);
    });

    it("pages the time index past a run of debug rows, bounded", async () => {
      const { registry, storage } = makeRegistry();
      // Three production rows, then twelve debug rows on top of them.
      const ids: string[] = [];
      for (let i = 0; i < 15; i += 1) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
        ids.push(id);
        await registry.fetch(submit(body({ install_id: id, debug: i >= 3 })));
        // Receipt times come from Date.now(); spread them so the order is fixed.
        const row = storage.map.get(termsAcceptanceKey(id, 1)) as StoredTermsAcceptance;
        const bumped = { ...row, received_at_ms: NOW + i * 1_000 };
        storage.map.delete(termsTimeIndexKey(row.received_at_ms, id, 1));
        storage.map.set(termsAcceptanceKey(id, 1), bumped);
        storage.map.set(termsTimeIndexKey(bumped.received_at_ms, id, 1), termsAcceptanceKey(id, 1));
      }
      storage.calls.length = 0;
      const prod = await read(registry, "?debug=false&limit=5");
      expect(prod.acceptances.map((row) => row.install_id)).toEqual([ids[2], ids[1], ids[0]]);
      const lists = storage.calls.filter((c) => c.op === "list").map((c) => c.args as ListOptions);
      // Slices of `limit`, each bounded below by the previous slice's last
      // key; three full slices, then an empty one says the index is done.
      expect(lists).toHaveLength(4);
      expect(lists[0]).toEqual({ prefix: "terms-t:", reverse: true, limit: 5 });
      expect(lists[1]!.end).toBe(termsTimeIndexKey(NOW + 10_000, ids[10]!, 1));
      expect(lists[2]!.end).toBe(termsTimeIndexKey(NOW + 5_000, ids[5]!, 1));
      expect(lists[3]!.end).toBe(termsTimeIndexKey(NOW, ids[0]!, 1));

      // Enough matches in the first slice: one list, no more.
      storage.calls.length = 0;
      const dbg = await read(registry, "?debug=true&limit=5");
      expect(dbg.acceptances).toHaveLength(5);
      expect(storage.calls.filter((c) => c.op === "list")).toHaveLength(1);

      // The ceiling holds when nothing matches: TERMS_LIST_MAX_PAGES slices and out.
      storage.calls.length = 0;
      const none = await read(registry, "?debug=false&limit=2");
      expect(none.acceptances.map((row) => row.install_id)).toEqual([]);
      expect(storage.calls.filter((c) => c.op === "list")).toHaveLength(TERMS_LIST_MAX_PAGES);
    });

    it("keeps two installs on one machine apart in the fingerprint index", async () => {
      const { registry, storage } = makeRegistry();
      const mac = { platform: "macos", channel: "developer_id", fingerprint: FINGERPRINT };
      await registry.fetch(submit(body({ ...mac })));
      await registry.fetch(submit(body({ ...mac, install_id: OTHER })));
      expect(keysWithPrefix(storage, "terms-fp:")).toHaveLength(2);
      const hash = await sha256Hex(FINGERPRINT);
      const both = await read(registry, `?fingerprint_hash=${hash}`);
      expect(both.acceptances.map((row) => row.install_id).sort()).toEqual([INSTALL, OTHER].sort());

      const response = await registry.fetch(new Request(`https://registry/_terms?install_id=${INSTALL}`, { method: "DELETE" }));
      expect(await response.json()).toEqual({ ok: true, deleted: 1 });
      expect(keysWithPrefix(storage, "terms-fp:")).toEqual([termsFingerprintIndexKey(hash, 1, OTHER)]);
      expect((await read(registry, `?fingerprint_hash=${hash}`)).acceptances.map((row) => row.install_id)).toEqual([OTHER]);
    });

    it("narrows by debug", async () => {
      const { registry } = await seeded();
      expect((await read(registry, "?debug=true")).acceptances.map((row) => row.install_id)).toEqual([INSTALL]);
      expect((await read(registry, "?debug=false")).acceptances.map((row) => row.install_id)).toEqual([OTHER]);
      expect((await read(registry, `?install_id=${INSTALL}&debug=false`)).acceptances).toEqual([]);
      expect((await registry.fetch(new Request("https://registry/_terms?debug=maybe"))).status).toBe(400);
    });
  });

  it("deletes one install's records with both index keys, and nothing else", async () => {
    const { registry, storage } = makeRegistry();
    await registry.fetch(submit(body({ platform: "macos", channel: "developer_id", fingerprint: FINGERPRINT })));
    await registry.fetch(submit(body({ platform: "macos", channel: "developer_id", fingerprint: FINGERPRINT, terms_version: 2 })));
    await registry.fetch(submit(body({ install_id: OTHER })));
    expect(keysWithPrefix(storage, "terms-t:")).toHaveLength(3);
    expect(keysWithPrefix(storage, "terms-fp:")).toHaveLength(2);

    const response = await registry.fetch(new Request(`https://registry/_terms?install_id=${INSTALL}`, { method: "DELETE" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: 2 });
    expect(acceptanceRows(storage).map((row) => row.install_id)).toEqual([OTHER]);
    expect(keysWithPrefix(storage, "terms-fp:")).toEqual([]);
    const [tKey] = keysWithPrefix(storage, "terms-t:");
    expect(keysWithPrefix(storage, "terms-t:")).toHaveLength(1);
    expect(tKey).toContain(OTHER);
    // Counters are history, not records: they stay.
    expect(storage.map.get(termsGlobalKey(Date.now()))).toBe(3);

    expect(await (await registry.fetch(new Request(`https://registry/_terms?install_id=${INSTALL}`, { method: "DELETE" }))).json()).toEqual({ ok: true, deleted: 0 });
    expect((await registry.fetch(new Request("https://registry/_terms?install_id=bad", { method: "DELETE" }))).status).toBe(400);
    expect((await registry.fetch(new Request("https://registry/_terms", { method: "DELETE" }))).status).toBe(400);
  });
});

describe("Worker /terms routes", () => {
  /** The Worker with a registry stub that answers token validation and logs
   * every other request it is handed. */
  function makeWorkerEnv() {
    const forwarded: Request[] = [];
    const registry = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname === "/_validate_user") {
          return Response.json({ valid: true, userId: "u_1" });
        }
        forwarded.push(request);
        return Response.json({ ok: true });
      },
    };
    const env = {
      AUTH_TOKEN: "op",
      REGISTRY_DO: { get: () => registry, idFromName: (n: string) => n },
    } as unknown as Env;
    return { env, forwarded };
  }

  it("refuses a declared body over the cap before the registry sees it", async () => {
    const { env, forwarded } = makeWorkerEnv();
    const response = await worker.fetch(
      new Request("https://worker.example/terms/accept", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(MAX_TERMS_BODY_BYTES + 1) },
        body: "{}",
      }),
      env,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large" });
    expect(forwarded).toEqual([]);
  });

  it("forwards an in-bounds acceptance to the registry without a token", async () => {
    const { env, forwarded } = makeWorkerEnv();
    const response = await worker.fetch(
      new Request("https://worker.example/terms/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body()),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(forwarded.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["POST /_terms"]);
  });

  it.each(["GET", "DELETE"])("%s /terms-acceptances is operator-only", async (method) => {
    const { env, forwarded } = makeWorkerEnv();
    const url = `https://worker.example/terms-acceptances?install_id=${INSTALL}`;
    expect((await worker.fetch(new Request(url, { method }), env)).status).toBe(401);
    const asUser = await worker.fetch(new Request(url, { method, headers: { authorization: "Bearer user-token" } }), env);
    expect(asUser.status).toBe(403);
    expect(forwarded).toEqual([]);

    const asOperator = await worker.fetch(new Request(url, { method, headers: { authorization: "Bearer op" } }), env);
    expect(asOperator.status).toBe(200);
    expect(forwarded.map((r) => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search}`)).toEqual([
      `${method} /_terms?install_id=${INSTALL}`,
    ]);
  });
});

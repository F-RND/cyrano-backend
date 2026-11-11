// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  MAX_TERMS_FACT_CHARS,
  MIN_ACCEPTED_AT_MS,
  sanitizeTermsAcceptance,
  TERMS_RATE_LIMIT_PER_DAY,
  termsAcceptanceKey,
  termsRateLimitKey,
  type StoredTermsAcceptance,
} from "../src/terms.js";
import { RegistryDO } from "../src/registry-do.js";
import type { Env } from "../src/env.js";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const INSTALL = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
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
    ["an unknown platform", { platform: "android" }],
    ["an unknown channel", { channel: "sideload" }],
    ["the iPhone channel on a Mac", { platform: "macos", channel: "app_store" }],
    ["a Mac channel on an iPhone", { platform: "ios", channel: "developer_id" }],
  ])("refuses %s", (_label, overrides) => {
    expect(sanitizeTermsAcceptance(body(overrides), NOW)).toBeNull();
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

  it("puts the day first in the rate-limit key", () => {
    expect(termsRateLimitKey("abc", NOW)).toBe("terms-rl:2026-11-11:abc");
  });
});

describe("RegistryDO /_terms", () => {
  class FakeStorage {
    readonly map = new Map<string, unknown>();
    async get<T>(key: string): Promise<T | undefined> {
      return this.map.get(key) as T | undefined;
    }
    async put(key: string, value: unknown): Promise<void> {
      this.map.set(key, value);
    }
    async delete(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) this.map.delete(key);
    }
    async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
      const out = new Map<string, T>();
      for (const [key, value] of [...this.map].sort(([a], [b]) => a.localeCompare(b))) {
        if (key.startsWith(prefix)) out.set(key, value as T);
      }
      return out;
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

  it("keeps the first acceptance of a revision", async () => {
    const { registry, storage } = makeRegistry();
    const first = Date.now() - 60_000;
    await registry.fetch(submit(body({ accepted_at_ms: first })));
    const again = await registry.fetch(submit(body({ accepted_at_ms: Date.now() })));
    expect(await again.json()).toEqual({ ok: true, recorded: false });
    const rows = acceptanceRows(storage);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accepted_at_ms).toBe(first);

    await registry.fetch(submit(body({ terms_version: 2 })));
    expect(acceptanceRows(storage)).toHaveLength(2);
  });

  it("stores the Developer ID fingerprint only as the trial-key hash", async () => {
    const { registry, storage } = makeRegistry();
    await registry.fetch(submit(body({ platform: "macos", channel: "developer_id", fingerprint: FINGERPRINT })));
    const [row] = acceptanceRows(storage);
    expect(row!.fingerprint_hash).toBe(await sha256Hex(FINGERPRINT));
    expect(JSON.stringify(row)).not.toContain(FINGERPRINT);
  });

  it("refuses malformed and oversized bodies", async () => {
    const { registry } = makeRegistry();
    expect((await registry.fetch(submit(body({ install_id: "nope" })))).status).toBe(400);
    const notJSON = new Request("https://registry/_terms", { method: "POST", body: "{" });
    expect((await registry.fetch(notJSON)).status).toBe(400);
    const huge = new Request("https://registry/_terms", { method: "POST", body: "x".repeat(5_000) });
    expect((await registry.fetch(huge)).status).toBe(413);
  });

  it("caps new acceptances per client per day", async () => {
    const { registry, storage } = makeRegistry();
    const today = new Date().toISOString().slice(0, 10);
    const ipHash = (await sha256Hex("198.51.100.9")).slice(0, 16);
    storage.map.set(`terms-rl:${today}:${ipHash}`, TERMS_RATE_LIMIT_PER_DAY);
    storage.map.set(`terms-rl:2020-01-01:${ipHash}`, 3);
    const response = await registry.fetch(submit(body(), "198.51.100.9"));
    expect(response.status).toBe(429);
    // Another client is unaffected, and its submit prunes yesterday's buckets.
    expect((await registry.fetch(submit(body(), "192.0.2.1"))).status).toBe(200);
    expect(storage.map.has(`terms-rl:2020-01-01:${ipHash}`)).toBe(false);
  });

  it("lists acceptances for the operator, newest first, filterable", async () => {
    const { registry } = makeRegistry();
    const other = "11111111-2222-4333-8444-555555555555";
    await registry.fetch(submit(body()));
    await registry.fetch(
      submit(body({ install_id: other, platform: "macos", channel: "developer_id", fingerprint: FINGERPRINT })),
    );

    const all = (await (await registry.fetch(new Request("https://registry/_terms"))).json()) as {
      acceptances: StoredTermsAcceptance[];
      total: number;
    };
    expect(all.total).toBe(2);

    const one = (await (
      await registry.fetch(new Request(`https://registry/_terms?install_id=${INSTALL}`))
    ).json()) as { acceptances: StoredTermsAcceptance[] };
    expect(one.acceptances.map((row) => row.install_id)).toEqual([INSTALL]);

    const byMachine = (await (
      await registry.fetch(new Request(`https://registry/_terms?fingerprint_hash=${await sha256Hex(FINGERPRINT)}`))
    ).json()) as { acceptances: StoredTermsAcceptance[] };
    expect(byMachine.acceptances.map((row) => row.install_id)).toEqual([other]);

    expect((await registry.fetch(new Request("https://registry/_terms?install_id=bad"))).status).toBe(400);
  });
});

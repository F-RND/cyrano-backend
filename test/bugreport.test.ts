// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bugReportKey,
  bugReportNotification,
  bugReportNotifyConfigured,
  BUG_REPORT_PREFIX,
  MAX_DESCRIPTION_CHARS,
  MAX_DIAGNOSTIC_CHARS,
  MAX_EMAIL_CHARS,
  notifyBugReport,
  rateLimitKey,
  sanitizeBugReport,
  utcDayBucket,
  type StoredBugReport,
} from "../src/bugreport.js";
import { RegistryDO } from "../src/registry-do.js";
import type { Env } from "../src/env.js";

describe("sanitizeBugReport", () => {
  it("keeps a full, well-formed report intact", () => {
    const report = sanitizeBugReport({
      category: "bug",
      description: "The menu bar icon vanished after waking from sleep.",
      email: "person@example.com",
      diagnostics: {
        app_version: "1.0.66",
        build: "1000066",
        platform: "macOS",
        os_version: "15.5",
        device_model: "Mac14,10",
        locale: "en_AU",
      },
    });
    expect(report).toEqual({
      category: "bug",
      description: "The menu bar icon vanished after waking from sleep.",
      email: "person@example.com",
      diagnostics: {
        app_version: "1.0.66",
        build: "1000066",
        platform: "macOS",
        os_version: "15.5",
        device_model: "Mac14,10",
        locale: "en_AU",
      },
    });
  });

  it("returns null when there is nothing to store", () => {
    expect(sanitizeBugReport(null)).toBeNull();
    expect(sanitizeBugReport("text")).toBeNull();
    expect(sanitizeBugReport([])).toBeNull();
    expect(sanitizeBugReport({})).toBeNull();
    expect(sanitizeBugReport({ description: "   " })).toBeNull();
    expect(sanitizeBugReport({ description: 42 })).toBeNull();
  });

  it("truncates an overlong description instead of rejecting it", () => {
    const report = sanitizeBugReport({ description: "x".repeat(MAX_DESCRIPTION_CHARS + 500) });
    expect(report?.description).toHaveLength(MAX_DESCRIPTION_CHARS);
  });

  it("maps unknown categories to other", () => {
    expect(sanitizeBugReport({ category: "rant", description: "hi" })?.category).toBe("other");
    expect(sanitizeBugReport({ category: 7, description: "hi" })?.category).toBe("other");
    expect(sanitizeBugReport({ description: "hi" })?.category).toBe("other");
    expect(sanitizeBugReport({ category: "idea", description: "hi" })?.category).toBe("idea");
  });

  it("drops (never rejects on) a malformed or overlong email", () => {
    expect(sanitizeBugReport({ description: "hi", email: "not-an-email" })?.email).toBeUndefined();
    expect(sanitizeBugReport({ description: "hi", email: "two words@x.com" })?.email).toBeUndefined();
    expect(
      sanitizeBugReport({ description: "hi", email: `a@${"b".repeat(MAX_EMAIL_CHARS)}.com` })?.email,
    ).toBeUndefined();
    expect(sanitizeBugReport({ description: "hi", email: "  a@b.com  " })?.email).toBe("a@b.com");
  });

  it("copies only the known diagnostic fields, clamped", () => {
    const report = sanitizeBugReport({
      description: "hi",
      diagnostics: {
        app_version: "1.0.66",
        device_model: "m".repeat(MAX_DIAGNOSTIC_CHARS + 40),
        secret_injected_key: "should never survive",
        os_version: 15.5,
      },
    });
    expect(report?.diagnostics).toEqual({
      app_version: "1.0.66",
      device_model: "m".repeat(MAX_DIAGNOSTIC_CHARS),
    });
    expect(JSON.stringify(report)).not.toContain("secret_injected_key");
  });

  it("omits diagnostics entirely when the block is empty or malformed", () => {
    expect(sanitizeBugReport({ description: "hi", diagnostics: {} })?.diagnostics).toBeUndefined();
    expect(sanitizeBugReport({ description: "hi", diagnostics: "1.0.66" })?.diagnostics).toBeUndefined();
    expect(sanitizeBugReport({ description: "hi", diagnostics: [] })?.diagnostics).toBeUndefined();
  });
});

describe("rate-limit keys", () => {
  it("buckets by UTC day", () => {
    const justBeforeMidnight = Date.UTC(2026, 6, 20, 23, 59, 59);
    const justAfterMidnight = Date.UTC(2026, 6, 21, 0, 0, 1);
    expect(utcDayBucket(justBeforeMidnight)).toBe("2026-07-20");
    expect(utcDayBucket(justAfterMidnight)).toBe("2026-07-21");
    expect(rateLimitKey("abc", justBeforeMidnight)).toBe("bugreport-rl:2026-07-20:abc");
    expect(rateLimitKey("abc", justAfterMidnight)).not.toBe(rateLimitKey("abc", justBeforeMidnight));
  });

  it("puts the day before the client hash so stale buckets prune by prefix", () => {
    expect(rateLimitKey("abc", Date.UTC(2026, 6, 20)).startsWith("bugreport-rl:2026-07-20:")).toBe(true);
  });
});

describe("bugReportKey", () => {
  it("orders lexicographically by time", () => {
    const earlier = bugReportKey(Date.UTC(2026, 6, 20, 10, 0, 0), "aaaa");
    const later = bugReportKey(Date.UTC(2026, 6, 20, 10, 0, 1), "aaaa");
    expect(earlier < later).toBe(true);
    expect(earlier.startsWith(BUG_REPORT_PREFIX)).toBe(true);
  });
});

// ---- operator notification (BUG_REPORT_NOTIFY_URL) --------------------------

const STORED: StoredBugReport = {
  id: "01789348090000-abcd",
  createdAt: Date.UTC(2026, 8, 19, 2, 6, 49, 863),
  category: "bug",
  description: "The menu bar icon vanished after waking from sleep.",
  email: "person@example.com",
  diagnostics: { app_version: "1.0.66", build: "1000066", platform: "macOS", os_version: "15.5" },
};

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(status = 200): { calls: FetchCall[]; fetch: typeof fetch; only: () => FetchCall } {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(null, { status });
  }) as typeof fetch;
  const only = (): FetchCall => {
    expect(calls).toHaveLength(1);
    return calls[0] as FetchCall;
  };
  return { calls, fetch: impl, only };
}

describe("bugReportNotification", () => {
  it("is the stored record under an explicit kind and source, with an ISO timestamp", () => {
    expect(bugReportNotification(STORED)).toEqual({
      kind: "bug-report",
      source: "app",
      id: "01789348090000-abcd",
      created_at: "2026-09-19T02:06:49.863Z",
      category: "bug",
      description: "The menu bar icon vanished after waking from sleep.",
      email: "person@example.com",
      diagnostics: { app_version: "1.0.66", build: "1000066", platform: "macOS", os_version: "15.5" },
    });
  });

  it("omits the optional fields it does not have rather than sending nulls", () => {
    const { email: _email, diagnostics: _diagnostics, ...bare } = STORED;
    const body = bugReportNotification(bare);
    expect("email" in body).toBe(false);
    expect("diagnostics" in body).toBe(false);
  });
});

describe("notifyBugReport", () => {
  it("is inert when no relay is configured, and refuses a plain-http one", async () => {
    for (const env of [{}, { BUG_REPORT_NOTIFY_URL: "" }, { BUG_REPORT_NOTIFY_URL: "http://relay.example/bug-report" }]) {
      const { calls, fetch } = fakeFetch();
      expect(bugReportNotifyConfigured(env)).toBe(false);
      expect(await notifyBugReport(env, STORED, fetch)).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  it("POSTs the notification as JSON with the bearer secret", async () => {
    const { only, fetch } = fakeFetch();
    const ok = await notifyBugReport(
      { BUG_REPORT_NOTIFY_URL: " https://cyrano.zip/bug-report ", BUG_REPORT_NOTIFY_TOKEN: "s3cret" },
      STORED,
      fetch,
    );
    expect(ok).toBe(true);
    const call = only();
    expect(call.url).toBe("https://cyrano.zip/bug-report");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer s3cret",
    });
    expect(JSON.parse(String(call.init.body))).toEqual(bugReportNotification(STORED));
  });

  it("sends no Authorization header when there is no secret", async () => {
    const { only, fetch } = fakeFetch();
    await notifyBugReport({ BUG_REPORT_NOTIFY_URL: "https://relay.example/x" }, STORED, fetch);
    expect(only().init.headers).toEqual({ "content-type": "application/json" });
  });

  it("reports a refusal or an unreachable relay as false and never throws", async () => {
    const refused = fakeFetch(401);
    expect(await notifyBugReport({ BUG_REPORT_NOTIFY_URL: "https://relay.example/x" }, STORED, refused.fetch)).toBe(false);

    const dead = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      notifyBugReport({ BUG_REPORT_NOTIFY_URL: "https://relay.example/x" }, STORED, dead),
    ).resolves.toBe(false);
  });
});

// The DO path: a stored report is relayed after the 200, off the critical
// path, and the reporter's response does not depend on the relay.
describe("RegistryDO /_bugreport relay", () => {
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
      for (const [key, value] of this.map) if (key.startsWith(prefix)) out.set(key, value as T);
      return out;
    }
  }

  function makeRegistry(env: Partial<Env>) {
    const storage = new FakeStorage();
    const background: Promise<unknown>[] = [];
    const ctx = {
      storage,
      blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
    } as unknown as DurableObjectState;
    return { registry: new RegistryDO(ctx, env as Env), storage, background };
  }

  function submit(body: unknown): Request {
    return new Request("https://registry/_bugreport", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify(body),
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("relays the stored record to BUG_REPORT_NOTIFY_URL after storing it", async () => {
    const { only, fetch } = fakeFetch();
    vi.stubGlobal("fetch", fetch);
    const { registry, storage, background } = makeRegistry({
      BUG_REPORT_NOTIFY_URL: "https://cyrano.zip/bug-report",
      BUG_REPORT_NOTIFY_TOKEN: "s3cret",
    });

    const response = await registry.fetch(submit({ category: "bug", description: "It broke.", email: "p@example.com" }));
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    await Promise.all(background);

    const stored = storage.map.get(`${BUG_REPORT_PREFIX}${id}`) as StoredBugReport;
    expect(stored.description).toBe("It broke.");
    const call = only();
    expect(call.init.headers).toMatchObject({ authorization: "Bearer s3cret" });
    expect(JSON.parse(String(call.init.body))).toEqual({
      kind: "bug-report",
      source: "app",
      id,
      created_at: new Date(stored.createdAt).toISOString(),
      category: "bug",
      description: "It broke.",
      email: "p@example.com",
    });
  });

  it("stores and answers 200 exactly the same when no relay is configured", async () => {
    const { calls, fetch } = fakeFetch();
    vi.stubGlobal("fetch", fetch);
    const { registry, storage, background } = makeRegistry({});

    const response = await registry.fetch(submit({ category: "idea", description: "Dark mode." }));
    expect(response.status).toBe(200);
    await Promise.all(background);
    expect([...storage.map.keys()].some((key) => key.startsWith(BUG_REPORT_PREFIX))).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("keeps the reporter's 200 when the relay is down", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    const { registry, background } = makeRegistry({ BUG_REPORT_NOTIFY_URL: "https://cyrano.zip/bug-report" });

    const response = await registry.fetch(submit({ category: "bug", description: "Still broke." }));
    expect(response.status).toBe(200);
    await expect(Promise.all(background)).resolves.toEqual([false]);
  });
});

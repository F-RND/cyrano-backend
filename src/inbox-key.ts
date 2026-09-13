// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// The account-inbox routing key, and the session-index sanitizer that rides the
// same socket. Both live in their own module because more than one caller now
// needs them: the router (agent push, client stream), the remote MCP surface
// (origin-pull, 2026-08-04), and the DO itself. A second copy of the key
// derivation would be a silent wrong-DO bug — origin-pull would talk to an
// inbox nobody is listening on — which is precisely what account-inbox.test.ts
// exists to prevent.

/** Which Durable Object holds an identity's account inbox
 * (account-inbox contract): a tenant/relay account gets its
 * own inbox by userId; an operator / self-host deployment has a single account,
 * so every side meets at one fixed "operator" inbox. */
export function inboxKeyFor(
  identity: { kind: "user"; userId: string } | { kind: "operator" },
): string {
  return identity.kind === "user" ? `user:${identity.userId}` : "operator";
}

// ---- Session index (documentation/PLAN-REMOTE.md option D) ----

/** The index is metadata only, but a title is still a meeting subject, so it is
 * bounded in every direction: how many sessions, how long a title, and (in the
 * DO) how long it survives without the device checking back in. */
export const MAX_INDEX_SESSIONS = 500;
export const MAX_INDEX_TITLE_CHARS = 200;
export const MAX_INDEX_TAGS = 20;
/** Real ids are UUIDs (36 chars); anything past this is garbage, and a
 * truncated id would be exactly the unfetchable entry the drop rule exists to
 * prevent — so over-long ids DROP the row rather than clamp. */
export const MAX_INDEX_ID_CHARS = 64;
export const MAX_INDEX_TAG_CHARS = 80;
export const MAX_INDEX_SCOPE_CHARS = 40;

/** One row of the published session index. Deliberately no transcript, no
 * extractions, no notes — everything here is what a person needs to say "that
 * one, the Acme call on Tuesday", and nothing more. */
export interface IndexedSession {
  id: string;
  title: string;
  started_at: number;
  ended_at?: number;
  tags?: string[];
  running?: boolean;
  /** Server-set on rows the inbox DO serves from a stored free-cold snapshot
   * (free-cold relay contract), so an assistant can tell "answered from a
   * held copy" from "the device will answer live". Never accepted from a
   * published index — the sanitizer below builds rows explicitly and does not
   * copy it. */
  stored?: boolean;
}

export interface SessionIndex {
  sessions: IndexedSession[];
  /** When this copy was accepted (server receive time — the device publishes
   * immediately on build, so the skew is transit time). Drives the staleness
   * TTL and lets a cached list be reported as "as of" rather than current. */
  built_at: number;
  /** Which device published it, for the "who answered" echo. */
  device?: string;
  /** The device's sharing scope when it built this, so an assistant is not told
   * a narrow list is the whole history. */
  scope?: string;
}

/**
 * Clamp and shape a published index. Pure so it is unit-testable; the DO stores
 * whatever this returns and nothing else.
 *
 * A row missing an id or a start time is DROPPED rather than defaulted: an
 * index entry that cannot be fetched later is worse than absent, because the
 * assistant will name it to the user and then fail to open it.
 */
export function sanitizeSessionIndex(
  raw: unknown,
  device: string | undefined,
  now: number,
): SessionIndex {
  const source = raw as { sessions?: unknown; scope?: unknown } | null;
  const rows = Array.isArray(source?.sessions) ? source.sessions : [];
  const sessions: IndexedSession[] = [];
  for (const row of rows.slice(0, MAX_INDEX_SESSIONS)) {
    const r = row as Record<string, unknown> | null;
    if (!r || typeof r.id !== "string" || !r.id || r.id.length > MAX_INDEX_ID_CHARS) continue;
    if (typeof r.started_at !== "number" || !Number.isFinite(r.started_at)) continue;
    const tags = Array.isArray(r.tags)
      ? r.tags
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.slice(0, MAX_INDEX_TAG_CHARS))
          .filter((t) => t.length > 0)
          .slice(0, MAX_INDEX_TAGS)
      : [];
    sessions.push({
      id: r.id,
      title: typeof r.title === "string" ? r.title.slice(0, MAX_INDEX_TITLE_CHARS) : "",
      started_at: r.started_at,
      ...(typeof r.ended_at === "number" && Number.isFinite(r.ended_at)
        ? { ended_at: r.ended_at }
        : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(r.running === true ? { running: true } : {}),
    });
  }
  return {
    sessions,
    built_at: now,
    ...(device ? { device } : {}),
    ...(typeof source?.scope === "string"
      ? { scope: source.scope.slice(0, MAX_INDEX_SCOPE_CHARS) }
      : {}),
  };
}

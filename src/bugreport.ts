// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// In-app bug reports (Settings → Support on Mac and iOS).
//
// Token-less like /license/* and for a similar reason: the reporter may be a
// Free/local user with no backend credential at all, and a report grants
// nothing server-side — it is a one-way, user-authored note into the operator's
// queue. What it may NEVER carry is session content: the client only sends what
// the user typed plus an opt-in block of app/device facts, and this module
// enforces that shape server-side by copying ONLY known fields (never echoing
// arbitrary keys into storage).
//
// Pure logic lives here (unit-tested); storage and rate-limit counting live in
// RegistryDO (`/_bugreport`), reached via the Worker's /bug-report forwarding.

/** Truncation cap for the free-text description. Truncate rather than reject:
 * a bug report is best-effort capture, not a document pipeline — losing the
 * tail beats bouncing a frustrated user's report. */
export const MAX_DESCRIPTION_CHARS = 4000;
/** RFC 5321's practical mailbox ceiling. Anything longer is dropped, not
 * rejected — email is optional garnish on the report. */
export const MAX_EMAIL_CHARS = 254;
/** Per-diagnostic-field clamp — these are short facts ("1.0.66", "Mac14,10"). */
export const MAX_DIAGNOSTIC_CHARS = 120;
/** Raw request bodies past this are refused outright (413) before parsing. */
export const MAX_BODY_BYTES = 64_000;
/** Ring-buffer cap on stored reports: oldest are dropped past this. */
export const MAX_STORED_REPORTS = 500;
/** Reports accepted per client (IP hash) per UTC day before 429. */
export const RATE_LIMIT_PER_DAY = 5;

export const BUG_REPORT_CATEGORIES = ["bug", "idea", "other"] as const;
export type BugReportCategory = (typeof BUG_REPORT_CATEGORIES)[number];

/** The opt-in app/device block. Fixed vocabulary — a submitted diagnostics
 * object contributes at most these keys, each clamped. */
const DIAGNOSTIC_FIELDS = [
  "app_version",
  "build",
  "platform",
  "os_version",
  "device_model",
  "locale",
] as const;
export type BugReportDiagnostics = Partial<Record<(typeof DIAGNOSTIC_FIELDS)[number], string>>;

export interface SanitizedBugReport {
  category: BugReportCategory;
  description: string;
  email?: string;
  diagnostics?: BugReportDiagnostics;
}

function clampString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Normalizes an inbound report body to the exact stored shape, or null when
 * there is nothing to store (no description). Forgiving everywhere else:
 * unknown categories become "other", a malformed email is dropped, unknown
 * diagnostic keys are ignored. */
export function sanitizeBugReport(body: unknown): SanitizedBugReport | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  const description = clampString(record.description, MAX_DESCRIPTION_CHARS);
  if (!description) return null;

  const rawCategory = typeof record.category === "string" ? record.category : "";
  const category: BugReportCategory = (BUG_REPORT_CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as BugReportCategory)
    : "other";

  const report: SanitizedBugReport = { category, description };

  // Unlike the description, an email is dropped (not truncated) when overlong:
  // a clipped address is not a usable reply-to.
  const email = typeof record.email === "string" ? record.email.trim() : "";
  if (email.length > 0 && email.length <= MAX_EMAIL_CHARS && email.includes("@") && !/\s/.test(email)) {
    report.email = email;
  }

  const rawDiagnostics = record.diagnostics;
  if (typeof rawDiagnostics === "object" && rawDiagnostics !== null && !Array.isArray(rawDiagnostics)) {
    const source = rawDiagnostics as Record<string, unknown>;
    const diagnostics: BugReportDiagnostics = {};
    for (const field of DIAGNOSTIC_FIELDS) {
      const value = clampString(source[field], MAX_DIAGNOSTIC_CHARS);
      if (value) diagnostics[field] = value;
    }
    if (Object.keys(diagnostics).length > 0) report.diagnostics = diagnostics;
  }

  return report;
}

/** UTC day bucket ("2026-07-20") — the rate-limit window boundary. */
export function utcDayBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Storage key for one client's daily counter. Day comes FIRST so stale
 * buckets are prunable with a single non-today prefix scan. */
export function rateLimitKey(clientHash: string, nowMs: number): string {
  return `bugreport-rl:${utcDayBucket(nowMs)}:${clientHash}`;
}

export const RATE_LIMIT_PREFIX = "bugreport-rl:";

export const BUG_REPORT_PREFIX = "bugreport:";

/** Storage key for a stored report. The zero-padded millisecond timestamp
 * makes lexicographic key order chronological, so `list()` returns oldest
 * first and capping to MAX_STORED_REPORTS is "delete from the front". The id
 * IS the key suffix, so delete-by-id needs no scan. */
export function bugReportKey(nowMs: number, nonce: string): string {
  return `${BUG_REPORT_PREFIX}${String(nowMs).padStart(14, "0")}-${nonce}`;
}

// ---- operator notification (BUG_REPORT_NOTIFY_URL) --------------------------
//
// Storing a report is the only thing /bug-report guarantees. Without this
// relay the queue is silent: nothing tells the operator a report exists until
// they poll GET /bug-reports. When BUG_REPORT_NOTIFY_URL is set, every ACCEPTED
// report is also POSTed there as JSON, after it is stored and off the request's
// critical path — the submit succeeds whether or not the relay does. The body
// is the stored record plus a `kind` discriminator, so the receiver (an email
// relay, a chat webhook, a ticket tracker) can never mistake it for any other
// kind of inbound mail — and carries nothing the queue does not already hold.

/** The stored-record shape (what GET /bug-reports returns per row). */
export type StoredBugReport = SanitizedBugReport & { id: string; createdAt: number };

export const BUG_REPORT_NOTIFICATION_KIND = "bug-report";
/** Where the report was authored. The in-app form is the only submitter today;
 * a relay receiver uses it to label the report ("app"), never to route it. */
export const BUG_REPORT_NOTIFICATION_SOURCE = "app";

export interface BugReportNotification {
  kind: typeof BUG_REPORT_NOTIFICATION_KIND;
  source: typeof BUG_REPORT_NOTIFICATION_SOURCE;
  id: string;
  /** ISO 8601, from the stored `createdAt`. */
  created_at: string;
  category: BugReportCategory;
  description: string;
  email?: string;
  diagnostics?: BugReportDiagnostics;
}

/** The relay body for one stored report. Explicit field list on purpose: a
 * new stored field never leaks to the receiver by accident. */
export function bugReportNotification(stored: StoredBugReport): BugReportNotification {
  const body: BugReportNotification = {
    kind: BUG_REPORT_NOTIFICATION_KIND,
    source: BUG_REPORT_NOTIFICATION_SOURCE,
    id: stored.id,
    created_at: new Date(stored.createdAt).toISOString(),
    category: stored.category,
    description: stored.description,
  };
  if (stored.email) body.email = stored.email;
  if (stored.diagnostics) body.diagnostics = stored.diagnostics;
  return body;
}

/** Upper bound on one relay attempt. Runs off the critical path, so this only
 * caps how long a dead receiver keeps the DO's background work open. */
export const NOTIFY_TIMEOUT_MS = 10_000;

export interface BugReportNotifyEnv {
  BUG_REPORT_NOTIFY_URL?: string;
  BUG_REPORT_NOTIFY_TOKEN?: string;
}

/** True when the operator has configured a relay target (an https URL). A
 * plain-http URL is refused: the body carries a user's own words and reply
 * address, and a leaked-in-transit relay is worse than a silent queue. */
export function bugReportNotifyConfigured(env: BugReportNotifyEnv): boolean {
  const url = env.BUG_REPORT_NOTIFY_URL?.trim() ?? "";
  return url.startsWith("https://");
}

/**
 * Relays one stored report to BUG_REPORT_NOTIFY_URL. Resolves true when the
 * receiver acknowledged (2xx), false when unconfigured, refused, or unreachable
 * — never throws, so a caller can hand it to waitUntil without a guard. Failure
 * logs carry the report id and the receiver's status only; the description is
 * user text and stays out of logs.
 */
export async function notifyBugReport(
  env: BugReportNotifyEnv,
  stored: StoredBugReport,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!bugReportNotifyConfigured(env)) return false;
  const url = (env.BUG_REPORT_NOTIFY_URL as string).trim();
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = env.BUG_REPORT_NOTIFY_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(bugReportNotification(stored)),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (response.ok) return true;
    console.error(
      JSON.stringify({ message: "bug report notify refused", id: stored.id, status: response.status }),
    );
    return false;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "bug report notify failed",
        id: stored.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}

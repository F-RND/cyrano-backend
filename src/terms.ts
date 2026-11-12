// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Terms of Use acceptance records.
//
// The apps open on a click-through: nothing runs until the user ticks a box
// and agrees to the current revision of the Terms of Use (acknowledging the
// Privacy Policy). The app keeps its own record of that; this is the
// operator's copy, so an acceptance can be shown without the user's device.
//
// Token-less like /bug-report and for the same reason: the gate comes before
// any plan, purchase or credential, so most installs that accept hold nothing
// to authenticate with. A record grants nothing server-side.
//
// What a record holds is deliberately thin: a random per-install id the app
// generates for this purpose, the revision accepted, when (the device's clock,
// and ours on receipt), the platform/channel/app version, and, on the
// Developer ID Mac build only, the SHA-256 of the hardware fingerprint that
// build already sends for its trial and license, so a record can be joined to
// that machine's trial (`trial:<same hash>`). No IP address, no name, no email,
// no session content. The connecting IP is used only in today's rate-limit
// bucket, and only as the hash of its network prefix (ipPrefixForRateLimit),
// never on the record.
//
// Records are kept until the operator deletes them (DELETE /terms-acceptances
// ?install_id=): an acceptance is the evidence the terms rest on, so nothing
// expires it on its own.
//
// First acceptance of a revision wins: a repeat POST for the same install and
// revision is acknowledged and changes nothing, because the first date is the
// one the terms' 30-day arbitration opt-out window runs from.
//
// Pure logic lives here (unit-tested); storage and rate limiting live in
// RegistryDO (`/_terms`), reached via the Worker's POST /terms/accept.

/** Raw request bodies past this are refused outright (413) before parsing. */
export const MAX_TERMS_BODY_BYTES = 4_000;
/** Acceptances recorded per client (hashed IP prefix) per UTC day before 429.
 * Generous: a school or office behind one NAT may set up many devices in a
 * day, and the bucket is a whole /24 or /48, not one address. */
export const TERMS_RATE_LIMIT_PER_DAY = 200;
/** Acceptances recorded across all clients per UTC day before 429. Far above
 * any real launch day; it bounds what a distributed flood can write. The
 * client retries a 429 at its next launch, so a day over the ceiling delays
 * records rather than losing them. */
export const TERMS_GLOBAL_LIMIT_PER_DAY = 20_000;
/** How many `limit`-sized slices of the time index the unfiltered operator
 * read will walk while a `?debug=` filter is thinning them, so the read stays
 * bounded (at most 5 x limit index entries) however the rows are mixed. */
export const TERMS_LIST_MAX_PAGES = 5;
/** Highest revision number we will believe. The app counts up from 1. */
export const MAX_TERMS_VERSION = 10_000;
/** Clamp for the short free-form facts (app version). */
export const MAX_TERMS_FACT_CHARS = 40;
/** Earliest plausible client acceptance time (the gate shipped in Nov 2026). */
export const MIN_ACCEPTED_AT_MS = Date.UTC(2026, 0, 1);
/** How far ahead of our clock a device's clock may run before we drop its time. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

// "other" is what an unrecognised value is stored as, not something a client
// sends: a channel that ships before the server knows its name must still
// have its acceptances kept (the client treats a 400 as final and never
// re-sends), and the record's app_version says which build it really was.
export const TERMS_PLATFORMS = ["ios", "macos", "other"] as const;
export type TermsPlatform = (typeof TERMS_PLATFORMS)[number];
/** Which binary: the iPhone App Store app, the Mac App Store app, or the
 * Developer ID (direct download) Mac app. */
export const TERMS_CHANNELS = ["app_store", "mac_app_store", "developer_id", "other"] as const;
export type TermsChannel = (typeof TERMS_CHANNELS)[number];

export const TERMS_PREFIX = "terms:";
export const TERMS_RATE_LIMIT_PREFIX = "terms-rl:";
export const TERMS_GLOBAL_PREFIX = "terms-global:";
/** Index: fingerprint hash → record key, so a Developer ID Mac's acceptances
 * are a prefix list rather than a scan of every record. */
export const TERMS_FINGERPRINT_INDEX_PREFIX = "terms-fp:";
/** Index: receipt time → record key, so the unfiltered operator read is a
 * bounded newest-first list. */
export const TERMS_TIME_INDEX_PREFIX = "terms-t:";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** A validated acceptance, before the server adds its own fields. */
export interface SanitizedTermsAcceptance {
  install_id: string;
  terms_version: number;
  /** The device's clock at the moment of agreement, or null when implausible. */
  accepted_at_ms: number | null;
  platform: TermsPlatform;
  channel: TermsChannel;
  app_version: string | null;
  /** A debug (Xcode) build, so operator queries can leave it out. */
  debug: boolean;
  /** The raw client fingerprint, ONLY to be hashed by the caller. Never stored. */
  fingerprint: string | null;
}

/** What is stored, and what the operator read returns per row. */
export interface StoredTermsAcceptance {
  install_id: string;
  terms_version: number;
  accepted_at_ms: number | null;
  received_at_ms: number;
  platform: TermsPlatform;
  channel: TermsChannel;
  app_version: string | null;
  debug: boolean;
  /** sha256(fingerprint), the same hash the trial record is keyed by. */
  fingerprint_hash: string | null;
}

function clampString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Normalizes an inbound body, or null when it can't be a real acceptance
 * (no usable install id or revision; those are the only grounds to refuse,
 * since the client takes a 400 as final). An unknown platform or channel is
 * kept as "other". `nowMs` bounds the client's claimed acceptance time. */
export function sanitizeTermsAcceptance(body: unknown, nowMs: number): SanitizedTermsAcceptance | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  const installId = typeof record.install_id === "string" ? record.install_id.trim().toLowerCase() : "";
  if (!UUID_RE.test(installId)) return null;

  const version = record.terms_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > MAX_TERMS_VERSION) {
    return null;
  }

  const rawPlatform = record.platform;
  const platform: TermsPlatform =
    typeof rawPlatform === "string" && (TERMS_PLATFORMS as readonly string[]).includes(rawPlatform)
      ? (rawPlatform as TermsPlatform)
      : "other";
  const rawChannel = record.channel;
  const channel: TermsChannel =
    typeof rawChannel === "string" && (TERMS_CHANNELS as readonly string[]).includes(rawChannel)
      ? (rawChannel as TermsChannel)
      : "other";
  // Each App Store channel belongs to one platform. A pair that disagrees is
  // stored as sent, not refused: the record is still an acceptance, and the
  // disagreement is itself the fact worth seeing.

  const at = record.accepted_at_ms;
  const acceptedAt =
    typeof at === "number" && Number.isFinite(at) && at >= MIN_ACCEPTED_AT_MS && at <= nowMs + MAX_CLOCK_SKEW_MS
      ? Math.floor(at)
      : null;

  // Only the Developer ID build has a fingerprint to send (the App Store
  // builds must never derive one); anything else carrying one is ignored.
  const rawFingerprint = typeof record.fingerprint === "string" ? record.fingerprint.trim().toLowerCase() : "";
  const fingerprint = channel === "developer_id" && SHA256_HEX_RE.test(rawFingerprint) ? rawFingerprint : null;

  return {
    install_id: installId,
    terms_version: version,
    accepted_at_ms: acceptedAt,
    platform,
    channel,
    app_version: clampString(record.app_version, MAX_TERMS_FACT_CHARS),
    debug: record.debug === true,
    fingerprint,
  };
}

/** Storage key for one install's acceptance of one revision. Install first, so
 * the operator can list everything one install accepted with a prefix scan. */
export function termsAcceptanceKey(installId: string, version: number): string {
  return `${TERMS_PREFIX}${installId}:${String(version).padStart(5, "0")}`;
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Storage key for one client's daily counter. Day first, so every stale
 * bucket sorts before today's and prunes as one bounded range list
 * (`start: prefix, end: termsRateLimitKey("", now)`), never a scan of the
 * whole prefix. */
export function termsRateLimitKey(clientHash: string, nowMs: number): string {
  return `${TERMS_RATE_LIMIT_PREFIX}${utcDay(nowMs)}:${clientHash}`;
}

/** Storage key for the day's global counter; stale days prune the same way. */
export function termsGlobalKey(nowMs: number): string {
  return `${TERMS_GLOBAL_PREFIX}${utcDay(nowMs)}`;
}

/** Fingerprint-index key: `terms-fp:<hash>:<rev>:<install>` → the record
 * key. The install id is part of it because one machine carries several
 * installs over its life (a reinstall or a defaults reset mints a new id):
 * without it the second install's entry would overwrite the first's, and
 * deleting either would take the other's index entry with it. */
export function termsFingerprintIndexKey(fingerprintHash: string, version: number, installId: string): string {
  return `${TERMS_FINGERPRINT_INDEX_PREFIX}${fingerprintHash}:${String(version).padStart(5, "0")}:${installId}`;
}

/** Time-index key: `terms-t:<received_at_ms>:<install>:<rev>` → the record
 * key. Zero-padded to 14 digits so the keys sort as the numbers do. */
export function termsTimeIndexKey(receivedAtMs: number, installId: string, version: number): string {
  return `${TERMS_TIME_INDEX_PREFIX}${String(receivedAtMs).padStart(14, "0")}:${installId}:${String(version).padStart(5, "0")}`;
}

/** The record's two index keys, so writes and deletes derive them the same way. */
export function termsIndexKeys(row: StoredTermsAcceptance): string[] {
  const keys = [termsTimeIndexKey(row.received_at_ms, row.install_id, row.terms_version)];
  if (row.fingerprint_hash) {
    keys.push(termsFingerprintIndexKey(row.fingerprint_hash, row.terms_version, row.install_id));
  }
  return keys;
}

/** What the rate limiter hashes in place of the connecting address: its /24
 * (IPv4) or /48 (IPv6) prefix, or "unknown" when the header is missing or not
 * an address. The counter key carries an unsalted SHA-256 of this, and an
 * unsalted hash of so small a space is reversible by enumeration whether or
 * not the low bits are zeroed (2^24 prefixes take seconds). What the zeroing
 * buys is a bound on what a reversal yields: a network, never a host. The
 * bucket is coarser as a result (one NAT's neighbours share it), which the
 * generous per-day limit allows for. An IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`) is bucketed by its embedded /24 rather than lumping every
 * such client into one /48. */
export function ipPrefixForRateLimit(ip: string | null | undefined): string {
  const value = (ip ?? "").trim();
  if (value.length === 0) return "unknown";

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) return "unknown";
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }

  const hextets = parseIPv6(value);
  if (!hextets) return "unknown";
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return `${hextets[6]! >> 8}.${hextets[6]! & 0xff}.${hextets[7]! >> 8}.0/24`;
  }
  return `${hextets.slice(0, 3).map((h) => h.toString(16)).join(":")}::/48`;
}

/** The eight 16-bit groups of an IPv6 address, or null when it isn't one.
 * Accepts `::` compression, an embedded dotted IPv4 tail and a zone suffix. */
function parseIPv6(value: string): number[] | null {
  const noZone = value.split("%")[0]!;
  const halves = noZone.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i]!;
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(piece);
        if (!v4) return null;
        const octets = v4.slice(1, 5).map(Number);
        if (octets.some((octet) => octet > 255)) return null;
        out.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 2) {
    if (head.length + tail.length > 7) return null;
    return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/** The operator read's install filter, or null when absent/malformed. */
export function termsInstallFilter(value: string | null): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

/** The operator read's fingerprint-hash filter, or null when absent/malformed. */
export function termsFingerprintFilter(value: string | null): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  return SHA256_HEX_RE.test(trimmed) ? trimmed : null;
}

/** The operator read's `?debug=` filter: true/false, undefined when absent,
 * null when malformed. */
export function termsDebugFilter(value: string | null): boolean | null | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return null;
}

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
// no session content. The connecting IP is used only, hashed, in today's
// rate-limit bucket (same scheme as bug reports), never on the record.
//
// First acceptance of a revision wins: a repeat POST for the same install and
// revision is acknowledged and changes nothing, because the first date is the
// one the terms' 30-day arbitration opt-out window runs from.
//
// Pure logic lives here (unit-tested); storage and rate limiting live in
// RegistryDO (`/_terms`), reached via the Worker's POST /terms/accept.

/** Raw request bodies past this are refused outright (413) before parsing. */
export const MAX_TERMS_BODY_BYTES = 4_000;
/** Acceptances recorded per client (IP hash) per UTC day before 429. Generous:
 * a school or office behind one NAT may set up many devices in a day. */
export const TERMS_RATE_LIMIT_PER_DAY = 200;
/** Highest revision number we will believe. The app counts up from 1. */
export const MAX_TERMS_VERSION = 10_000;
/** Clamp for the short free-form facts (app version). */
export const MAX_TERMS_FACT_CHARS = 40;
/** Earliest plausible client acceptance time (the gate shipped in Nov 2026). */
export const MIN_ACCEPTED_AT_MS = Date.UTC(2026, 0, 1);
/** How far ahead of our clock a device's clock may run before we drop its time. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export const TERMS_PLATFORMS = ["ios", "macos"] as const;
export type TermsPlatform = (typeof TERMS_PLATFORMS)[number];
/** Which binary: the iPhone App Store app, the Mac App Store app, or the
 * Developer ID (direct download) Mac app. */
export const TERMS_CHANNELS = ["app_store", "mac_app_store", "developer_id"] as const;
export type TermsChannel = (typeof TERMS_CHANNELS)[number];

export const TERMS_PREFIX = "terms:";
export const TERMS_RATE_LIMIT_PREFIX = "terms-rl:";

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
 * (no usable install id, revision, platform or channel). `nowMs` bounds the
 * client's claimed acceptance time. */
export function sanitizeTermsAcceptance(body: unknown, nowMs: number): SanitizedTermsAcceptance | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;

  const installId = typeof record.install_id === "string" ? record.install_id.trim().toLowerCase() : "";
  if (!UUID_RE.test(installId)) return null;

  const version = record.terms_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > MAX_TERMS_VERSION) {
    return null;
  }

  const platform = record.platform;
  if (typeof platform !== "string" || !(TERMS_PLATFORMS as readonly string[]).includes(platform)) return null;
  const channel = record.channel;
  if (typeof channel !== "string" || !(TERMS_CHANNELS as readonly string[]).includes(channel)) return null;
  // The two App Store channels each belong to one platform.
  if ((channel === "app_store" && platform !== "ios") || (channel !== "app_store" && platform !== "macos")) {
    return null;
  }

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
    platform: platform as TermsPlatform,
    channel: channel as TermsChannel,
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

/** Storage key for one client's daily counter. Day first, so stale buckets
 * prune with a single non-today prefix scan (as bugreport.ts does). */
export function termsRateLimitKey(clientHash: string, nowMs: number): string {
  return `${TERMS_RATE_LIMIT_PREFIX}${new Date(nowMs).toISOString().slice(0, 10)}:${clientHash}`;
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

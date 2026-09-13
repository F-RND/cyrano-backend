// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Free 3-day Pro trial. The trial record lives in RegistryDO (keyed by a
// hashed hardware fingerprint), so it sits next to the
// LicenseRecord in the same singleton DO.
//
// A trial grants NOTHING server-side — exactly like a license (see license.ts):
// it only lets the client flip `proUnlocked` and run the all-on-device Pro smart
// layer. The server's job is purely to be the single source of truth for "has
// THIS machine ever started a trial, and when does it expire", and to hand back
// an Ed25519-signed token the client verifies offline with the public key baked
// into the app.
//
// The four locks that make this hard to crack (see the client's TrialManager for
// the matching half):
//   1. Server-authoritative expiry keyed by hardware fingerprint → reinstalling
//      or wiping the Keychain re-issues the ORIGINAL expiresAt, never a fresh one.
//   2. Ed25519 signature → a token can't be forged without TRIAL_SIGNING_PRIVATE_KEY
//      (a Worker secret that never leaves the edge).
//   3. Immutable expiresAt → heartbeats confirm reachability but never extend it,
//      so a rolled-back client clock can't buy more time.
//   4. Once-per-fingerprint → a finished/revoked trial stays finished.

import type { Env } from "./env.js";

/** One trial, stored in RegistryDO under `trial:<sha256(fingerprint)>`. The
 *  fingerprint the client sends is already a SHA-256 hex of its composite
 *  hardware id; we hash it again for the storage key so a raw storage dump never
 *  reveals even the client-supplied fingerprint. */
export interface TrialRecord {
  /** The client-supplied composite fingerprint (SHA-256 hex). Echoed into every
   *  signed token so the client can reject a token minted for another machine. */
  fingerprint: string;
  device_name: string | null;
  started_at: string; // ISO 8601 — immutable
  expires_at: string; // ISO 8601 — immutable; heartbeats never move it
  last_seen_at: string; // ISO 8601 — updated on every start/heartbeat
  /** The app version and platform this machine last reported, from the same
   *  start/heartbeat calls that already carry its fingerprint (adoption.ts).
   *  Release-adoption counting only — the trial's own logic never reads
   *  them. */
  app_version?: string | null;
  platform?: string | null;
  /** Set to kill a trial early (abuse) — start/heartbeat then fail with 410. */
  revoked_at?: string | null;
}

/** Trial length. Three days, once per machine. */
export const TRIAL_DAYS = 3;
/** How often the client re-confirms reachability. The client trusts a cached
 *  token for `trialOfflineGrace` (12h) past the last good heartbeat, so hourly
 *  gives a wide margin before an offline machine locks. */
export const HEARTBEAT_INTERVAL_HOURS = 1;
/** Advisory `heartbeatBy` stamped into the token — informational; the hard
 *  offline-grace clock lives on the client (LicenseConfig.trialOfflineGrace). */
export const HEARTBEAT_GRACE_HOURS = 12;

export interface TrialPayload {
  fingerprint: string;
  issuedAt: string;
  expiresAt: string;
  heartbeatBy: string;
  nonce: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let cachedKey: CryptoKey | null = null;

async function loadPrivateKey(env: Env): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const b64 = env.TRIAL_SIGNING_PRIVATE_KEY;
  if (!b64) {
    throw new Error("TRIAL_SIGNING_PRIVATE_KEY secret is not set");
  }
  const der = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  cachedKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  return cachedKey;
}

/**
 * Sign a trial payload with the Worker's Ed25519 private key. Wire format is
 * `<base64url(payloadJSON)>.<base64url(signature)>` — the client splits on '.',
 * verifies the signature over the exact payload bytes, then JSON-parses. Simpler
 * than a full JWT; we don't need alg agility.
 *
 * NOTE: the client verifies the signature over the RAW payload bytes we encode
 * here, so it must never re-serialize the parsed struct. Keep the payload key
 * order stable.
 */
export async function signTrialToken(env: Env, payload: TrialPayload): Promise<string> {
  const key = await loadPrivateKey(env);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, payloadBytes));
  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(sig)}`;
}

/** Whether trials are servable at all — i.e. the signing secret is configured.
 *  When false the routes return 503 and the client leaves the trial `notStarted`
 *  (a transient failure, retried next launch), never baking an expired state. */
export function trialSigningConfigured(env: Env): boolean {
  return !!env.TRIAL_SIGNING_PRIVATE_KEY;
}

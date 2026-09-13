// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Lifetime Pro license keys.
//
// A license is a device-bound, operator-minted (later Stripe-minted) key that
// unlocks the all-on-device Pro smart layer. It is deliberately NOT a promo key
// (promo.ts): a promo IS a hosted-tier bearer token and grants server-side
// entitlement, whereas a license grants NOTHING on the server — it only flips
// the client's `proUnlocked`, and Pro processing then happens entirely on the
// device. So a license is a key→record binding (with a device slot), not an
// identity: activate once to bind
// a device, then periodic revalidation with a long client-side offline grace.
//
// The record shape is shared by operator key-generation tooling and a future
// Stripe `mode:"payment"` webhook.

// Crockford-style alphabet (drops 0/1/I/O), identical to promo.ts. Four groups
// (vs the promo's three) so a Pro license reads distinctly from a hosted promo
// code at a glance — different unlock path, different pasted field.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 4;
const CODE_GROUP_SIZE = 4;

/** `CYRANO-XXXX-XXXX-XXXX-XXXX` — ~80 bits, well above brute force for an
 *  operator-gated mint, and short enough to read aloud. */
export function generateLicenseKey(prefix = "CYRANO"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_GROUPS * CODE_GROUP_SIZE));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    groups.push(chars.slice(g * CODE_GROUP_SIZE, (g + 1) * CODE_GROUP_SIZE).join(""));
  }
  return `${prefix}-${groups.join("-")}`;
}

/** One license, stored in RegistryDO under `license:<sha256(key)>`. No secret
 *  lives here beyond the (hashed) key, and it holds at most one device slot —
 *  `deactivate` frees it so the key can move to another machine. */
export interface LicenseRecord {
  customer_email: string | null;
  created_at: string; // ISO 8601
  device_id: string | null;
  device_name: string | null;
  activated_at: string | null;
  last_seen_at: string | null;
  /** Set to revoke (refund/chargeback later); activate/validate then fail. */
  revoked_at?: string | null;
  /** The app version and platform this device last reported, from the same
   *  activate/validate calls that already carry its device id (adoption.ts).
   *  Release-adoption counting only — nothing reads these to decide
   *  entitlement, and a client that sends neither is treated exactly as
   *  before. */
  app_version?: string | null;
  platform?: string | null;
  /** The tenant identity minted for this license's live-relay opt-in
   * (the live-relay contract), if the user ever requested one. Stable for
   * the life of the license — re-requests rotate the token, never the
   * identity. Deactivation severs the token; this id survives so the same
   * identity is re-armed if the license re-activates. */
  relay_user_id?: string | null;
}

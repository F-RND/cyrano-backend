// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Promotional / test keys for an optional paid hosted tier. Uses a Crockford
// code format and month-based durations, adapted to Cyrano's token-as-identity
// model: a promo key is just
// a tenant token (see RegistryDO) minted with a `promoExpiresAt`, so it flows
// through the same entitlement + "Activate subscription" path as a real
// subscriber — no separate redemption step. Hand a tester one key; it works for
// N months, then the entitlement gate degrades it to on-device like a lapsed
// subscription.

/** Month-based promo durations → milliseconds. `0` months = unlimited (never
 * expires — for internal/comp keys); the mint stores no `promoExpiresAt`. */
export const PROMO_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Turn a month count into an expiry timestamp, or null for unlimited (0). */
export function promoExpiryFromMonths(months: number, now: number): number | null {
  const m = Math.floor(months);
  if (!Number.isFinite(m) || m <= 0) return null; // 0 / invalid = unlimited
  return now + m * PROMO_MONTH_MS;
}

// Crockford-style alphabet (drops the ambiguous 0, 1, I, O) so a code reads
// cleanly aloud and copy-pastes without confusion. 32 symbols * 12 positions
// ≈ 60 bits — well above brute-force for an operator-gated mint.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 3;
const CODE_GROUP_SIZE = 4;

/**
 * Generate a promo key in the form `CYRANO-XXXX-XXXX-XXXX`. This IS the bearer
 * token (stored hashed like any tenant token) — the pretty format is what a
 * tester pastes into "Activate subscription". ~60 bits of entropy, well above
 * brute-force for an operator-gated mint, and short enough to read aloud.
 */
export function generatePromoCode(prefix = "CYRANO"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_GROUPS * CODE_GROUP_SIZE));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    groups.push(chars.slice(g * CODE_GROUP_SIZE, (g + 1) * CODE_GROUP_SIZE).join(""));
  }
  return `${prefix}-${groups.join("-")}`;
}

// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, beforeAll } from "vitest";
import { signTrialToken, trialSigningConfigured, type TrialPayload } from "../src/trial.js";
import type { Env } from "../src/env.js";

// The trial token is the client's forgery lock: the Swift TrialManager verifies
// the Ed25519 signature over the RAW payload bytes with a compile-time-embedded
// public key. These tests pin the wire format the client depends on — a change
// that breaks any of them silently locks every trial in the field. We use only
// Web Crypto (the same API the Worker runs on), no node:crypto.

function u8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

// A throwaway keypair produced the same way the real keygen script does: a PKCS8
// private key for the Worker secret, and the raw 32-byte public key the Swift
// client verifies with (the trailing 32 bytes of the SPKI structure).
let env: Env;
let rawPublic: Uint8Array;

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", kp.publicKey)) as ArrayBuffer);
  rawPublic = spki.slice(spki.length - 32); // SPKI Ed25519 = 12-byte header + 32-byte key
  env = { TRIAL_SIGNING_PRIVATE_KEY: u8ToBase64(pkcs8) } as unknown as Env;
});

const payload: TrialPayload = {
  fingerprint: "a".repeat(64),
  issuedAt: "2026-07-16T00:00:00.000Z",
  expiresAt: "2026-07-19T00:00:00.000Z",
  heartbeatBy: "2026-07-16T12:00:00.000Z",
  nonce: "11111111-1111-1111-1111-111111111111",
};

async function verifyRaw(sig: Uint8Array, msg: Uint8Array): Promise<boolean> {
  const pubKey = await crypto.subtle.importKey("raw", rawPublic, { name: "Ed25519" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify({ name: "Ed25519" }, pubKey, sig, msg);
}

describe("signTrialToken", () => {
  it("emits `<base64url(payload)>.<base64url(sig)>` with a 64-byte Ed25519 signature", async () => {
    const token = await signTrialToken(env, payload);
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(base64UrlDecode(parts[1]!).length).toBe(64); // Ed25519 sig is 64 bytes
    expect(token).not.toMatch(/[+/=]/); // base64url, no standard-base64 chars
  });

  it("signs the exact payload bytes, so the raw 32-byte public key verifies them", async () => {
    const token = await signTrialToken(env, payload);
    const [payloadPart, sigPart] = token.split(".");
    expect(rawPublic.length).toBe(32);
    expect(await verifyRaw(base64UrlDecode(sigPart!), base64UrlDecode(payloadPart!))).toBe(true);
  });

  it("round-trips the payload the client JSON-parses, and rejects a tampered one", async () => {
    const token = await signTrialToken(env, payload);
    const [payloadPart, sigPart] = token.split(".");
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart!)));
    expect(decoded).toEqual(payload);

    // A forged expiry must NOT verify against the original signature.
    const forged = new TextEncoder().encode(
      JSON.stringify({ ...payload, expiresAt: "2099-01-01T00:00:00.000Z" }),
    );
    expect(await verifyRaw(base64UrlDecode(sigPart!), forged)).toBe(false);
  });
});

describe("trialSigningConfigured", () => {
  it("is true only when the private key secret is set — the routes' 503 guard", () => {
    expect(trialSigningConfigured(env)).toBe(true);
    expect(trialSigningConfigured({} as Env)).toBe(false);
  });
});

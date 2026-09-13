// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, beforeAll } from "vitest";
import {
  verifyAppleJWS,
  unsafeDecodeJWSPayload,
  AppleJWSError,
  APPLE_ROOT_CA_G3_SHA256,
} from "../src/appstore-jws.js";

// These tests build a REAL 3-certificate ECDSA chain at run time — WebCrypto
// keys, hand-assembled DER certificates, genuine signatures — and drive the
// public API end to end. Nothing is stubbed and no internals are exported for
// testing, so a bug in the DER reader or the DER→raw signature conversion shows
// up here as a failed verification rather than a passing unit test of a helper
// nobody calls that way.
//
// Web Crypto only, same as the Worker. No network.

const ENC = new TextEncoder();

// ---------------------------------------------------------------------------
// DER writers (the mirror of src/appstore-jws.ts's reader)
// ---------------------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function encodeLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat([new Uint8Array([tag]), encodeLength(content.length), content]);
}

function seq(...parts: Uint8Array[]): Uint8Array {
  return tlv(0x30, concat(parts));
}

function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(Number);
  const body: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunks: number[] = [];
    for (let v = arc; ; v = Math.floor(v / 128)) {
      chunks.unshift(v % 128);
      if (v < 128) break;
    }
    for (let i = 0; i < chunks.length - 1; i++) chunks[i]! |= 0x80;
    body.push(...chunks);
  }
  return tlv(0x06, new Uint8Array(body));
}

/** Big-endian bytes → a DER INTEGER: strip leading zeroes, then re-add one if
 *  the top bit would otherwise read as a negative number. */
function derInt(be: Uint8Array): Uint8Array {
  let i = 0;
  while (i < be.length - 1 && be[i] === 0) i++;
  const trimmed = be.subarray(i);
  return tlv(0x02, (trimmed[0]! & 0x80) !== 0 ? concat([new Uint8Array([0]), trimmed]) : trimmed);
}

function bitString(content: Uint8Array): Uint8Array {
  return tlv(0x03, concat([new Uint8Array([0]), content])); // 0 unused bits
}

/** WebCrypto hands back raw r||s; X.509 wants DER SEQUENCE { r, s }. */
function rawEcdsaToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return seq(derInt(raw.subarray(0, half)), derInt(raw.subarray(half)));
}

function derTime(ms: number): Uint8Array {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const tail =
    `${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
  const year = d.getUTCFullYear();
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050. The root below
  // deliberately runs past 2050 so both branches of the reader get exercised.
  return year < 2050
    ? tlv(0x17, ENC.encode(`${p2(year % 100)}${tail}`))
    : tlv(0x18, ENC.encode(`${year}${tail}`));
}

/** Name ::= SEQUENCE OF RelativeDistinguishedName; one CN is enough — the
 *  verifier skips names entirely, it only needs them to be well-formed DER. */
function distinguishedName(cn: string): Uint8Array {
  return seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, ENC.encode(cn)))));
}

// ---------------------------------------------------------------------------
// Certificate + JWS construction
// ---------------------------------------------------------------------------

type Curve = "P-256" | "P-384";
type Hash = "SHA-256" | "SHA-384";

const SIG_OID: Record<Hash, string> = {
  "SHA-256": "1.2.840.10045.4.3.2",
  "SHA-384": "1.2.840.10045.4.3.3",
};

async function keyPair(curve: Curve = "P-256"): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function signRaw(key: CryptoKey, hash: Hash, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash }, key, data));
}

/** ECDSA is randomised, so re-signing the same bytes eventually produces a
 *  signature whose coordinates have a chosen shape. Used to force both awkward
 *  DER INTEGER cases deterministically instead of hoping for them. */
async function signUntil(
  key: CryptoKey,
  hash: Hash,
  data: Uint8Array,
  wanted: (raw: Uint8Array, half: number) => boolean,
): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 5000; attempt++) {
    const raw = await signRaw(key, hash, data);
    if (wanted(raw, raw.length / 2)) return raw;
  }
  throw new Error("no signature with the requested coordinate shape");
}

interface CertSpec {
  subject: string;
  issuer: string;
  subjectPublicKey: CryptoKey;
  issuerPrivateKey: CryptoKey;
  hash: Hash;
  notBefore: number;
  notAfter: number;
  serial: number;
  /** Replaces the normal signing step; still produces a genuine signature. */
  sign?: (tbs: Uint8Array, issuerPrivateKey: CryptoKey) => Promise<Uint8Array>;
}

async function makeCert(spec: CertSpec): Promise<Uint8Array> {
  const sigAlg = seq(oid(SIG_OID[spec.hash]));
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", spec.subjectPublicKey)) as ArrayBuffer,
  );
  const tbs = seq(
    tlv(0xa0, derInt(new Uint8Array([2]))), // [0] EXPLICIT version, v3
    derInt(new Uint8Array([spec.serial])),
    sigAlg,
    distinguishedName(spec.issuer),
    seq(derTime(spec.notBefore), derTime(spec.notAfter)),
    distinguishedName(spec.subject),
    spki,
  );
  const raw = spec.sign
    ? await spec.sign(tbs, spec.issuerPrivateKey)
    : await signRaw(spec.issuerPrivateKey, spec.hash, tbs);
  return seq(tbs, sigAlg, bitString(rawEcdsaToDer(raw)));
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
const LEAF_FROM = NOW - 30 * DAY;
const LEAF_UNTIL = NOW + 30 * DAY;
const CA_FROM = NOW - 900 * DAY;

interface BuiltChain {
  /** [leaf, intermediate, root] — the order Apple sends. */
  x5c: string[];
  leafPrivateKey: CryptoKey;
  rootFingerprint: string;
  /** The raw signature actually placed on the leaf certificate. */
  leafCertSignature: Uint8Array;
}

async function buildChain(
  opts: {
    /** Hash the CAs sign with. Apple's real chain uses SHA-384 above the leaf. */
    chainHash?: Hash;
    /** Curve of the root and intermediate. Apple's real ones are P-384. */
    caCurve?: Curve;
    leafFrom?: number;
    leafUntil?: number;
    /** Sign the leaf certificate with a key that is not the intermediate's. */
    forgeLeafIssuer?: boolean;
    /** Shape the leaf certificate's signature coordinates. */
    leafSignatureShape?: (raw: Uint8Array, half: number) => boolean;
  } = {},
): Promise<BuiltChain> {
  const chainHash = opts.chainHash ?? "SHA-256";
  const caCurve = opts.caCurve ?? "P-256";

  const root = await keyPair(caCurve);
  const intermediate = await keyPair(caCurve);
  const rogue = await keyPair(caCurve);
  const leaf = await keyPair("P-256"); // ES256 signs the JWS, so the leaf is always P-256

  const rootDer = await makeCert({
    subject: "Cyrano Test Root",
    issuer: "Cyrano Test Root",
    subjectPublicKey: root.publicKey,
    issuerPrivateKey: root.privateKey,
    hash: chainHash,
    notBefore: CA_FROM,
    notAfter: Date.UTC(2060, 0, 1), // past 2050 → GeneralizedTime
    serial: 1,
  });
  const intermediateDer = await makeCert({
    subject: "Cyrano Test Intermediate",
    issuer: "Cyrano Test Root",
    subjectPublicKey: intermediate.publicKey,
    issuerPrivateKey: root.privateKey,
    hash: chainHash,
    notBefore: CA_FROM,
    notAfter: NOW + 400 * DAY,
    serial: 2,
  });

  // Annotated `ArrayBufferLike`: TS 5.7 made Uint8Array generic over its
  // buffer, so `new Uint8Array(0)` infers the narrower `Uint8Array<ArrayBuffer>`
  // and the signer's widened return type won't assign to it.
  let leafCertSignature: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const leafDer = await makeCert({
    subject: "Cyrano Test Leaf",
    issuer: "Cyrano Test Intermediate",
    subjectPublicKey: leaf.publicKey,
    issuerPrivateKey: opts.forgeLeafIssuer ? rogue.privateKey : intermediate.privateKey,
    hash: chainHash,
    notBefore: opts.leafFrom ?? LEAF_FROM,
    notAfter: opts.leafUntil ?? LEAF_UNTIL,
    serial: 3,
    sign: async (tbs, issuerPrivateKey) => {
      leafCertSignature = opts.leafSignatureShape
        ? await signUntil(issuerPrivateKey, chainHash, tbs, opts.leafSignatureShape)
        : await signRaw(issuerPrivateKey, chainHash, tbs);
      return leafCertSignature;
    },
  });

  return {
    x5c: [toBase64(leafDer), toBase64(intermediateDer), toBase64(rootDer)],
    leafPrivateKey: leaf.privateKey,
    rootFingerprint: await sha256Hex(rootDer),
    leafCertSignature,
  };
}

interface Payload {
  transactionId: string;
  bundleId: string;
  productId: string;
  expiresDate: number;
}

const PAYLOAD: Payload = {
  transactionId: "2000000901234567",
  bundleId: "com.example.copilot",
  productId: "com.example.copilot.pro.monthly",
  expiresDate: NOW + 30 * DAY,
};

async function makeJWS(opts: {
  chain: BuiltChain;
  payload?: unknown;
  alg?: unknown;
  x5c?: unknown;
  /** Replaces the JWS signature segment wholesale. */
  signature?: Uint8Array;
  /** Signs with something other than the leaf key. */
  signingKey?: CryptoKey;
}): Promise<string> {
  const header = toBase64Url(
    ENC.encode(
      JSON.stringify({ alg: opts.alg ?? "ES256", x5c: opts.x5c ?? opts.chain.x5c, typ: "JWT" }),
    ),
  );
  const body = toBase64Url(ENC.encode(JSON.stringify(opts.payload ?? PAYLOAD)));
  const signature =
    opts.signature ??
    (await signRaw(opts.signingKey ?? opts.chain.leafPrivateKey, "SHA-256", ENC.encode(`${header}.${body}`)));
  return `${header}.${body}.${toBase64Url(signature)}`;
}

/** Assert a rejection and hand back the error so its exact reason can be
 *  checked — `rejects.toThrow("chain_invalid")` would also pass on a message
 *  that merely contains the word. */
async function rejection(run: () => Promise<unknown>): Promise<AppleJWSError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(AppleJWSError);
    return err as AppleJWSError;
  }
  throw new Error("expected verifyAppleJWS to reject, but it resolved");
}

// ---------------------------------------------------------------------------

let chain: BuiltChain;

beforeAll(async () => {
  chain = await buildChain();
});

describe("verifyAppleJWS — happy path", () => {
  it("returns the decoded payload for a well-formed, correctly anchored JWS", async () => {
    const jws = await makeJWS({ chain });
    const payload = await verifyAppleJWS<Payload>(jws, {
      now: NOW,
      rootFingerprintSha256: chain.rootFingerprint,
    });
    expect(payload).toEqual(PAYLOAD);
  });

  it("defaults `now` to the wall clock", async () => {
    // Windows relative to real time, so this keeps passing next year.
    const live = await buildChain({ leafFrom: Date.now() - DAY, leafUntil: Date.now() + DAY });
    const jws = await makeJWS({ chain: live });
    await expect(
      verifyAppleJWS<Payload>(jws, { rootFingerprintSha256: live.rootFingerprint }),
    ).resolves.toEqual(PAYLOAD);
  });

  it("verifies Apple's real shape: P-384/SHA-384 CAs over a P-256/SHA-256 leaf", async () => {
    // Apple Root CA G3 and the WWDR G6 intermediate are both P-384 and sign with
    // SHA-384; only the leaf is P-256. A verifier that hardcoded P-256 for the
    // chain walk would pass every test above and fail against production.
    const mixed = await buildChain({ caCurve: "P-384", chainHash: "SHA-384" });
    const jws = await makeJWS({ chain: mixed });
    await expect(
      verifyAppleJWS<Payload>(jws, { now: NOW, rootFingerprintSha256: mixed.rootFingerprint }),
    ).resolves.toEqual(PAYLOAD);
  });
});

describe("verifyAppleJWS — DER ECDSA signature conversion", () => {
  // X.509 signatures are DER SEQUENCE { r, s } and WebCrypto wants raw r||s.
  // Both awkward INTEGER encodings are forced here rather than left to luck.

  it("left-pads a coordinate that DER encoded short (zero high byte)", async () => {
    const short = await buildChain({
      leafSignatureShape: (raw, half) => raw[0] === 0 || raw[half] === 0,
    });
    expect(
      short.leafCertSignature[0] === 0 ||
        short.leafCertSignature[short.leafCertSignature.length / 2] === 0,
    ).toBe(true);
    const jws = await makeJWS({ chain: short });
    await expect(
      verifyAppleJWS<Payload>(jws, { now: NOW, rootFingerprintSha256: short.rootFingerprint }),
    ).resolves.toEqual(PAYLOAD);
  });

  it("strips the 0x00 DER adds to a coordinate whose top bit is set", async () => {
    const padded = await buildChain({
      leafSignatureShape: (raw, half) => raw[0]! >= 0x80 && raw[half]! >= 0x80,
    });
    expect(padded.leafCertSignature[0]! >= 0x80).toBe(true);
    const jws = await makeJWS({ chain: padded });
    await expect(
      verifyAppleJWS<Payload>(jws, { now: NOW, rootFingerprintSha256: padded.rootFingerprint }),
    ).resolves.toEqual(PAYLOAD);
  });

  it("does NOT apply the conversion to the JWS signature, which is already raw", async () => {
    // A CORRECT signature over the CORRECT bytes, wrapped in DER the way an
    // X.509 signatureValue is. Everything about it verifies except the encoding,
    // so if the JWS path ran it through the certificate converter it would pass.
    const header = toBase64Url(ENC.encode(JSON.stringify({ alg: "ES256", x5c: chain.x5c })));
    const body = toBase64Url(ENC.encode(JSON.stringify(PAYLOAD)));
    const raw = await signRaw(chain.leafPrivateKey, "SHA-256", ENC.encode(`${header}.${body}`));
    const jws = `${header}.${body}.${toBase64Url(rawEcdsaToDer(raw))}`;
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: chain.rootFingerprint }),
        )
      ).message,
    ).toBe("signature_invalid");

    // …and the identical raw signature does verify, proving the difference is
    // the DER wrapper and nothing else.
    await expect(
      verifyAppleJWS<Payload>(`${header}.${body}.${toBase64Url(raw)}`, {
        now: NOW,
        rootFingerprintSha256: chain.rootFingerprint,
      }),
    ).resolves.toEqual(PAYLOAD);
  });
});

describe("verifyAppleJWS — rejections", () => {
  it("rejects a tampered payload with signature_invalid", async () => {
    const jws = await makeJWS({ chain });
    const [header, , signature] = jws.split(".");
    const forged = toBase64Url(
      ENC.encode(JSON.stringify({ ...PAYLOAD, productId: "com.example.copilot.pro.yearly" })),
    );
    const tampered = `${header}.${forged}.${signature}`;
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(tampered, { now: NOW, rootFingerprintSha256: chain.rootFingerprint }),
        )
      ).message,
    ).toBe("signature_invalid");
  });

  it("rejects a JWS signed by a key other than the leaf's", async () => {
    const impostor = await keyPair("P-256");
    const jws = await makeJWS({ chain, signingKey: impostor.privateKey });
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: chain.rootFingerprint }),
        )
      ).message,
    ).toBe("signature_invalid");
  });

  it("rejects an internally consistent chain that is not Apple's, with untrusted_root", async () => {
    // The whole threat: a forger can mint three valid certificates and sign
    // anything. Only the anchor fingerprint tells them apart.
    const jws = await makeJWS({ chain });
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: "00".repeat(32) }),
        )
      ).message,
    ).toBe("untrusted_root");
  });

  it("pins Apple Root CA G3 by default, so a synthetic root is refused", async () => {
    const jws = await makeJWS({ chain });
    expect((await rejection(() => verifyAppleJWS(jws, { now: NOW }))).message).toBe(
      "untrusted_root",
    );
  });

  it.each(["none", "RS256", "HS256", "ES384", ""])(
    "rejects alg %j with unsupported_alg",
    async (alg) => {
      const jws = await makeJWS({ chain, alg });
      expect(
        (
          await rejection(() =>
            verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: chain.rootFingerprint }),
          )
        ).message,
      ).toBe("unsupported_alg");
    },
  );

  it("rejects a missing alg with unsupported_alg", async () => {
    const header = toBase64Url(ENC.encode(JSON.stringify({ x5c: chain.x5c })));
    const body = toBase64Url(ENC.encode(JSON.stringify(PAYLOAD)));
    const sig = await signRaw(chain.leafPrivateKey, "SHA-256", ENC.encode(`${header}.${body}`));
    const jws = `${header}.${body}.${toBase64Url(sig)}`;
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: chain.rootFingerprint }),
        )
      ).message,
    ).toBe("unsupported_alg");
  });

  it("rejects a two-certificate chain with short_chain", async () => {
    const jws = await makeJWS({ chain, x5c: chain.x5c.slice(0, 2) });
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: chain.rootFingerprint }),
        )
      ).message,
    ).toBe("short_chain");
  });

  it("rejects an absurdly long chain with chain_invalid", async () => {
    // Caps the parsing an unauthenticated POST to /appstore/notifications buys.
    const jws = await makeJWS({ chain, x5c: Array.from({ length: 64 }, () => chain.x5c[0]!) });
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: chain.rootFingerprint }),
        )
      ).message,
    ).toBe("chain_invalid");
  });

  it("rejects an expired leaf with cert_expired", async () => {
    const jws = await makeJWS({ chain });
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, {
            now: LEAF_UNTIL + DAY,
            rootFingerprintSha256: chain.rootFingerprint,
          }),
        )
      ).message,
    ).toBe("cert_expired");
  });

  it("rejects a leaf that is not yet valid with cert_expired", async () => {
    const jws = await makeJWS({ chain });
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, {
            now: LEAF_FROM - DAY,
            rootFingerprintSha256: chain.rootFingerprint,
          }),
        )
      ).message,
    ).toBe("cert_expired");
  });

  it("rejects a leaf the supplied intermediate did not sign, with chain_invalid", async () => {
    const broken = await buildChain({ forgeLeafIssuer: true });
    const jws = await makeJWS({ chain: broken });
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: broken.rootFingerprint }),
        )
      ).message,
    ).toBe("chain_invalid");
  });

  it("rejects a chain whose certificates do not parse, with chain_invalid", async () => {
    const jws = await makeJWS({ chain, x5c: [toBase64(new Uint8Array([1, 2, 3, 4])), ...chain.x5c.slice(1)] });
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: chain.rootFingerprint }),
        )
      ).message,
    ).toBe("chain_invalid");
  });

  it.each([
    ["one segment", "not-a-jws"],
    ["two segments", "aGVhZGVy.cGF5bG9hZA"],
    ["four segments", "a.b.c.d"],
    ["empty segment", "aGVhZGVy..c2ln"],
    ["empty string", ""],
  ])("rejects %s with bad_format", async (_label, jws) => {
    expect((await rejection(() => verifyAppleJWS(jws, { now: NOW }))).message).toBe("bad_format");
  });

  it("rejects a header that is not JSON with bad_format", async () => {
    const jws = `${toBase64Url(ENC.encode("{not json"))}.${toBase64Url(ENC.encode("{}"))}.AAAA`;
    expect((await rejection(() => verifyAppleJWS(jws, { now: NOW }))).message).toBe("bad_format");
  });

  it.each([
    ["absent", undefined],
    ["not an array", "leafcert"],
    ["array of non-strings", [1, 2, 3]],
  ])("rejects an x5c that is %s with bad_format", async (_label, x5c) => {
    const header = toBase64Url(
      ENC.encode(JSON.stringify(x5c === undefined ? { alg: "ES256" } : { alg: "ES256", x5c })),
    );
    const jws = `${header}.${toBase64Url(ENC.encode("{}"))}.AAAA`;
    expect((await rejection(() => verifyAppleJWS(jws, { now: NOW }))).message).toBe("bad_format");
  });

  it("never leaks certificate or payload bytes into the error message", async () => {
    const broken = await buildChain({ forgeLeafIssuer: true });
    const jws = await makeJWS({ chain: broken });
    const err = await rejection(() =>
      verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: broken.rootFingerprint }),
    );
    expect(err.message).toMatch(/^[a-z_]+$/);
    expect(err.name).toBe("AppleJWSError");
  });
});

describe("unsafeDecodeJWSPayload", () => {
  it("returns the payload of a JWS whose signature is garbage — it does not verify", async () => {
    const jws = await makeJWS({ chain, signature: new Uint8Array(64).fill(0xff) });
    expect(unsafeDecodeJWSPayload<Payload>(jws)).toEqual(PAYLOAD);
    // Proof that the two functions genuinely differ: the same string is refused
    // by the verifying path.
    expect(
      (
        await rejection(() =>
          verifyAppleJWS(jws, { now: NOW, rootFingerprintSha256: chain.rootFingerprint }),
        )
      ).message,
    ).toBe("signature_invalid");
  });

  it("reads a payload with no certificate chain at all", () => {
    const jws = `${toBase64Url(ENC.encode('{"alg":"none"}'))}.${toBase64Url(
      ENC.encode('{"notificationType":"DID_RENEW"}'),
    )}.`;
    expect(unsafeDecodeJWSPayload<{ notificationType: string }>(jws)?.notificationType).toBe(
      "DID_RENEW",
    );
  });

  it.each([
    ["empty string", ""],
    ["single segment", "onlyonesegment"],
    ["non-base64 payload", "aGVhZGVy.!!!!.c2ln"],
    ["payload that is not JSON", `aGVhZGVy.${toBase64Url(ENC.encode("nope"))}.c2ln`],
    ["empty payload segment", "aGVhZGVy..c2ln"],
  ])("returns null for %s", (_label, jws) => {
    expect(unsafeDecodeJWSPayload(jws)).toBeNull();
  });
});

describe("APPLE_ROOT_CA_G3_SHA256", () => {
  it("is the published SHA-256 fingerprint of Apple Root CA G3, lowercase hex", () => {
    // Cross-checked against `openssl x509 -fingerprint -sha256` on the copy in
    // macOS's SystemRootCertificates keychain. If this constant is ever wrong,
    // every App Store notification silently fails with untrusted_root.
    expect(APPLE_ROOT_CA_G3_SHA256).toBe(
      "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179",
    );
    expect(APPLE_ROOT_CA_G3_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

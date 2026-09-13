// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// JWS verification for Apple's signed App Store payloads — App Store Server API
// transactions and App Store Server Notifications V2. The companion of
// appstore.ts, which treats a verified payload as the only source of entitlement
// truth and believes nothing the client says.
//
// Apple delivers these as JWS compact serialization (`header.payload.signature`,
// base64url). The JOSE header carries `x5c`: the signing chain as standard-base64
// DER, ordered [leaf, intermediate, root]. There is no JWKS to fetch and no key
// endpoint — the chain travels inside the message. So a chain that verifies
// against itself proves NOTHING; anyone can mint three certificates and sign
// whatever they like. The single fact that makes any of it trustworthy is
// pinning the root to Apple Root CA G3 by fingerprint. Everything else in this
// file exists to support that one check.
//
// WebCrypto has no X.509 parser and Workers has no node:crypto X509, so this
// hand-rolls just enough DER to pull four things out of each certificate: the
// tbsCertificate byte range (the bytes the issuer actually signed), the
// signatureValue, the SubjectPublicKeyInfo (handed straight to
// importKey("spki")), and the notBefore/notAfter window.
//
// TESTS (test/appstore-jws.test.ts) take the first of the two approaches the
// brief allowed: a real synthetic 3-certificate chain built at test time from
// WebCrypto keys and hand-assembled DER, used to sign a real JWS and drive the
// exported API end to end. No internals are exported for testing, nothing is
// stubbed, and nothing touches the network.
//
// Known non-goals: Apple's own server libraries additionally require the leaf to
// carry the 1.2.840.113635.100.6.11.1 receipt-signing extension and consult OCSP.
// Neither happens here. The anchor pin plus the chain-link and validity-window
// checks are what stop a forged payload; the extension check would only narrow
// *which* Apple-issued leaf is acceptable, and OCSP is a network call this
// Worker cannot afford on a webhook path.

/**
 * Every rejection throws this. The message is a short, stable reason code and is
 * safe to log: it never carries certificate bytes, payload contents, or any
 * other attacker-supplied material. Callers log `err.message` and return a
 * generic failure to the client.
 *
 * Vocabulary: `bad_format` (not a well-formed JWS), `unsupported_alg`,
 * `short_chain`, `untrusted_root`, `chain_invalid` (a certificate would not
 * parse, or a link in the chain does not verify), `signature_invalid`,
 * `cert_expired`.
 */
export class AppleJWSError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AppleJWSError";
  }
}

/**
 * SHA-256 fingerprint of `Apple Root CA - G3` (the DER of the whole certificate,
 * which is what `openssl x509 -fingerprint -sha256` prints). Lowercase hex, no
 * colons. This is the trust anchor: `x5c`'s last entry must hash to exactly
 * this, or the chain is a stranger's.
 *
 * Serial 0x2dc5fc88d2c54b95, valid 2014-04-30 to 2039-04-30. Overridable per
 * call so tests can anchor a synthetic chain — never override it in production.
 */
export const APPLE_ROOT_CA_G3_SHA256 =
  "63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179";

export interface VerifiedJWS<T> {
  payload: T;
  /** Leaf certificate's notAfter, ms since epoch. */
  leafNotAfter: number;
}

/** See the length check in verifyCompact for why there is an upper bound. */
const MAX_CHAIN_LENGTH = 10;

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

/** One decoder for both alphabets: JWS segments are base64url and `x5c` entries
 *  are standard base64. Accepting either everywhere is harmless — the bytes
 *  still have to parse as a certificate and verify — and beats two near-copies. */
function decodeBase64(s: string): Uint8Array {
  const normalized = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

// ---------------------------------------------------------------------------
// DER / ASN.1
// ---------------------------------------------------------------------------

/** One tag-length-value triple, as offsets into the buffer it was read from.
 *  Offsets rather than copies because the tbsCertificate has to be handed to
 *  `verify` as the exact original bytes — re-encoding a parse of it would change
 *  them and every signature would fail. */
interface DerTLV {
  tag: number;
  /** Offset of the tag byte. */
  start: number;
  /** Offset of the first content byte. */
  contentStart: number;
  /** One past the last content byte — i.e. where the next sibling begins. */
  end: number;
}

function readTLV(buf: Uint8Array, offset: number): DerTLV {
  if (offset + 2 > buf.length) throw new AppleJWSError("chain_invalid");
  const tag = buf[offset]!;
  // High-tag-number form. Nothing on the path to the fields we read uses it, so
  // refusing is safer (and shorter) than implementing it.
  if ((tag & 0x1f) === 0x1f) throw new AppleJWSError("chain_invalid");

  let i = offset + 1;
  const first = buf[i]!;
  i += 1;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else {
    const n = first & 0x7f;
    // n === 0 is BER's indefinite length, forbidden in DER; n > 4 would exceed
    // what a JS array index can address anyway.
    if (n === 0 || n > 4 || i + n > buf.length) throw new AppleJWSError("chain_invalid");
    length = 0;
    for (let k = 0; k < n; k++) length = length * 256 + buf[i + k]!;
    i += n;
  }

  const end = i + length;
  if (end > buf.length) throw new AppleJWSError("chain_invalid");
  return { tag, start: offset, contentStart: i, end };
}

/** The direct children of a constructed element, read left to right. */
function readChildren(buf: Uint8Array, parent: DerTLV): DerTLV[] {
  const out: DerTLV[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = readTLV(buf, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

/** Decode an OBJECT IDENTIFIER to dotted-decimal. */
function readOid(buf: Uint8Array, tlv: DerTLV): string {
  if (tlv.tag !== 0x06 || tlv.contentStart >= tlv.end) throw new AppleJWSError("chain_invalid");
  const arcs: number[] = [];
  let acc = 0;
  for (let i = tlv.contentStart; i < tlv.end; i++) {
    const b = buf[i]!;
    // Base-128 big-endian; the high bit marks "more bytes follow".
    acc = acc * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      if (arcs.length === 0) {
        // The first two arcs share one subidentifier: 40*arc1 + arc2, with arc1
        // capped at 2 (arc 2 is open-ended, so arc2 can exceed 39).
        const arc1 = Math.min(Math.floor(acc / 40), 2);
        arcs.push(arc1, acc - arc1 * 40);
      } else {
        arcs.push(acc);
      }
      acc = 0;
    }
  }
  return arcs.join(".");
}

/** UTCTime / GeneralizedTime → ms since epoch. */
function readTime(buf: Uint8Array, tlv: DerTLV): number {
  const text = new TextDecoder().decode(buf.subarray(tlv.contentStart, tlv.end));
  let year: number;
  let rest: RegExpExecArray | null;
  if (tlv.tag === 0x17) {
    // UTCTime, YYMMDDHHMMSSZ. RFC 5280 pins the two-digit year: >= 50 is 19xx.
    rest = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (!rest) throw new AppleJWSError("chain_invalid");
    const yy = Number(rest[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (tlv.tag === 0x18) {
    // GeneralizedTime, YYYYMMDDHHMMSSZ — used for 2050 and beyond.
    rest = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
    if (!rest) throw new AppleJWSError("chain_invalid");
    year = Number(rest[1]);
  } else {
    throw new AppleJWSError("chain_invalid");
  }
  return Date.UTC(
    year,
    Number(rest[2]) - 1,
    Number(rest[3]),
    Number(rest[4]),
    Number(rest[5]),
    Number(rest[6]),
  );
}

// ---------------------------------------------------------------------------
// ECDSA signature shape
// ---------------------------------------------------------------------------

type SupportedCurve = "P-256" | "P-384" | "P-521";

const CURVE_BY_OID: Record<string, SupportedCurve> = {
  "1.2.840.10045.3.1.7": "P-256", // prime256v1
  "1.3.132.0.34": "P-384", // secp384r1
  "1.3.132.0.35": "P-521", // secp521r1
};

/** Size of one coordinate, and therefore of each half of a raw r||s signature. */
const COORD_BYTES: Record<SupportedCurve, number> = { "P-256": 32, "P-384": 48, "P-521": 66 };

const HASH_BY_SIGNATURE_OID: Record<string, "SHA-256" | "SHA-384" | "SHA-512"> = {
  "1.2.840.10045.4.3.2": "SHA-256", // ecdsa-with-SHA256
  "1.2.840.10045.4.3.3": "SHA-384", // ecdsa-with-SHA384
  "1.2.840.10045.4.3.4": "SHA-512", // ecdsa-with-SHA512
};

const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";

/**
 * X.509 signs ECDSA as DER `SEQUENCE { r INTEGER, s INTEGER }`; WebCrypto's
 * ECDSA verify wants raw fixed-width `r||s`. Converting is where this kind of
 * code usually breaks, because DER INTEGERs are *signed and minimal*:
 *
 *   - a coordinate whose top bit is set gets a 0x00 prefix so it is not read as
 *     negative, making it 33 bytes for P-256 rather than 32; and
 *   - a coordinate with leading zero bytes is encoded short — roughly 1 in 256
 *     signatures has a 31-byte r or s.
 *
 * So each INTEGER must be stripped of leading zeroes and then LEFT-padded back
 * out to the curve's coordinate width. Right-padding, or blindly slicing 32
 * bytes, produces a converter that works ~99% of the time and then rejects a
 * valid Apple notification at random.
 *
 * `coordBytes` comes from the ISSUER's curve — the key that produced the
 * signature — not the certificate being verified.
 */
function derEcdsaToRaw(der: Uint8Array, coordBytes: number): Uint8Array {
  const seq = readTLV(der, 0);
  if (seq.tag !== 0x30 || seq.end !== der.length) throw new AppleJWSError("chain_invalid");
  const parts = readChildren(der, seq);
  if (parts.length !== 2) throw new AppleJWSError("chain_invalid");

  const raw = new Uint8Array(coordBytes * 2);
  for (let i = 0; i < 2; i++) {
    const part = parts[i]!;
    if (part.tag !== 0x02 || part.contentStart >= part.end) {
      throw new AppleJWSError("chain_invalid");
    }
    // A high bit set on the FIRST byte means the encoder meant a negative
    // number, which is never a valid ECDSA scalar. Checked before stripping,
    // since stripping a legitimate 0x00 pad reveals a high bit on purpose.
    if ((der[part.contentStart]! & 0x80) !== 0) throw new AppleJWSError("chain_invalid");

    let from = part.contentStart;
    while (from < part.end - 1 && der[from] === 0) from++;
    const width = part.end - from;
    if (width > coordBytes) throw new AppleJWSError("chain_invalid");
    raw.set(der.subarray(from, part.end), coordBytes * (i + 1) - width);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

interface ParsedCert {
  /** The whole certificate, DER. Hashed for the anchor fingerprint. */
  der: Uint8Array;
  /** tbsCertificate INCLUDING its tag and length — the exact bytes signed. */
  tbs: Uint8Array;
  /** SubjectPublicKeyInfo, DER, ready for importKey("spki", ...). */
  spki: Uint8Array;
  /** Curve of this certificate's own public key. */
  curve: SupportedCurve;
  /** Hash used by the ISSUER when signing this certificate. */
  hash: "SHA-256" | "SHA-384" | "SHA-512";
  /** signatureValue, still DER `SEQUENCE { r, s }`. */
  signature: Uint8Array;
  notBefore: number;
  notAfter: number;
}

/**
 * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 * TBSCertificate ::= SEQUENCE { [0] version, serialNumber, signature, issuer,
 *                               validity, subject, subjectPublicKeyInfo, ... }
 *
 * Only the fields above are read; extensions, issuer and subject names are
 * skipped wholesale. Anything malformed is `chain_invalid` — a certificate we
 * cannot parse is a certificate we will not trust.
 */
function parseCertificate(der: Uint8Array): ParsedCert {
  const cert = readTLV(der, 0);
  if (cert.tag !== 0x30) throw new AppleJWSError("chain_invalid");
  const top = readChildren(der, cert);
  if (top.length !== 3) throw new AppleJWSError("chain_invalid");
  const [tbsTLV, sigAlgTLV, sigTLV] = top as [DerTLV, DerTLV, DerTLV];

  // signatureAlgorithm ::= SEQUENCE { algorithm OID, parameters ABSENT }
  if (sigAlgTLV.tag !== 0x30) throw new AppleJWSError("chain_invalid");
  const sigAlgOid = readOid(der, readTLV(der, sigAlgTLV.contentStart));
  const hash = HASH_BY_SIGNATURE_OID[sigAlgOid];
  // RSA-signed certificates land here too. Apple's App Store chain is entirely
  // ECDSA, so anything else is not a chain we know how to check.
  if (!hash) throw new AppleJWSError("chain_invalid");

  // signatureValue is a BIT STRING whose first content byte counts unused bits;
  // for a DER signature that is always 0.
  if (sigTLV.tag !== 0x03 || sigTLV.contentStart >= sigTLV.end || der[sigTLV.contentStart] !== 0) {
    throw new AppleJWSError("chain_invalid");
  }
  const signature = der.slice(sigTLV.contentStart + 1, sigTLV.end);

  if (tbsTLV.tag !== 0x30) throw new AppleJWSError("chain_invalid");
  const fields = readChildren(der, tbsTLV);
  // [0] EXPLICIT version is optional (absent means v1); everything after it
  // shifts by one when present.
  let i = fields[0]?.tag === 0xa0 ? 1 : 0;
  i += 1; // serialNumber
  i += 1; // signature (AlgorithmIdentifier, duplicate of the outer one)
  i += 1; // issuer
  const validityTLV = fields[i++];
  i += 1; // subject
  const spkiTLV = fields[i];
  if (!validityTLV || !spkiTLV) throw new AppleJWSError("chain_invalid");

  // Validity ::= SEQUENCE { notBefore Time, notAfter Time }
  if (validityTLV.tag !== 0x30) throw new AppleJWSError("chain_invalid");
  const window = readChildren(der, validityTLV);
  if (window.length !== 2) throw new AppleJWSError("chain_invalid");
  const notBefore = readTime(der, window[0]!);
  const notAfter = readTime(der, window[1]!);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    throw new AppleJWSError("chain_invalid");
  }

  // SubjectPublicKeyInfo ::= SEQUENCE { AlgorithmIdentifier, BIT STRING }
  // AlgorithmIdentifier ::= SEQUENCE { id-ecPublicKey, namedCurve OID }
  if (spkiTLV.tag !== 0x30) throw new AppleJWSError("chain_invalid");
  const spkiParts = readChildren(der, spkiTLV);
  if (spkiParts.length !== 2 || spkiParts[0]!.tag !== 0x30) {
    throw new AppleJWSError("chain_invalid");
  }
  const keyAlg = readChildren(der, spkiParts[0]!);
  if (keyAlg.length !== 2 || readOid(der, keyAlg[0]!) !== OID_EC_PUBLIC_KEY) {
    throw new AppleJWSError("chain_invalid");
  }
  const curve = CURVE_BY_OID[readOid(der, keyAlg[1]!)];
  if (!curve) throw new AppleJWSError("chain_invalid");

  return {
    der,
    // slice(), not subarray(): these are handed to WebCrypto and to digest(),
    // and standalone buffers remove a whole class of byteOffset mistakes.
    tbs: der.slice(tbsTLV.start, tbsTLV.end),
    spki: der.slice(spkiTLV.start, spkiTLV.end),
    curve,
    hash,
    signature,
    notBefore,
    notAfter,
  };
}

/** True when `issuer`'s public key signed `child`'s tbsCertificate. */
async function issuerSigned(child: ParsedCert, issuer: ParsedCert): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      issuer.spki,
      { name: "ECDSA", namedCurve: issuer.curve },
      false,
      ["verify"],
    );
    const raw = derEcdsaToRaw(child.signature, COORD_BYTES[issuer.curve]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: child.hash }, key, raw, child.tbs);
  } catch {
    // importKey rejects a malformed SPKI and derEcdsaToRaw rejects a malformed
    // signature; either way this link does not hold.
    return false;
  }
}

// ---------------------------------------------------------------------------
// JWS
// ---------------------------------------------------------------------------

interface JoseHeader {
  alg?: unknown;
  x5c?: unknown;
}

function splitCompact(jws: string): [string, string, string] {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new AppleJWSError("bad_format");
  }
  return parts as [string, string, string];
}

function decodeJsonSegment(segment: string): unknown {
  let text: string;
  try {
    text = new TextDecoder().decode(decodeBase64(segment));
  } catch {
    throw new AppleJWSError("bad_format");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppleJWSError("bad_format");
  }
}

/**
 * Verify one of Apple's signed payloads and return its decoded body.
 *
 * The checks, in the order they run:
 *   1. compact form parses, and the header declares ES256;
 *   2. `x5c` holds at least [leaf, intermediate, root];
 *   3. every certificate parses;
 *   4. the LAST certificate is Apple Root CA G3 by SHA-256 fingerprint;
 *   5. every certificate's validity window contains `now`;
 *   6. each certificate is signed by the next one along;
 *   7. the JWS signature over `header.payload` verifies under the leaf's key.
 *
 * Step 4 runs before any of the chain arithmetic on purpose. It is *the* trust
 * decision and it costs one hash, so an attacker-supplied chain is thrown out
 * before we spend elliptic-curve work on it.
 *
 * @param opts.now ms since epoch for the validity comparison; defaults to
 *   `Date.now()`. Supplied by tests so expiry cases are deterministic.
 * @param opts.rootFingerprintSha256 overrides the pinned anchor. For tests only.
 */
export async function verifyAppleJWS<T>(
  jws: string,
  opts?: { now?: number; rootFingerprintSha256?: string },
): Promise<T> {
  const result = await verifyCompact<T>(jws, opts ?? {});
  return result.payload;
}

async function verifyCompact<T>(
  jws: string,
  opts: { now?: number; rootFingerprintSha256?: string },
): Promise<VerifiedJWS<T>> {
  const now = opts.now ?? Date.now();
  const expectedRoot = (opts.rootFingerprintSha256 ?? APPLE_ROOT_CA_G3_SHA256)
    .replace(/[\s:]/g, "")
    .toLowerCase();

  const [headerSegment, payloadSegment, signatureSegment] = splitCompact(jws);

  const header = decodeJsonSegment(headerSegment) as JoseHeader | null;
  if (!header || typeof header !== "object") throw new AppleJWSError("bad_format");

  // ES256 is hardcoded, never selected from `alg`. Trusting the header to pick
  // the algorithm is the classic JWT break: "none" verifies everything, and
  // naming an HMAC turns the leaf's PUBLIC key into the shared secret an
  // attacker already has. `alg` here is only ever compared, never dispatched on.
  if (header.alg !== "ES256") throw new AppleJWSError("unsupported_alg");

  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.some((entry) => typeof entry !== "string")) {
    throw new AppleJWSError("bad_format");
  }
  // Apple always sends leaf + intermediate + root. Fewer means the chain cannot
  // reach the anchor, and a two-entry chain is exactly what a forger sends when
  // hoping the root check is skipped.
  if (x5c.length < 3) throw new AppleJWSError("short_chain");
  // The upper bound is not about correctness — it caps the parsing work an
  // unauthenticated caller can buy on the public notifications endpoint, which
  // anyone can POST to. Three is the real answer; ten leaves room for Apple to
  // lengthen the chain without a deploy.
  if (x5c.length > MAX_CHAIN_LENGTH) throw new AppleJWSError("chain_invalid");

  const chain = (x5c as string[]).map((entry) => {
    let der: Uint8Array;
    try {
      der = decodeBase64(entry);
    } catch {
      throw new AppleJWSError("chain_invalid");
    }
    return parseCertificate(der);
  });

  const leaf = chain[0]!;
  const root = chain[chain.length - 1]!;

  if ((await sha256Hex(root.der)) !== expectedRoot) throw new AppleJWSError("untrusted_root");

  for (const cert of chain) {
    if (now < cert.notBefore || now > cert.notAfter) throw new AppleJWSError("cert_expired");
  }

  for (let i = 0; i < chain.length - 1; i++) {
    if (!(await issuerSigned(chain[i]!, chain[i + 1]!))) {
      throw new AppleJWSError("chain_invalid");
    }
  }

  let signature: Uint8Array;
  try {
    signature = decodeBase64(signatureSegment);
  } catch {
    throw new AppleJWSError("bad_format");
  }
  // Unlike an X.509 signatureValue, a JWS signature is ALREADY raw r||s
  // (RFC 7515 §3.1 / RFC 7518 §3.4) — 64 bytes for ES256. Running it through
  // derEcdsaToRaw would be wrong; length is the only shaping it needs.
  if (signature.length !== COORD_BYTES["P-256"] * 2) throw new AppleJWSError("signature_invalid");

  let ok = false;
  try {
    // P-256 is hardcoded for the same reason ES256 is: the leaf's declared curve
    // must not get a vote in how its own signature is checked.
    const leafKey = await crypto.subtle.importKey(
      "spki",
      leaf.spki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      leafKey,
      signature,
      // The signing input is the ORIGINAL encoded segments verbatim. Re-encoding
      // a parsed header or payload would change the bytes and never verify.
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    );
  } catch {
    ok = false; // a leaf that is not a P-256 EC key cannot have produced an ES256 signature
  }
  if (!ok) throw new AppleJWSError("signature_invalid");

  return { payload: decodeJsonSegment(payloadSegment) as T, leafNotAfter: leaf.notAfter };
}

/**
 * Decode the payload WITHOUT verifying anything — no signature, no chain, no
 * anchor, no expiry.
 *
 * The result is attacker-controlled. It is legitimate only for reading an
 * identifier before verification (logging a notificationType, finding a
 * transactionId to look up) and NEVER for a trust decision: entitlements,
 * plans, expiry dates and bundle ids must all come from `verifyAppleJWS`.
 *
 * Returns null rather than throwing, because every caller of this is on a path
 * that has something better to do than fail.
 */
export function unsafeDecodeJWSPayload<T>(jws: string): T | null {
  try {
    const parts = jws.split(".");
    if (parts.length < 2 || !parts[1]) return null;
    return JSON.parse(new TextDecoder().decode(decodeBase64(parts[1]))) as T;
  } catch {
    return null;
  }
}

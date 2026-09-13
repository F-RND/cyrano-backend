// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Release adoption: how many devices are running each shipped version.
//
// WHY THIS AND NOT UPDATER HITS. The obvious place to count a release is the
// updater, but the manifest poll (apple/CyranoMac/Update/UpdateChecker.swift)
// is a static GET on the DO Spaces bucket that carries no device and no
// installed version, fires hourly per running app, and never reaches a server
// we can query. Counting it measures app-running-hours, not people.
//
// So we count where the app ALREADY identifies itself once an hour: the Pro
// license revalidation (`/license/validate`, device-bound) and the free-trial
// heartbeat (`/trial/heartbeat`, fingerprint-bound). Both records already
// carry a device identity and a `last_seen_at`. Adding the app's own version
// string to those two calls turns records we already keep into an exact
// "N distinct devices are on 1.0.152 today" — no new request, no new
// identifier, no new stored subject. That is the whole design constraint: this
// may never become a reason to learn something about a device that licensing
// did not already require.
//
// COVERAGE, HONESTLY. This sees licensed devices and in-flight trials. It does
// not see a free user who never started a trial (they hold no credential and
// call nothing on a schedule — deliberately), a Homebrew-cask install between
// trial end and purchase, or the Linux build (it speaks to no licensing
// route). App Store SKUs report here too, but App Store Connect is the
// authoritative number for those.

/** Versions we accept from a client. Deliberately narrow: this string is
 *  echoed into an operator view, so it may not be a place to stash text. */
const VERSION_PATTERN = /^\d{1,4}(\.\d{1,5}){0,3}$/;

/** Where the app says it is running. An allowlist, for the same reason. The
 *  Mac App Store SKU is its own entry because it updates through a channel the
 *  in-app updater does not drive — folding it in would misread the adoption
 *  curve this exists to produce. `linux` is reserved: the Linux build speaks to
 *  no licensing route today, so nothing sends it yet. */
const PLATFORMS = new Set(["mac", "mac-appstore", "ios", "linux"]);

/** Bucket label for a device that reported nothing. Until a release carrying
 *  the client half of this ships, every device lands here — and afterwards the
 *  bucket is itself the "still on an older build" count. */
export const UNKNOWN = "unknown";

export function normalizeAppVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return VERSION_PATTERN.test(trimmed) ? trimmed : null;
}

export function normalizePlatform(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return PLATFORMS.has(trimmed) ? trimmed : null;
}

export type AdoptionSource = "license" | "trial";

/** One device's last known state, read off a license or trial record. */
export interface AdoptionSighting {
  version?: string | null;
  platform?: string | null;
  /** ISO 8601. A record with no last_seen_at has never checked in and is not
   *  a device — it is an unclaimed license key. */
  lastSeenAt?: string | null;
  source: AdoptionSource;
}

export interface AdoptionRow {
  version: string;
  platform: string;
  devices: number;
  licensed: number;
  trial: number;
  active_1d: number;
  active_7d: number;
  last_seen_at: string;
}

export interface AdoptionSummary {
  generated_at: string;
  window_days: number;
  totals: {
    devices: number;
    licensed: number;
    trial: number;
    /** Devices in-window that reported no usable version — i.e. still on a
     *  build from before this shipped, or a client that sent junk. */
    unknown_version: number;
  };
  versions: AdoptionRow[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fold per-device sightings into per-(version, platform) device counts over a
 * window. Pure, so the aggregation is testable without a Durable Object.
 *
 * One device counts once per row it appears in. A device that trialed and then
 * bought holds BOTH a trial record and a license record for the remainder of
 * the trial window, and the two identities (hardware fingerprint vs license
 * device id) are different id spaces we cannot join — so `devices` can
 * overcount that overlap by at most the number of trials in flight. The
 * `licensed` / `trial` split is reported alongside it precisely so the size of
 * that overlap stays visible instead of hiding inside one number.
 */
export function summarizeAdoption(
  sightings: Iterable<AdoptionSighting>,
  opts: { now: number; windowDays: number },
): AdoptionSummary {
  const windowDays = Math.max(1, Math.min(365, Math.floor(opts.windowDays)));
  const cutoff = opts.now - windowDays * DAY_MS;
  const rows = new Map<string, AdoptionRow>();
  const totals = { devices: 0, licensed: 0, trial: 0, unknown_version: 0 };

  for (const sighting of sightings) {
    if (!sighting.lastSeenAt) continue;
    const seen = Date.parse(sighting.lastSeenAt);
    if (!Number.isFinite(seen) || seen < cutoff) continue;

    const version = normalizeAppVersion(sighting.version) ?? UNKNOWN;
    const platform = normalizePlatform(sighting.platform) ?? UNKNOWN;
    const rowKey = `${version}\0${platform}`;
    const row = rows.get(rowKey) ?? {
      version,
      platform,
      devices: 0,
      licensed: 0,
      trial: 0,
      active_1d: 0,
      active_7d: 0,
      last_seen_at: sighting.lastSeenAt,
    };

    row.devices += 1;
    if (sighting.source === "license") row.licensed += 1;
    else row.trial += 1;
    if (seen >= opts.now - DAY_MS) row.active_1d += 1;
    if (seen >= opts.now - 7 * DAY_MS) row.active_7d += 1;
    if (seen > Date.parse(row.last_seen_at)) row.last_seen_at = sighting.lastSeenAt;
    rows.set(rowKey, row);

    totals.devices += 1;
    if (sighting.source === "license") totals.licensed += 1;
    else totals.trial += 1;
    if (version === UNKNOWN) totals.unknown_version += 1;
  }

  return {
    generated_at: new Date(opts.now).toISOString(),
    window_days: windowDays,
    totals,
    versions: [...rows.values()].sort(compareRows),
  };
}

/** Newest release first — the top row answers "how many took the latest
 *  update?" without reading the table. Unknown sinks to the bottom. */
function compareRows(a: AdoptionRow, b: AdoptionRow): number {
  if (a.version !== b.version) {
    if (a.version === UNKNOWN) return 1;
    if (b.version === UNKNOWN) return -1;
    return compareVersionsDesc(a.version, b.version);
  }
  if (a.platform !== b.platform) return a.platform.localeCompare(b.platform);
  return b.devices - a.devices;
}

function compareVersionsDesc(a: string, b: string): number {
  const left = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const right = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

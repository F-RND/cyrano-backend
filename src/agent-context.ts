// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

import type { AskExtraction, Speaker, TranscriptSegment } from "./types.js";

/**
 * The agent-facing projection of a live session (2026-07-28 integration
 * review). Three things went wrong when a remote MCP client tried to answer a
 * focused question about a long session, and all three live here:
 *
 *  1. The context payload was a fixed 40-segment TAIL. `hot_state` cited
 *     source_seqs from far earlier in the conversation, and there was no way to
 *     ask for the transcript around them — the model could see that the
 *     evidence existed and could not fetch it. Hence the query language below
 *     (since/around/search + explicit range metadata).
 *  2. Every human on the far end of a call read as "SYSTEM". The slot→name map
 *     is on-device by design (privacy invariant #4: only the integer slot ever
 *     crosses the wire), so the server cannot send a name — but it can stop
 *     handing the model a word that means "not a person".
 *  3. `confidence` on a transcript segment is DIARIZATION confidence, and a
 *     consumer reasonably read `1` as "this text is certainly what was said".
 *     It is renamed here so nothing can make that mistake again.
 *
 * Everything in this file is a pure function over already-fetched state, so it
 * is unit-testable without a Durable Object.
 */

/** Hard ceiling on segments in one context response, across the window and any
 * matched spans. A remote MCP client pays for every token of this. */
export const MAX_AGENT_SEGMENTS = 300;
/** Default tail when the caller asks for nothing in particular — the historical
 * behaviour, kept so an existing poller sees no change. */
export const DEFAULT_AGENT_SEGMENTS = 40;
const MAX_SPAN = 100;
const DEFAULT_AROUND_SPAN = 12;
const DEFAULT_SEARCH_SPAN = 6;
const MAX_SEARCH_TERMS = 8;
const MAX_SEARCH_SPANS = 8;

export interface AgentContextQuery {
  /** Cap on segments in the main window. */
  limit: number;
  /** Everything after this seq (exclusive). */
  sinceSeq: number | null;
  /** Everything up to this seq (inclusive). */
  untilSeq: number | null;
  /**
   * Centres of ±span windows — the "resolve these source_seqs" case. One seq
   * defines the main window (the caller wants to read that spot); several
   * become spans, so a workflow can pull the ground behind every seq the
   * extracted state cites in a single round trip.
   */
  aroundSeqs: number[];
  /** Radius for `aroundSeq` and for each search hit. */
  span: number | null;
  /** Keyword terms; each matching segment is returned with its neighbours. */
  search: string[];
}

function intParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.trunc(value);
}

export function parseAgentContextQuery(params: URLSearchParams): AgentContextQuery {
  const limitRaw = intParam(params, "limit");
  const spanRaw = intParam(params, "span");
  const sinceSeq = intParam(params, "since_seq");
  const untilSeq = intParam(params, "until_seq");
  const aroundSeqs = [...new Set(
    (params.get("around_seq") ?? "")
      .split(/[,\s]+/)
      // Number("") is 0, so an absent or trailing-comma value would otherwise
      // silently become "the lines around seq 0" — a window nobody asked for.
      .filter((raw) => raw.trim().length > 0)
      .map((raw) => Number(raw))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .map((value) => Math.trunc(value)),
  )].sort((a, b) => a - b).slice(0, MAX_SEARCH_SPANS);
  // Comma OR whitespace separated: a model writes both, and neither reading is
  // wrong. Terms are matched case-insensitively as substrings.
  const search = (params.get("search") ?? params.get("q") ?? "")
    .split(/[,\n]+|\s{2,}/)
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 2)
    .slice(0, MAX_SEARCH_TERMS);

  return {
    limit: limitRaw === null
      ? DEFAULT_AGENT_SEGMENTS
      : Math.min(Math.max(limitRaw, 1), MAX_AGENT_SEGMENTS),
    sinceSeq: sinceSeq !== null && sinceSeq >= 0 ? sinceSeq : null,
    untilSeq: untilSeq !== null && untilSeq >= 0 ? untilSeq : null,
    aroundSeqs,
    span: spanRaw === null ? null : Math.min(Math.max(spanRaw, 0), MAX_SPAN),
    search,
  };
}

/**
 * What the speaker label MEANS, in words a model can attribute correctly.
 *
 * "SYSTEM" is Cyrano's word for "arrived on the captured system-audio feed" —
 * i.e. the people on the other end of the call. Handing that raw token to an
 * assistant produced summaries that attributed a colleague's words to a
 * machine. The name of that colleague is on-device (invariant #4) and stays
 * there; the slot number is the strongest identity the wire is allowed to
 * carry, so the label names the slot instead.
 */
export function speakerLabel(segment: Pick<TranscriptSegment, "speaker" | "speaker_slot">): string {
  switch (segment.speaker as Speaker) {
    case "USER":
      return "You";
    case "OTHER":
      return "Other person (in the room)";
    case "SYSTEM":
      return segment.speaker_slot !== undefined
        ? `Speaker ${segment.speaker_slot} (on the call)`
        : "Someone on the call";
    default:
      return "Unattributed";
  }
}

export interface AgentTranscriptLine {
  seq: number;
  t_start: number;
  t_end: number;
  speaker: Speaker;
  speaker_slot?: number;
  /** Human-readable rendering of speaker + slot. See `speakerLabel`. */
  speaker_label: string;
  text: string;
  /** False for an interim hypothesis the transcriber may still revise. */
  final: boolean;
  /**
   * How sure Cyrano is about WHO spoke — never about what was heard. Named in
   * full because a bare `confidence: 1` next to a garbled phrase reads as a
   * claim about the words.
   */
  diarization_confidence: number;
}

export function projectSegment(segment: TranscriptSegment): AgentTranscriptLine {
  return {
    seq: segment.seq,
    t_start: segment.t_start,
    t_end: segment.t_end,
    speaker: segment.speaker,
    ...(segment.speaker_slot !== undefined ? { speaker_slot: segment.speaker_slot } : {}),
    speaker_label: speakerLabel(segment),
    text: segment.text,
    final: segment.final,
    diarization_confidence: segment.confidence,
  };
}

export const TRANSCRIPT_NOTES =
  "Segment text is verbatim speech recognition with no per-word confidence available, so an incoherent phrase is far more likely a mis-hearing than something the speaker said — quote it as uncertain rather than reasoning from it. `diarization_confidence` scores WHO spoke, not what was heard. Speaker names live only on the user's device; `speaker_label` is the strongest identity the server holds.";

export interface AgentTranscriptRange {
  /** First and last seq actually returned in `recent_segments` (0 when empty). */
  from: number;
  to: number;
  returned: number;
  /** Seq of the newest stored segment, whatever the window. */
  latest_seq: number;
  /** Seq of the oldest still-stored segment (retention may have purged older). */
  earliest_seq: number;
  total_stored: number;
  /** True when older/newer transcript exists outside the returned window —
   * fetch it with since_seq / around_seq / search rather than assuming the
   * window is the whole conversation. */
  has_more_before: boolean;
  has_more_after: boolean;
  /** Set when the requested window was clipped to `MAX_AGENT_SEGMENTS`. */
  truncated: boolean;
}

export interface AgentMatchedSpan {
  /** The terms that hit inside this span. */
  matched: string[];
  /** Seqs whose text actually contained a term (the neighbours are context). */
  matched_seqs: number[];
  from: number;
  to: number;
  segments: AgentTranscriptLine[];
}

export interface AgentTranscriptSelection {
  segments: AgentTranscriptLine[];
  range: AgentTranscriptRange;
  spans: AgentMatchedSpan[];
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  return merged;
}

/**
 * Pick the transcript this response returns. Precedence, most explicit first:
 * `around_seq` (resolve a cited seq), then `since_seq`/`until_seq` (paginate),
 * then the plain tail. `search` is orthogonal and always additive — it returns
 * spans from anywhere in the session, which is the whole point.
 */
export function selectTranscript(
  all: TranscriptSegment[],
  query: AgentContextQuery,
): AgentTranscriptSelection {
  const latestSeq = all.length > 0 ? all[all.length - 1]!.seq : 0;
  const earliestSeq = all.length > 0 ? all[0]!.seq : 0;

  const aroundSpan = query.span ?? DEFAULT_AROUND_SPAN;
  const singleAround = query.aroundSeqs.length === 1 && query.search.length === 0
    ? query.aroundSeqs[0]!
    : null;

  let window: TranscriptSegment[];
  let truncated = false;
  if (singleAround !== null) {
    window = all.filter((s) => s.seq >= singleAround - aroundSpan && s.seq <= singleAround + aroundSpan);
  } else if (query.sinceSeq !== null || query.untilSeq !== null) {
    const low = query.sinceSeq !== null ? query.sinceSeq + 1 : -Infinity;
    const high = query.untilSeq !== null ? query.untilSeq : Infinity;
    window = all.filter((s) => s.seq >= low && s.seq <= high);
  } else {
    window = all;
  }

  // Clip from the FRONT: whichever window was asked for, the newest end of it
  // is the part a caller polling a live session cannot do without.
  if (window.length > query.limit) {
    window = window.slice(window.length - query.limit);
    truncated = true;
  }

  // Everything that produces a span: keyword hits, plus every `around_seq`
  // centre that isn't already serving as the main window.
  const hits: Array<{ seq: number; terms: string[]; span: number }> = [];
  if (query.search.length > 0) {
    const searchSpan = query.span ?? DEFAULT_SEARCH_SPAN;
    for (const segment of all) {
      const haystack = segment.text.toLowerCase();
      const terms = query.search.filter((term) => haystack.includes(term));
      if (terms.length > 0) hits.push({ seq: segment.seq, terms, span: searchSpan });
    }
  }
  if (singleAround === null) {
    for (const seq of query.aroundSeqs) hits.push({ seq, terms: [], span: aroundSpan });
  }

  const spans: AgentMatchedSpan[] = [];
  if (hits.length > 0) {
    // Newest hits win when there are more than the budget allows — a focused
    // question is usually about recent ground — but the spans still read
    // forwards, because an answer assembled backwards misreads the sequence.
    const chosen = hits.slice(-MAX_SEARCH_SPANS * 4);
    const allRanges = mergeRanges(
      chosen.map(({ seq, span }) => [seq - span, seq + span] as [number, number]),
    );
    // A named `around_seq` outranks a keyword hit when the two compete for the
    // last span slot: the caller asked for that seq by name, usually because
    // the extracted state cited it, and dropping it in favour of a recent
    // keyword match returns everything EXCEPT the evidence that was asked for.
    const isNamed = ([low, high]: [number, number]) =>
      query.aroundSeqs.some((seq) => seq >= low && seq <= high);
    const named = allRanges.filter(isNamed).slice(-MAX_SEARCH_SPANS);
    // slice(-0) returns the whole array, so an exhausted budget has to be its
    // own branch rather than falling out of the arithmetic.
    const remaining = MAX_SEARCH_SPANS - named.length;
    const rest = remaining > 0 ? allRanges.filter((r) => !isNamed(r)).slice(-remaining) : [];
    const merged = [...named, ...rest].sort((a, b) => a[0] - b[0]);

    let budget = MAX_AGENT_SEGMENTS - window.length;
    for (const [low, high] of merged) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      let segments = all.filter((s) => s.seq >= low && s.seq <= high);
      if (segments.length > budget) {
        segments = segments.slice(0, budget);
        truncated = true;
      }
      if (segments.length === 0) continue;
      budget -= segments.length;
      const first = segments[0]!.seq;
      const last = segments[segments.length - 1]!.seq;
      const inSpan = chosen.filter(({ seq }) => seq >= first && seq <= last);
      spans.push({
        matched: [...new Set(inSpan.flatMap(({ terms }) => terms))],
        matched_seqs: inSpan.map(({ seq }) => seq),
        from: first,
        to: last,
        segments: segments.map(projectSegment),
      });
    }
  }

  const from = window.length > 0 ? window[0]!.seq : 0;
  const to = window.length > 0 ? window[window.length - 1]!.seq : 0;
  return {
    segments: window.map(projectSegment),
    spans,
    range: {
      from,
      to,
      returned: window.length,
      latest_seq: latestSeq,
      earliest_seq: earliestSeq,
      total_stored: all.length,
      has_more_before: window.length > 0 && from > earliestSeq,
      has_more_after: window.length > 0 && to < latestSeq,
      truncated,
    },
  };
}

// ---- Ask triage ----
//
// `hot_state.open_asks` is an append-only list of everything the asks pass ever
// emitted, and a long meeting turns it into a bin: "What the fuck?", "Right?",
// three phrasings of the same question, and a 60-word statement the model
// decided was a request. A consumer cannot tell those apart from the one ask
// that actually needs an answer, so it either acts on debris or ignores the
// list. Triage names the reason instead of silently dropping, so the app and
// the agent surface can each choose their own floor.

export type AskRejection =
  | "rhetorical"
  | "duplicate"
  | "too_short"
  | "not_a_request"
  | "low_confidence";

export interface AskTriage {
  /** Asks worth acting on, most confident first. */
  actionable: AskExtraction[];
  /** Everything else, with the reason it was set aside. */
  filtered: Array<{ ask: AskExtraction; reason: AskRejection }>;
}

/** Confidence below this is extraction debris, not a weak-but-real ask. */
export const ASK_MIN_CONFIDENCE = 0.5;
/** An "ask" longer than this is a restated paragraph, not a request. */
const ASK_MAX_WORDS = 40;

/**
 * Discourse fragments the asks pass sometimes lifts as questions. Matched
 * whole (after stripping punctuation), never as substrings — "right?" is noise,
 * "is the migration plan right?" is not.
 */
const RHETORICAL_FRAGMENTS = new Set([
  "right",
  "you know",
  "you know what i mean",
  "know what i mean",
  "isn't it",
  "innit",
  "huh",
  "what",
  "what the fuck",
  "what the hell",
  "wtf",
  "seriously",
  "really",
  "are you serious",
  "are you doing",
  "what are you doing",
  "yeah",
  "ok",
  "okay",
  "so",
  "i mean",
  "or what",
  "or something",
  "am i right",
  "make sense",
  "does that make sense",
]);

function normalizeAsk(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content words, for near-duplicate detection ("would there be value in X?"
 * asked twice, five minutes apart, in slightly different words). */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "do", "does", "did",
  "can", "could", "would", "will", "shall", "should", "may", "might", "must",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "this", "that", "these", "those",
  "to", "of", "in", "on", "for", "with", "at", "by", "from", "up", "about",
  "into", "over", "after", "and", "or", "but", "if", "then", "than", "so",
  "there", "here", "any", "some", "just", "like", "get", "got",
]);

function contentTokens(normalized: string): string[] {
  return normalized.split(" ").filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function nearDuplicate(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setB = new Set(b);
  const shared = a.filter((token) => setB.has(token)).length;
  // Jaccard over content words. 0.7 keeps "can you send the budget numbers"
  // and "can you send me the budget figures" together without merging two
  // genuinely different asks that happen to share a noun.
  const union = new Set([...a, ...b]).size;
  return shared / union >= 0.7;
}

export function triageAsks(asks: AskExtraction[]): AskTriage {
  const actionable: AskExtraction[] = [];
  const filtered: AskTriage["filtered"] = [];
  const keptTokens: string[][] = [];
  const seenExact = new Set<string>();

  for (const ask of asks) {
    const normalized = normalizeAsk(ask.text);
    const words = normalized.split(" ").filter(Boolean);

    // Rhetorical first: most of the fragments are one word ("Right?", "Huh?"),
    // and "too short to act on" would be a true but useless reason for them.
    if (RHETORICAL_FRAGMENTS.has(normalized)) {
      filtered.push({ ask, reason: "rhetorical" });
      continue;
    }
    if (normalized.length === 0 || words.length < 2) {
      filtered.push({ ask, reason: "too_short" });
      continue;
    }
    if (words.length > ASK_MAX_WORDS) {
      filtered.push({ ask, reason: "not_a_request" });
      continue;
    }
    if (seenExact.has(normalized)) {
      filtered.push({ ask, reason: "duplicate" });
      continue;
    }
    const tokens = contentTokens(normalized);
    if (keptTokens.some((kept) => nearDuplicate(tokens, kept))) {
      filtered.push({ ask, reason: "duplicate" });
      continue;
    }
    if (ask.confidence < ASK_MIN_CONFIDENCE) {
      filtered.push({ ask, reason: "low_confidence" });
      continue;
    }
    seenExact.add(normalized);
    keptTokens.push(tokens);
    actionable.push(ask);
  }

  actionable.sort((a, b) => b.confidence - a.confidence || b.source_seq - a.source_seq);
  return { actionable, filtered };
}

/**
 * The subset of triage the EXTRACTION path applies, before an ask is ever
 * stored in hot state or whispered. Deliberately narrower than the agent-facing
 * triage: only fragments that carry no information at all are dropped for good.
 * A low-confidence or duplicate-ish ask still reaches the app (where the user
 * can judge it) and is merely sorted on the way to an agent.
 */
export function rejectAtExtraction(ask: AskExtraction): boolean {
  const normalized = normalizeAsk(ask.text);
  const words = normalized.split(" ").filter(Boolean);
  return normalized.length === 0 || words.length < 2 || RHETORICAL_FRAGMENTS.has(normalized);
}

/** True when `text` is one of the discourse fragments triage rejects outright.
 * Exported for the ask-extraction prompt tests, which assert the two agree. */
export function isRhetoricalFragment(text: string): boolean {
  return RHETORICAL_FRAGMENTS.has(normalizeAsk(text));
}

// ---- Topic scoping ----

export interface ScorableItem {
  text: string;
  source_seq: number;
}

/**
 * Rank state items against a focus phrase so a focused workflow can say "here
 * is what relates to model availability" instead of returning the single most
 * recent commitment regardless of subject. Returns null when nothing clears the
 * bar — "no relevant commitment was found" is a better answer than an
 * unrelated one presented as the answer.
 */
export function scopeToFocus<T extends ScorableItem>(items: T[], focus: string | null): T[] {
  if (!focus) return items;
  const terms = contentTokens(normalizeAsk(focus));
  if (terms.length === 0) return items;
  const scored = items
    .map((item) => {
      const tokens = new Set(contentTokens(normalizeAsk(item.text)));
      return { item, score: terms.filter((term) => tokens.has(term)).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.source_seq - a.item.source_seq);
  return scored.map((entry) => entry.item);
}

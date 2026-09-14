// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Wire contract between the iOS client and the Session Durable Object.
// Mirrored by hand in ios/Cyrano/Networking/WireTypes.swift — keep both in sync.
// There is deliberately no field anywhere in this file for raw audio: the
// ingest schema has no audio field, so storing audio server-side is not a
// setting that can be misconfigured, it is a shape the data cannot take.

// "SYSTEM" is audio captured from the device's output (a meeting feed, a
// video) rather than a mic — a non-user counterpart, kept distinct from an
// in-room "OTHER" so review/redaction can treat the two differently.
export type Speaker = "USER" | "OTHER" | "UNKNOWN" | "SYSTEM";

export type RetentionPolicy = "ephemeral" | "24h" | "pinned";

/** One finalized (or volatile) transcript segment from the on-device pipeline. */
export interface TranscriptSegment {
  session_id: string;
  seq: number;
  t_start: number; // ms since session start
  t_end: number;
  speaker: Speaker;
  confidence: number; // 0..1, diarization confidence (not ASR confidence)
  text: string;
  final: boolean;
  /**
   * Ephemeral speaker slot within the SYSTEM feed: 2, 3, ... for distinct
   * remote voices on a call (the user is always "You"; slot 1 is conceptual).
   * Orthogonal to `speaker` — the segment stays "SYSTEM" and this only
   * disambiguates which remote voice it was. Optional: absent from mic
   * segments and from clients that predate the feature. Derived on-device
   * from an in-memory-only embedding that is never persisted or transmitted —
   * only this integer label crosses the wire. See invariant #4 in README.md.
   */
  speaker_slot?: number;
}

export interface WhisperTier {
  /** Ambient never auto-pushes. Enforced in the policy engine, not just here. */
  kind: "critical" | "actionable" | "ambient";
}

export type WhisperCandidateSource =
  | "commitments"
  | "asks"
  | "subtext"
  | "suggestions"
  | "pull"
  | "agent"
  | "custom";

// ---- User-defined watch categories ----
//
// Users define their own categories ("watch for competitor mentions", "note
// any budget figures") in the app's settings; the client sends the active set
// in `hello` and the backend runs ONE batched LLM pass per analysis tick over
// all of them — cost stays flat no matter how many categories are defined.
// The output item shape is fixed (users author a description, never a
// schema), so validation, the wire format, and rendering stay uniform.

/** Hard caps keeping the batched prompt bounded; enforced server-side. */
export const MAX_CUSTOM_CATEGORIES = 8;
export const MAX_CUSTOM_DESCRIPTION_CHARS = 400;

export interface CustomCategoryDefinition {
  id: string; // stable client-generated id
  name: string; // short display name, e.g. "Competitor mentions"
  description: string; // natural-language "watch for..." guidance
  /** Delivery tier for pushed whispers from this category. Defaults to
   * ambient (never auto-pushes) so a sloppy definition can't interrupt. */
  tier: WhisperTier["kind"];
}

export interface CustomCategoryItem {
  category_id: string;
  category_name: string; // denormalized server-side so clients render without a lookup
  text: string;
  /** Verbatim supporting line from the transcript, or "" when none —
   * may quote the OTHER party, so redaction treats these like asks/subtext. */
  quote: string;
  speculation: boolean;
  confidence: number;
  source_seq: number;
}

/**
 * A recurring theme the model noticed that no defined category covers — a
 * "smart" category suggestion the user can promote to a saved definition
 * with one tap. Detection rides in the same batched LLM call as extraction.
 */
export interface DetectedCategory {
  name: string;
  description: string; // ready to save as a CustomCategoryDefinition description
  evidence: string; // quote/example from this window that motivated the suggestion
  source_seq: number;
}

/** A candidate line of speech the agent might deliver into the user's ear. */
export interface WhisperCandidate {
  id: string;
  session_id: string;
  text: string; // <=12 words pushed, <=25 words pulled — validated in policy/grammar.ts
  tier: WhisperTier["kind"];
  source: WhisperCandidateSource;
  created_at: number; // ms epoch (session-relative for the simulation harness)
  ttl_ms: number; // candidate is worthless after created_at + ttl_ms
  speculation: boolean; // true for subtext-derived content
}

export type WhisperFeedbackKind = "delivered" | "dismissed" | "barged" | "expired";

// ---- Client -> Server ----

export interface ClientHelloMessage {
  type: "hello";
  session_id: string;
  resume_from_seq?: number; // reconnect replay cursor
  retention: RetentionPolicy;
  /** The `linux_*` values are the Linux port's additive widening (see
   * the cross-platform capture contract): linux_mic is a PipeWire input node,
   * linux_monitor a monitor source (system output captured back), linux_app a
   * single application's output node. The server never branches on this
   * field; it is documentation that rides along. */
  input_route:
    | "airpods"
    | "iphone_mic"
    | "built_in_mic"
    | "system_audio"
    | "linux_mic"
    | "linux_monitor"
    | "linux_app";
  /** User-configurable session auto-expiry; defaults to 30 minutes server-side. */
  max_duration_ms?: number;
  /** User-defined watch categories active for this session (capped at
   * MAX_CUSTOM_CATEGORIES server-side). Re-sent on reconnect hellos, which
   * lets mid-session edits apply on the next reconnect. */
  custom_categories?: CustomCategoryDefinition[];
  /** Ask the analysis pass to also propose emerging categories the user
   * hasn't defined yet (smart detection). Defaults to false. */
  detect_categories?: boolean;
  /**
   * The user's own Anthropic API key (added 2026-07-13), so a backend
   * shared across several people can bill each person's own account rather
   * than the operator's `LLM_API_KEY`. Held in-memory only for the
   * session's lifetime (see SessionDO) — never written to Durable Object
   * storage, never logged. Re-sent on every reconnect hello like
   * custom_categories, so it survives a DO eviction. Falls back to the
   * operator's `LLM_API_KEY` when absent — the original single-tenant
   * self-host behavior is unchanged for anyone who never sets this.
   */
  llm_api_key?: string;
  /**
   * Which provider `llm_api_key` is for (added 2026-07-13, BYOK breadth —
   * the hosted-provider contract). "anthropic" (default) speaks the native
   * Messages API; "openrouter" speaks the OpenAI-compatible Chat Completions
   * API at openrouter.ai; "openai" (added 2026-09-14) speaks the same API at
   * api.openai.com. Additive: a backend that predates "openai" treats it as
   * "anthropic" and the key is rejected with the existing auth_error status.
   * Ignored when no client key is sent (the hosted path speaks whatever the
   * operator's LLM_PROVIDER names). In-memory only, re-sent each hello like
   * llm_api_key. */
  llm_provider?: "anthropic" | "openrouter" | "openai";
  /**
   * Model id for a client-supplied key. Required for OpenRouter (e.g.
   * "anthropic/claude-3.5-sonnet", "openai/gpt-4o-mini",
   * "google/gemini-2.0-flash-001") and for OpenAI (e.g. "gpt-5.6-luna");
   * optional for Anthropic BYOK (falls back to the server's LLM_MODEL).
   * Ignored on the hosted path. */
  llm_model?: string;
  /**
   * What kind of session this is: "burst" (a short dictation-companion
   * window), "mic_follow" (a mic-engagement follow), "dictation" (a
   * first-party hold-to-talk dictation the user noted into their day's
   * context), or "gateway" (an ephemeral
   * session stood up from idle purely to carry one directed vocal-gateway
   * exchange with a connected agent; it
   * streams no transcript, so no analysis ever runs). Omitted for an ordinary
   * standard session. Optional and additive: stored for review grouping and
   * future analysis-cadence tuning; the analysis path treats every kind the
   * same today. */
  session_kind?: "burst" | "mic_follow" | "dictation" | "gateway";
  /**
   * This session is a RELAY (added 2026-08-03): it transits this Worker so
   * agents and remote MCP clients can read it, but analysis already runs on
   * the device — do not spend an LLM key on it.
   *
   * A relay against Cyrano's hosted Worker resolves the same verdict from the
   * `pro-relay` plan on the identity (entitlement.ts). This flag exists for a
   * relay against the user's OWN Worker, where the credential is an ordinary
   * operator bearer token carrying no such plan: without it, their deployment
   * would analyze in parallel with the on-device pass, on their key, producing
   * output the client discards.
   *
   * Client-asserted, and safe to trust because it only ever REDUCES what the
   * server does. It is never a way to gain access: it cannot widen scope,
   * cannot bypass entitlement, and a client that lies only denies itself
   * hosted analysis it was already paying for.
   */
  relay_only?: boolean;
}

export interface ClientTranscriptMessage {
  type: "transcript";
  segment: TranscriptSegment;
}

export interface ClientVadStateMessage {
  type: "vad.state";
  session_id: string;
  t: number;
  state: "user_speaking" | "other_speaking" | "silence";
}

/** Pull-mode ask: "what did I just commit to", etc. Fixed set, not open dialogue. */
export type PullAskType = "last_commitment" | "open_ask" | "next_move";

export interface ClientWhisperRequestMessage {
  type: "whisper.request";
  session_id: string;
  ask: PullAskType;
  requested_at: number;
}

export interface ClientWhisperFeedbackMessage {
  type: "whisper.feedback";
  session_id: string;
  candidate_id: string;
  feedback: WhisperFeedbackKind;
  at: number;
}

export interface ClientSessionEndMessage {
  type: "session.end";
  session_id: string;
}

/**
 * Push the max-duration alarm out by another full window. The client's own
 * expiry clock is authoritative for when a session ends; this exists only so
 * the server's dead-client safety net doesn't purge a session the user
 * deliberately extended past its original cap.
 */
export interface ClientSessionExtendMessage {
  type: "session.extend";
  session_id: string;
}

/**
 * An utterance the user explicitly addressed to their connected agent (the
 * "vocal gateway" path) — armed by a button/intent press, not a wake word.
 * Deliberately not a TranscriptSegment: it is a directed aside to the agent,
 * so it must not flow into the analysis passes as if it were conversation.
 */
export interface ClientAgentMessage {
  type: "agent.message";
  session_id: string;
  id: string;
  text: string;
  at: number; // ms epoch
  /** The agent key label this question is addressed to. Several agents can
   * hold keys to the same account and they all poll the same `/agent/latest`,
   * so without an address every one of them would be asked and whichever
   * answered first would win. Omitted (older clients, or a user who has only
   * ever had one agent) means "any agent" — the pre-addressing behavior. */
  target?: string;
}

/**
 * Narrow the session's retention mid-session — sent when a session tag
 * resolves the live session to a shorter tier than the hello declared
 * ("tag it `media`" must reach the server copy, not only the device's).
 * Narrowing-only on the server: the copy may keep LESS than the hello said,
 * never more, so a stale or replayed frame can't widen what's kept.
 */
export interface ClientSessionRetentionMessage {
  type: "session.retention";
  session_id: string;
  retention: RetentionPolicy;
}

export type ClientMessage =
  | ClientHelloMessage
  | ClientTranscriptMessage
  | ClientVadStateMessage
  | ClientWhisperRequestMessage
  | ClientWhisperFeedbackMessage
  | ClientSessionEndMessage
  | ClientSessionExtendMessage
  | ClientSessionRetentionMessage
  | ClientAgentMessage;

// ---- Server -> Client ----

export interface ServerHelloAckMessage {
  type: "hello.ack";
  session_id: string;
  server_seq_cursor: number; // last seq the server has durably stored
}

/**
 * Machine-readable analysis health, broadcast on every analysis.result. A
 * BYOK user whose Anthropic key is bad (or whose session hit its LLM budget)
 * must SEE that — before this field the passes settled to empty arrays and
 * the failure was visible only in `wrangler tail`.
 */
export interface AnalysisStatusInfo {
  state:
    | "ok"
    | "auth_error"
    | "budget_exhausted"
    | "llm_error"
    | "no_llm_key"
    | "subscription_inactive"
    /** A Pro live-relay session: server analysis
     * is off BY DESIGN — the device analyzes; the Worker only relays for the
     * agent loop. Distinct from subscription_inactive so clients never render
     * "Renew" copy at a user who never lapsed. */
    | "relay_only";
  /** Human-readable detail for Settings/logs. Never contains transcript text. */
  detail?: string;
}

export interface ServerAnalysisResultMessage {
  type: "analysis.result";
  session_id: string;
  commitments: CommitmentExtraction[];
  asks: AskExtraction[];
  subtext: SubtextObservation[];
  suggestions: NextMoveSuggestion[];
  /** Settled outcomes of the conversation (owner + status). Optional on the
   * wire so old clients/backends interop; the backend always sends it. */
  decisions?: DecisionExtraction[];
  /** Hits for the user's custom watch categories (empty when none defined). */
  custom_items: CustomCategoryItem[];
  /** Newly detected category suggestions — deduped server-side, so each
   * suggested name is broadcast at most once per session. */
  detected_categories: DetectedCategory[];
  /** Optional on the wire so old clients/backends interop; the backend always
   * sends it (state "ok" on a healthy tick). */
  analysis_status?: AnalysisStatusInfo;
  triggered_by_seq: number;
}

export interface ServerWhisperCandidateMessage {
  type: "whisper.candidate";
  candidate: WhisperCandidate;
  // No server-computed delivery verdict here: the interruption policy engine
  // runs client-side because it needs real-time VAD state the server only
  // gets in periodic, already-stale vad.state messages. The client decides
  // speak/cue/queue/drop locally and reports the terminal outcome back via
  // whisper.feedback, which the DO logs for the review screen.
}

export interface ServerWhisperAnswerMessage {
  type: "whisper.answer";
  session_id: string;
  ask: PullAskType;
  candidate: WhisperCandidate | null; // null => hot state had nothing to answer with
  answered_from: "hot_state" | "llm";
}

/**
 * The agent's answer to a directed `agent.message`. Delivered as its own
 * message type (not a plain whisper.candidate) because the client speaks it
 * immediately, like a pull-mode answer — the user explicitly asked, so it
 * does not go through the tier queue.
 */
export interface ServerAgentReplyMessage {
  type: "agent.reply";
  session_id: string;
  reply_to: string; // the ClientAgentMessage id this answers
  candidate: WhisperCandidate;
  /** Question stored → reply landed, server clock. Absent for questions asked
   * before this field was deployed. */
  latency_ms?: number;
}

/**
 * A note a connected assistant filed into the live session. Distinct from
 * `agent.reply` (spoken, answers a question the user asked) and from a whisper
 * candidate (extraction, tier-queued): this is written material for the session
 * record, so the client files it in the Notes section and never speaks it.
 */
export interface ServerAgentNoteMessage {
  type: "agent.note";
  session_id: string;
  note: AgentSessionNote;
}

export interface ServerErrorMessage {
  type: "error";
  message: string;
  code: string;
}

export type ServerMessage =
  | ServerHelloAckMessage
  | ServerAnalysisResultMessage
  | ServerWhisperCandidateMessage
  | ServerWhisperAnswerMessage
  | ServerAgentReplyMessage
  | ServerAgentNoteMessage
  | ServerErrorMessage;

// ---- Analysis pass outputs (also the portable hermes-agent schemas, see backend/schemas/) ----

export interface CommitmentExtraction {
  text: string;
  // Who made the commitment, derived from the source line's speaker (never
  // trusted from the model): "USER" is ours; "OTHER"/"SYSTEM" are commitments
  // the counterpart made — tracked so the client can toggle mine vs all.
  owner: "USER" | "OTHER" | "SYSTEM";
  /**
   * Which distinct SYSTEM-feed voice made this commitment (2, 3, …), set only
   * when `owner` resolved to SYSTEM and the source line carried a
   * `speaker_slot`. Also re-derived server-side from the source line, never
   * trusted from the model. Absent for USER/OTHER commitments and for
   * un-slotted feed lines. Lets a client attribute a task to "Speaker 5"
   * instead of a flat "SYSTEM" — the integer slot is all that ever crosses the
   * wire; the app maps it to a local name (README invariant #4). Optional and
   * additive, so old clients/backends interop.
   */
  owner_slot?: number;
  inferred_deadline: string | null; // ISO date or null
  confidence: number;
  source_seq: number;
}

export interface AskExtraction {
  text: string;
  // The counterpart who made the ask: "OTHER" for an in-room mic speaker,
  // "SYSTEM" when the source line came from captured system-output audio.
  requested_by: "OTHER" | "SYSTEM";
  /** Which distinct SYSTEM-feed voice made the ask (2, 3, …), set only when
   * `requested_by` is SYSTEM and the source line carried a `speaker_slot`.
   * Re-derived server-side, never trusted from the model; absent otherwise.
   * Same slot-not-name rule as `CommitmentExtraction.owner_slot`. */
  requested_by_slot?: number;
  answered: false;
  confidence: number;
  source_seq: number;
}

export interface SubtextObservation {
  text: string;
  label: "hesitation" | "swallowed_disagreement" | "enthusiasm_mismatch";
  speculation: true; // always true — never presented as fact
  confidence: number;
  source_seq: number;
}

export interface NextMoveSuggestion {
  text: string;
  outcome: string; // the concrete outcome this suggestion moves toward
  dismissible: true;
  source_seq: number;
}

/**
 * A concrete outcome the conversation SETTLED — distinct from a commitment (one
 * person's promise) and a next move (a suggestion to USER). "Sully explores
 * staging and reports back", "test launches get announced in the bugs channel".
 * The single most useful output for a work meeting (QA feedback 2026-07-22, P6):
 * capturing these lets Next Moves shrink to genuinely open items instead of
 * restating settled ones. Owner is who the decision makes accountable (derived
 * server-side from the source line like a commitment, with owner_slot naming a
 * specific feed voice); status separates a firm agreement from a leaning one.
 */
export interface DecisionExtraction {
  text: string;
  owner: "USER" | "OTHER" | "SYSTEM";
  owner_slot?: number;
  status: "decided" | "tentative";
  confidence: number;
  source_seq: number;
}

export interface HotState {
  session_id: string;
  last_commitment: CommitmentExtraction | null;
  open_asks: AskExtraction[];
  latest_suggestion: NextMoveSuggestion | null;
  updated_at_seq: number;
  /**
   * Everything the session has committed to and settled, newest last, capped
   * at MAX_HOT_STATE_ITEMS. Optional because hot state persisted by an earlier
   * deployment has neither field — read them as empty.
   *
   * Why they exist (2026-07-28 integration review): an agent asking "what did
   * we decide about X" could previously see only `last_commitment` — one item,
   * whatever the subject, which surfaced a stale 0.4-confidence line as though
   * it were the answer. Keeping the recent set lets a consumer scope by topic
   * and say honestly when nothing relates.
   */
  recent_commitments?: CommitmentExtraction[];
  decisions?: DecisionExtraction[];
}

/** Cap on each retained hot-state list. A long meeting settles a few dozen
 * things; past that the oldest fall off rather than growing the payload every
 * agent poll has to carry. */
export const MAX_HOT_STATE_ITEMS = 24;

// ---- External agent integration (e.g. a Hermes claw) ----
//
// Cyrano's backend has a public URL; a Hermes claw does not (Slack
// socket-mode is outbound-only, no inbound port — see DECISIONS.md). So the
// integration direction is the agent pulling from Cyrano and pushing results
// back, authenticated with a separate, revocable "agent key" distinct from
// the app's own AUTH_TOKEN — the primary bearer token never has to leave
// the device.

export interface AgentKeySummary {
  label: string;
  created_at: number;
  /** When a request last arrived carrying this key — the difference between
   * "a key exists" and "an agent is actually out there holding it". Null for
   * a key nothing has ever used. Coalesced server-side (see
   * AGENT_SEEN_COALESCE_MS), so it is accurate to within a minute, not to the
   * poll. */
  last_seen_at?: number | null;
  /** Whether this key may read live session context. Every key could, before
   * this flag existed, and that is still the default — turning it off leaves
   * a key that can be talked to and can push results, but reads nothing. */
  receives_context?: boolean;
}

export interface AgentWhisperCandidateInput {
  text: string;
  tier: WhisperTier["kind"];
  ttl_ms?: number;
  speculation?: boolean;
  source_seq?: number;
}

/** A directed user->agent message as exposed in the agent context payload. */
export interface AgentDirectMessage {
  id: string;
  text: string;
  at: number; // ms epoch, client clock
  answered: boolean;
  /** The agent key label this was addressed to, if the user aimed it at one
   * agent. The context poll exposes an addressed message only to that key;
   * an unaddressed one goes to every agent, as all of them did before. */
  target?: string;
  // Latency instrumentation, both on the server clock so the deltas are
  // skew-free: when the message was stored, and when the agent first saw it
  // in a context poll. Their difference is the agent's poll gap; the gap
  // from pickup to the reply landing is the agent's own thinking time.
  asked_at_ms?: number;
  picked_up_at_ms?: number;
}

/** The agent's answer to one AgentDirectMessage. */
export interface AgentReplyInput {
  reply_to: string; // AgentDirectMessage id
  text: string; // clipped to pull-mode whisper grammar server-side if too long
}

/**
 * What kind of thing the agent is filing. Every kind lands as one session note
 * on the device — the app has exactly one user-authored, id-keyed collection
 * (SessionNote) and inventing four
 * parallel ones server-side would fork it. The kind rides along as a prefix the
 * user can read and search ("Reminder: try Kimi K3"), and the app can promote
 * to a real task later without a wire change.
 */
export type AgentNoteKind = "note" | "reminder" | "decision" | "commitment" | "follow_up";

export const AGENT_NOTE_KINDS: AgentNoteKind[] = [
  "note",
  "reminder",
  "decision",
  "commitment",
  "follow_up",
];

/** Matches SessionNote.maxChars on the device: a note is shorthand, not a
 * document, and a clamp that disagreed would truncate invisibly. */
export const MAX_AGENT_NOTE_CHARS = 500;
export const MAX_AGENT_NOTES_PER_SESSION = 100;

/** A note an MCP-connected assistant files into the live session. */
export interface AgentNoteInput {
  text: string;
  kind?: AgentNoteKind;
  /** Who owes the thing, when the user named someone. Free text, clamped. */
  owner?: string;
  /** ISO-8601 date or datetime; stored verbatim and shown, never scheduled. */
  due_at?: string;
}

/** A filed note, as stored and as broadcast to the app. */
export interface AgentSessionNote {
  id: string;
  text: string;
  kind: AgentNoteKind;
  owner?: string;
  due_at?: string;
  /** Which connected client filed it ("ChatGPT", "Claude", …) — provenance the
   * app renders on the note, so an agent-written line is never mistaken for
   * one the user typed. */
  source: string;
  /** Latest transcript seq when it was filed: the note's temporal anchor,
   * matching what the app records for a typed note. */
  anchor_seq: number;
  at: number; // ms epoch, server clock
}

export interface AgentResultsPayload {
  commitments?: CommitmentExtraction[];
  asks?: AskExtraction[];
  subtext?: SubtextObservation[];
  suggestions?: NextMoveSuggestion[];
  decisions?: DecisionExtraction[];
  whisper_candidates?: AgentWhisperCandidateInput[];
  replies?: AgentReplyInput[];
  notes?: AgentNoteInput[];
}

// ---- User context attachments (opt-in "bring your own context") ----
//
// An opted-in user can deliberately hand Cyrano an artifact mid-session — the
// clipboard, or an OCR'd snapshot of one app window — routed either into the
// analysis passes or to the connected agent. Carried over REST
// (POST /session/:id/attach, app bearer token), NOT a WebSocket frame: the
// user action wants a synchronous ack, an old backend answers with an honest
// 404 instead of a silent drop, and an agent-destined image would flirt with
// the 1 MiB WS message cap and head-of-line-block live transcript frames.
// The analysis path is text-only BY SHAPE: the sanitizer strips any image
// unless the destination is the agent, so "analysis never sees pixels" is
// enforced server-side, not client-honored.

/** Hard caps; enforced server-side in sanitizeAttachment/handleAttach. */
export const MAX_ATTACHMENT_TEXT_CHARS = 8_000;
export const MAX_ATTACHMENTS_PER_SESSION = 20; // stored at once; 429 beyond
export const MAX_ATTACHMENT_IMAGE_B64_CHARS = 1_500_000; // ~1.1MB binary; 413 beyond
export const MAX_USER_CONTEXT_PER_TICK = 4; // newest N injected per analysis tick
export const MAX_FILE_NAME_CHARS = 120;

export type AttachmentSource = "clipboard" | "window" | "file";
export type AttachmentDestination = "analysis" | "agent";

/** POST /session/:id/attach request body. */
export interface UserAttachmentInput {
  id: string; // client-generated UUID
  destination: AttachmentDestination;
  source: AttachmentSource;
  text: string; // clipboard text or on-device OCR text
  app_name?: string; // window source only
  window_title?: string; // window source only
  file_name?: string; // file source only (Finder or Photos import)
  /** JPEG, agent destination only — stripped server-side for analysis. */
  image_base64?: string;
  /** false => discarded after first use (analysis tick / agent pickup),
   * regardless of the session's retention tier. */
  keep: boolean;
  at: number; // ms epoch, client clock
}

/** DO storage record under `attach:<id>`. The image body lives separately
 * under `attachimg:<id>` so prefix-listing attachments during an analysis
 * tick never loads megabyte values. */
export interface StoredAttachment {
  id: string;
  destination: AttachmentDestination;
  source: AttachmentSource;
  text: string;
  app_name?: string;
  window_title?: string;
  file_name?: string;
  keep: boolean;
  at: number;
  has_image: boolean;
  delivered_to_agent: boolean;
}

/** What the analysis passes receive as `user_context`. Deliberately has no
 * speaker and no seq — the harness prompts forbid treating it as a
 * transcript line or extracting from it on its own. */
export interface UserContextItem {
  source: AttachmentSource;
  app_name?: string;
  window_title?: string;
  file_name?: string;
  text: string;
}

/** An attachment as exposed in the agent context payload. The image rides
 * along exactly once (first delivering poll), then is deleted server-side —
 * delivery-only, never retained. */
export interface AgentContextAttachment {
  id: string;
  source: AttachmentSource;
  app_name?: string;
  window_title?: string;
  file_name?: string;
  text: string;
  at: number;
  image_base64?: string;
}

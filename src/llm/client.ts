// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Native Anthropic Messages API client with forced tool calling.
//
// Replaced the OpenAI-compat shim (/v1/chat/completions) 2026-07-11: the shim
// was documented as a testing/eval aid with fragile forced-tool-choice (see
// DECISIONS.md), and it exposed no `cache_control` — so every analysis tick
// re-sent ~2k tokens of tool schema + system prompt at full price. The native
// API gives us prompt caching (system+tools cached across ticks within the
// 5-minute TTL), already-parsed tool inputs, and per-call usage for the
// per-session budget.
//
// base_url/model stay env-configurable (wrangler.jsonc `vars` + secrets);
// LLM_BASE_URL must point at an Anthropic-compatible /v1 root (default
// https://api.anthropic.com/v1).

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Which wire protocol serves a call. */
export type LlmProvider = "anthropic" | "openrouter";

/** OpenRouter's OpenAI-compatible root. The default base URL for a BYOK
 * "openrouter" selection and for the fallback leg; the primary path never
 * defaults to it (LLM_BASE_URL is used verbatim — see env.ts LLM_PROVIDER). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** OpenAI's own root. The base URL for a BYOK "openai" selection: same wire
 * as "openrouter", different company — which is exactly why the client has a
 * separate value for it (an OpenAI key sent to openrouter.ai just 401s). */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Anthropic's own root. Where an Anthropic client key goes when the
 * operator's LLM_BASE_URL is no longer an Anthropic endpoint (LLM_PROVIDER
 * on the OpenAI-compatible wire) — see hosted-config.ts anthropicBaseUrl(). */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

/**
 * What a CLIENT may put in `hello.llm_provider` / an `llm_provider` body
 * field beside its own key. Unlike the operator tags (`LlmProvider`, parsed by
 * asProvider), these name a destination, not just a wire: "openai" and
 * "openrouter" both speak Chat Completions but at different hosts, and the
 * server — not the client — owns the base URL for each. Resolved to a leg by
 * llm/hosted-config.ts clientLeg(); anything unrecognised is treated as
 * "anthropic", as it always was.
 */
export type ClientLlmProvider = "anthropic" | "openrouter" | "openai";

/** True for providers that speak OpenAI-compatible Chat Completions rather than
 * the native Anthropic Messages API. */
export function isOpenAiCompat(provider: LlmProvider | undefined): boolean {
  return provider === "openrouter";
}

/**
 * Parse an OPERATOR-supplied provider tag (LLM_PROVIDER, FALLBACK_PROVIDER,
 * HOSTED_PAID_PROVIDER, a price-test target) into the wire protocol it names.
 * Unset, empty or unknown → undefined, so every caller falls back to its own
 * safe default rather than guessing.
 *
 * "openai" is accepted as an alias for "openrouter": the tag has always named
 * the OpenAI-compatible wire, not the OpenRouter company, and an operator
 * pointing LLM_BASE_URL at api.openai.com should not have to write the other
 * company's name to get there. Normalised on input only — the internal tag
 * stays "openrouter" so isOpenAiCompat(), pricing and the existing tests do
 * not move.
 *
 * Deliberately NOT used for the client-facing `hello.llm_provider` /
 * `llm_provider` body field: there "openai" will mean a specific base URL
 * (api.openai.com), not just a wire, and aliasing it here would send an
 * OpenAI key to OpenRouter.
 */
export function asProvider(raw: unknown): LlmProvider | undefined {
  if (raw === "anthropic" || raw === "openrouter") return raw;
  if (raw === "openai") return "openrouter";
  return undefined;
}

/**
 * The public root an OPERATOR-supplied tag names when no base URL was given
 * beside it. Keyed on the RAW tag, not the wire asProvider() folds it to:
 * "openai" and "openrouter" share a wire but not a host, and a leg that
 * defaulted the alias to openrouter.ai would send an OpenAI key to the wrong
 * company. "anthropic" has no default here — callers that accept it decide
 * between the operator's LLM_BASE_URL and {@link ANTHROPIC_BASE_URL}
 * themselves (hosted-config.ts anthropicBaseUrl()), and the fallback leg
 * deliberately refuses to default it at all (env.ts).
 */
export function defaultBaseUrlFor(raw: unknown): string | undefined {
  if (raw === "openai") return OPENAI_BASE_URL;
  if (raw === "openrouter") return OPENROUTER_BASE_URL;
  return undefined;
}

/**
 * The leg that actually produced a result — the seam the per-user cost meter
 * prices against. Reported alongside every usage block (and once per served
 * call via `onLeg`) so a fallback-served call is never billed at the primary's
 * provider/model. Provider AND model, because rates key on both.
 */
export interface ServedLeg {
  provider: LlmProvider;
  model: string;
  baseUrl: string;
  /** True when the fallback leg served this, not the configured primary. */
  fallback: boolean;
}

/**
 * A single, never-default failover destination. Deliberately NOT an `LlmConfig`:
 * a fallback carries no `fallback` of its own (one attempt, never a chain) and
 * no observers of its own (it reuses the primary's, so usage from either leg
 * lands in the same meter, tagged with the leg that produced it).
 */
export interface FallbackLeg {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Own timeout budget, ms. Defaults to {@link FALLBACK_TIMEOUT_MS}, which is
   * deliberately tighter than the primary's 30s so a primary timeout plus a
   * fallback attempt still fits inside a caller's patience. */
  timeoutMs?: number;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Which wire protocol to speak. Defaults to native Anthropic Messages;
   * "openrouter" speaks OpenAI-compatible Chat Completions. */
  provider?: LlmProvider;
  /** Called with the usage block of every response that carries one (success
   * or refusal) — the Session DO accumulates this into its per-session budget.
   * `leg` names the provider+model that produced THIS block, which is what the
   * real-$ meter must price against: on a failed-over call the primary and the
   * fallback can each report usage, at different rates. */
  onUsage?: (usage: LlmUsage, leg: ServedLeg) => void;
  /** Called once with the leg that produced the returned result. Distinct from
   * `onUsage` because a leg can serve a call and report no usage block at all
   * (some OpenAI-compat responses omit `usage`) — without this, a fallback that
   * served the whole session would be invisible. */
  onLeg?: (leg: ServedLeg) => void;
  /** Optional single failover destination. NEVER set on a BYOK config: silently
   * moving a user's call onto our key at another provider bills us and hands
   * their transcript to a provider they did not choose (BAR invariant I3).
   * Build it only through `fallbackLegFor()` in env.ts, which enforces that. */
  fallback?: FallbackLeg;
  /** Per-call timeout override, ms. Unset → {@link LLM_TIMEOUT_MS}, i.e. the
   * exact behaviour that shipped before failover existed. */
  timeoutMs?: number;
  /** Sampling temperature. Omitted in production (provider default); the eval
   * harness sets 0 so runs are deterministic and comparable. */
  temperature?: number;
  /** Test-only. Production leaves this false so validation diagnostics never
   * write transcript-derived model output to Worker logs. */
  logContent?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  system_prompt: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

/**
 * What class of failure an {@link LlmCallError} represents. The failover
 * decision needs this: "the provider never answered" and "the provider answered
 * and the model refused" both arrive today as a status-less LlmCallError, and
 * only the first of those is worth trying somewhere else.
 *  - `transport` — fetch itself threw (DNS, TLS, connection reset).
 *  - `timeout`   — our own AbortSignal fired.
 *  - `http`      — a non-2xx response; `status` and `body` are populated.
 *  - `protocol`  — a 2xx we could not use: refusal, max_tokens truncation,
 *                  missing tool call, unparseable arguments. Our bug or the
 *                  model's judgement, never something another key fixes.
 */
export type LlmErrorKind = "transport" | "timeout" | "http" | "protocol";

export class LlmCallError extends Error {
  /** Kept for failover classification but deliberately non-enumerable so
   * logging the Error object cannot print provider-controlled content. */
  public readonly body?: string;

  constructor(
    message: string,
    public readonly status?: number,
    /** Defaults to "protocol" — the conservative choice, because "protocol" is
     * the one kind that never triggers failover. An error whose origin we
     * didn't classify must not spend a second provider's tokens. */
    public readonly kind: LlmErrorKind = "protocol",
    body?: string,
  ) {
    super(message);
    this.name = "LlmCallError";
    Object.defineProperty(this, "body", {
      value: body,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}

/** Build an HTTP exception string without putting a provider-controlled response
 * body in ordinary logs. The raw body remains on LlmCallError for classification
 * and failover; only an explicit content-logging opt-in includes it in message. */
function httpErrorMessage(status: number, body: string, logContent: boolean | undefined): string {
  return `LLM call failed: ${status}${logContent ? ` ${body}` : ""}`;
}

/**
 * Hard ceiling on any single model call. Without it a hung provider stalls
 * the whisper/analysis await indefinitely — there is no latency budget the
 * callers can actually enforce if the fetch itself can wait forever. 30s is
 * far above any healthy analysis-pass response and far below "wedged".
 */
const LLM_TIMEOUT_MS = 30_000;

/**
 * Default budget for the FALLBACK attempt. Tighter than the primary's 30s on
 * purpose: the worst case is a primary that burns its whole 30s timing out and
 * then a fallback on top, and 30+30 exceeds every caller's patience (the
 * dictation client races a deadline; an analysis tick blocks the next window).
 * Override per-deployment with FALLBACK_TIMEOUT_MS.
 */
export const FALLBACK_TIMEOUT_MS = 15_000;

/**
 * Anthropic returns "your credit balance is too low to access the Anthropic
 * API" as a **400**, not a 402 — the exact shape the user's key is returning as
 * of 2026-08-19. A 5xx-only failover trigger would not fire for the situation
 * this feature was built for, so this specific 400 is in the trigger list.
 * OpenAI's `insufficient_quota` needs no clause of its own: it arrives as a 429,
 * which is already a blanket trigger.
 */
const CREDIT_EXHAUSTED_400 = /credit balance is too low/i;

/**
 * The failover trigger. Keep this list narrow and covered by tests.
 * Do not narrow it and do not widen it.
 *
 * FAIL OVER: transport error, timeout, 408, 429, any 5xx, and the "we cannot
 * pay / are not permitted" family — 401, 402, 403, and Anthropic's 400 with
 * "credit balance is too low".
 *
 * DO NOT: an ordinary 400 bad-request (that is our own malformed request;
 * failing over just burns the fallback's tokens on the same broken body), a
 * `stop_reason: refusal` (the model made a judgement; another provider is not
 * entitled to overrule it on our behalf), or a max_tokens truncation (a bigger
 * cap fixes it, a different vendor does not).
 */
export function shouldFailOver(err: unknown): boolean {
  if (!(err instanceof LlmCallError)) return false;
  if (err.kind === "transport" || err.kind === "timeout") return true;
  if (err.kind !== "http") return false; // "protocol" — refusal / truncation / bad tool call
  const status = err.status ?? 0;
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  if (status === 401 || status === 402 || status === 403) return true;
  if (status === 400 && CREDIT_EXHAUSTED_400.test(err.body ?? "")) return true;
  return false;
}

/** A short, body-free reason code for the failover log line. The response body
 * is deliberately NOT logged: provider error payloads can echo request fields,
 * and this file must never be a way transcript-derived text reaches the logs. */
function failoverReason(err: unknown): string {
  if (!(err instanceof LlmCallError)) return "unknown";
  if (err.kind === "http") {
    return err.status === 400 ? "400 credit_exhausted" : `http ${err.status ?? "?"}`;
  }
  return err.kind;
}

/**
 * How long one distinct failover situation stays "already reported". A primary
 * that is out of credit fails over on EVERY tick of every session, so an
 * un-throttled line per call is noise, not signal — SessionDO already learned
 * this and dedupes its own served-leg breadcrumb to one line per session, and
 * the layer below it must not undo that. One line per distinct
 * primary→fallback→reason per minute per isolate keeps the transition visible
 * (the first one is always logged, immediately) while a sustained outage costs
 * a line a minute instead of a line a call.
 */
const FAILOVER_LOG_WINDOW_MS = 60_000;
const failoverLoggedAt = new Map<string, number>();

/** True if this exact failover situation has not been logged inside the window.
 * Expired keys are dropped as we go, so the map cannot grow without bound. */
function shouldLogFailover(key: string, now: number): boolean {
  for (const [k, at] of failoverLoggedAt) {
    if (now - at >= FAILOVER_LOG_WINDOW_MS) failoverLoggedAt.delete(k);
  }
  const last = failoverLoggedAt.get(key);
  if (last !== undefined && now - last < FAILOVER_LOG_WINDOW_MS) return false;
  failoverLoggedAt.set(key, now);
  return true;
}

/** Test-only: clears the failover-log throttle so one test's log cannot
 * suppress another's. Never called from production code. */
export function resetFailoverLogThrottle(): void {
  failoverLoggedAt.clear();
}

/** Default output cap. Every pass returns small structured arrays; callers
 * with known-smaller outputs (whisper rewrite) pass a tighter cap. */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * Floor on the completion budget handed to a REASONING model on the
 * OpenAI-compat wire. A reasoning model spends tokens thinking before it emits
 * the forced tool call, and every provider we speak to charges that thinking
 * against the same budget, so a cap sized for the tool call alone can starve it.
 *
 * This is a FLOOR, never a ceiling: a caller asking for more than this keeps
 * what it asked for, and no non-reasoning model is affected at all (I1/I2 —
 * the Anthropic primary and the hosted OpenAI-compat leg keep their exact
 * bytes; `gpt-5.6-luna` already took the gpt-5 branch before this existed).
 */
const REASONING_HEADROOM_TOKENS = 4096;

/**
 * OpenAI-compat models that reason before answering but still take the classic
 * `max_tokens` field (unlike GPT-5/o-series, which require
 * `max_completion_tokens`). This includes the `openai/gpt-oss-*` family,
 * matched with a `/` or
 * start-of-string anchor so a hypothetical `notgpt-oss` cannot match.
 */
export function isReasoningBudgetModel(model: string): boolean {
  return /(^|\/)gpt-oss/.test(model);
}

/** `reasoning_effort` sent with every {@link isReasoningBudgetModel} request. */
const GPT_OSS_REASONING_EFFORT = "low";

/**
 * Whether a failure is worth coming back for. Sole home of the policy;
 * session-do's `isRetryableFailure` delegates here so the retry rule and the
 * both-legs-down error below cannot drift apart.
 *
 * No status = a network error, a timeout, or a body we could not parse:
 * transient enough, and the caller's retry cap bounds the pathological case.
 * 429/408/5xx are the provider saying "come back". A 400/401/403 is our
 * request being wrong, and retrying that just loops.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Converts a usage block into cost-weighted "input-token-equivalent" units,
 * using Sonnet-class price ratios (cache write 1.25x, cache read 0.1x,
 * output 5x input). The session budget is denominated in these units so a
 * cache-heavy tick isn't charged like a cold one.
 */
/** Resolved sampling temperature: an explicit per-call opt wins over the
 * config default; undefined means "let the provider decide" (production). */
function temperatureOf(config: LlmConfig, opts: { temperature?: number }): number | undefined {
  return opts.temperature ?? config.temperature;
}

export function costWeightedUnits(usage: LlmUsage): number {
  return Math.round(
    (usage.input_tokens || 0) +
      1.25 * (usage.cache_creation_input_tokens || 0) +
      0.1 * (usage.cache_read_input_tokens || 0) +
      5 * (usage.output_tokens || 0),
  );
}

/**
 * Converts a usage block into micro-dollars (1e-6 USD) at an explicitly
 * supplied per-1M rate. List price is quoted per 1M tokens, so the per-1M rate
 * is exactly micro-dollars per token; integer micro-dollars are the storage
 * unit for the per-user meter (no float drift across a month of accrual).
 *
 * This is the ARITHMETIC only — it holds no opinion about what a provider or a
 * model costs. That opinion lives in one place, `llm/pricing.ts`, keyed on
 * provider AND model. There used to be a `MODEL_RATES` table right here keyed
 * on model name alone, with an unmarked Sonnet default for anything it didn't
 * recognise; that caused provider/model attribution defects
 * and it is gone rather than wrapped, so nothing can still call it by accident.
 *
 * The cache multipliers default to Anthropic's published ratios (write 1.25x
 * input, read 0.1x input) because that is what every caller wanted before flat
 * rates existed. A flat-rate provider passes 1 and 1.
 */
export function usageMicrosAt(
  usage: LlmUsage,
  inputPerM: number,
  outputPerM: number,
  cacheWriteMultiplier = 1.25,
  cacheReadMultiplier = 0.1,
): number {
  return Math.round(
    inputPerM * (usage.input_tokens || 0) +
      cacheWriteMultiplier * inputPerM * (usage.cache_creation_input_tokens || 0) +
      cacheReadMultiplier * inputPerM * (usage.cache_read_input_tokens || 0) +
      outputPerM * (usage.output_tokens || 0),
  );
}

interface MessagesResponse {
  stop_reason?: string;
  content?: Array<{ type: string; name?: string; input?: unknown }>;
  usage?: Partial<LlmUsage>;
}

function reportUsage(config: LlmConfig, usage: Partial<LlmUsage> | undefined, leg: ServedLeg): void {
  if (!config.onUsage || !usage) return;
  config.onUsage(
    {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
    leg,
  );
}

/** The leg a config describes. `fallback` says which side of the failover it is. */
function legOf(config: LlmConfig, fallback: boolean): ServedLeg {
  return {
    provider: config.provider ?? "anthropic",
    model: config.model,
    baseUrl: config.baseUrl,
    fallback,
  };
}

/** Timeout budget for one attempt on `config`. */
function timeoutOf(config: LlmConfig): number {
  return config.timeoutMs ?? LLM_TIMEOUT_MS;
}

/**
 * Invokes a tool-schema (see backend/schemas/*.json) against the Messages
 * API, forcing the model to call the single tool so the reply is structured
 * JSON matching `tool.output_schema`.
 *
 * Caching: the one `cache_control` breakpoint sits on the system prompt,
 * which (render order: tools -> system -> messages) caches the tool schema
 * and system prompt together. Prompts below the model's minimum cacheable
 * prefix silently don't cache — the marker costs nothing in that case.
 *
 * These are cheap structured-extraction calls using forced `tool_choice`.
 * Omit `thinking` entirely: off is the default on models that support it,
 * while older and adaptive-thinking-only models reject an explicit
 * `{ type: "disabled" }`.
 */
async function callToolAnthropic<TOutput>(
  config: LlmConfig,
  leg: ServedLeg,
  tool: ToolSchema,
  input: unknown,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<TOutput> {
  const body = {
    model: config.model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    system: [
      {
        type: "text",
        text: tool.system_prompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: JSON.stringify(input) }],
    tools: [
      {
        name: tool.name,
        description: tool.description,
        input_schema: tool.output_schema,
      },
    ],
    tool_choice: { type: "tool", name: tool.name },
    // Optional (eval harness sets 0 for determinism, via opts or config);
    // omitted in production so the request body stays byte-identical to before.
    ...(temperatureOf(config, opts) !== undefined ? { temperature: temperatureOf(config, opts) } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutOf(config)),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    throw new LlmCallError(
      isTimeout ? `LLM call timed out after ${timeoutOf(config)}ms` : `LLM call failed: ${String(err)}`,
      undefined,
      isTimeout ? "timeout" : "transport",
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw new LlmCallError(httpErrorMessage(res.status, text, config.logContent), res.status, "http", text);
  }

  const json = (await res.json()) as MessagesResponse;
  reportUsage(config, json.usage, leg);

  if (json.stop_reason === "refusal") {
    throw new LlmCallError("LLM declined the request (stop_reason: refusal)");
  }
  if (json.stop_reason === "max_tokens") {
    // A tool call truncated mid-input is unusable; surface it rather than
    // handing callers a partial object.
    throw new LlmCallError("LLM output hit max_tokens before completing the tool call");
  }

  const toolUse = json.content?.find((b) => b.type === "tool_use" && b.name === tool.name);
  if (!toolUse || toolUse.input === undefined || toolUse.input === null) {
    throw new LlmCallError("LLM response did not include a tool call");
  }
  return toolUse.input as TOutput;
}

/** One attempt on one leg: dispatch by wire protocol, then announce the leg
 * that produced the result. `onLeg` fires only on success — a leg that threw
 * did not serve the call. */
async function attemptLeg<TOutput>(
  config: LlmConfig,
  leg: ServedLeg,
  tool: ToolSchema,
  input: unknown,
  opts: { maxTokens?: number; temperature?: number },
): Promise<TOutput> {
  const out = isOpenAiCompat(config.provider)
    ? await callToolOpenAICompat<TOutput>(config, leg, tool, input, opts)
    : await callToolAnthropic<TOutput>(config, leg, tool, input, opts);
  config.onLeg?.(leg);
  return out;
}

/**
 * Dispatches to the native Anthropic Messages client or the OpenAI-compatible
 * client by config.provider, then — and only if `config.fallback` is set and
 * the failure is in the BAR's trigger list — makes exactly ONE more attempt on
 * the fallback leg.
 *
 * Shape of the guarantee:
 *  - `config.fallback` unset (every BYOK config, and every config at all unless
 *    FALLBACK_* is configured) ⇒ this function is byte-identical to the version
 *    that shipped before failover existed: one attempt, same request, same
 *    error. Invariants I1 and I2.
 *  - The fallback config carries no `fallback` of its own, so failover can never
 *    chain. One extra attempt per call, no retry storm.
 *  - Both legs report through the SAME `onUsage`/`onLeg`, each tagged with its
 *    own ServedLeg, so whichever leg produced a usage block is metered at ITS
 *    provider+model and never at the other leg's.
 */
export async function callTool<TOutput>(
  config: LlmConfig,
  tool: ToolSchema,
  input: unknown,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<TOutput> {
  const primary = legOf(config, false);
  try {
    return await attemptLeg<TOutput>(config, primary, tool, input, opts);
  } catch (err) {
    const fb = config.fallback;
    if (!fb || !shouldFailOver(err)) throw err;

    const line = `LLM failover: ${primary.provider}/${primary.model} -> ${fb.provider}/${fb.model} (${failoverReason(err)})`;
    if (shouldLogFailover(line, Date.now())) console.warn(line);

    const fallbackConfig: LlmConfig = {
      baseUrl: fb.baseUrl,
      apiKey: fb.apiKey,
      model: fb.model,
      provider: fb.provider,
      timeoutMs: fb.timeoutMs ?? FALLBACK_TIMEOUT_MS,
      temperature: config.temperature,
      logContent: config.logContent,
      onUsage: config.onUsage,
      onLeg: config.onLeg,
      // No `fallback` here — exactly one fallback attempt, never a chain.
    };

    try {
      return await attemptLeg<TOutput>(fallbackConfig, legOf(fallbackConfig, true), tool, input, opts);
    } catch (fallbackErr) {
      // Surface BOTH failures. Reporting only the fallback's error would send
      // an operator hunting a healthy provider while the real fault ("primary
      // is out of credit") stayed invisible.
      const primaryMsg = err instanceof Error ? err.message : String(err);
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);

      // A FALLBACK MUST NEVER MAKE A FAILURE HARDER TO RECOVER FROM THAN NO
      // FALLBACK AT ALL. The caller (session-do) decides whether to HOLD an
      // analysis window for another try or consume it, and it decides on the
      // status of the error it is handed. So a retryable primary failure — a
      // 429, a 5xx, a timeout, all of which would have held the window with no
      // fallback configured — must not be downgraded to "give up" just because
      // the fallback then answered with something permanent-looking. That is
      // A permanent-looking fallback error must not silently convert "retry
      // this window in a moment" into "drop it".
      //
      // So: report the leg whose error the caller can do the MOST with,
      // preferring the primary on a tie because that is the pre-fallback
      // behaviour. Both messages are in the text either way.
      const legOfError = (e: unknown) =>
        e instanceof LlmCallError
          ? { status: e.status, kind: e.kind, body: e.body }
          : { status: undefined, kind: "protocol" as LlmErrorKind, body: undefined };
      const primaryLeg = legOfError(err);
      const fallbackLeg = legOfError(fallbackErr);
      const reported =
        isRetryableStatus(primaryLeg.status) && !isRetryableStatus(fallbackLeg.status)
          ? primaryLeg
          : fallbackLeg;

      throw new LlmCallError(
        `LLM call failed on both legs — primary ${primary.provider}/${primary.model}: ${primaryMsg}; ` +
          `fallback ${fb.provider}/${fb.model}: ${fallbackMsg}`,
        reported.status,
        reported.kind,
        reported.body,
      );
    }
  }
}

interface ChatCompletionsResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** `cached_tokens` = cache READS. `cache_write_tokens` = cache WRITES, which
     * some OpenAI-compatible providers report and which bill at
     * a PREMIUM (1.25x input on Anthropic-family models), not at a discount.
     * Both are subsets of `prompt_tokens`. */
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

/**
 * The OpenAI-compatible path, shared by every provider that speaks Chat
 * Completions: OpenRouter (BYOK or fallback) and OpenAI proper
 * (HOSTED_PAID_PROVIDER). Forces a single function call so the reply is
 * structured JSON matching tool.output_schema, mirroring the Anthropic path's
 * forced tool_choice.
 *
 * `x-title` is OpenRouter's attribution header and is sent on this transport.
 */
async function callToolOpenAICompat<TOutput>(
  config: LlmConfig,
  leg: ServedLeg,
  tool: ToolSchema,
  input: unknown,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<TOutput> {
  const maxOut = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "system", content: tool.system_prompt },
      { role: "user", content: JSON.stringify(input) },
    ],
    tools: [
      {
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.output_schema },
      },
    ],
    tool_choice: { type: "function", function: { name: tool.name } },
    ...(temperatureOf(config, opts) !== undefined ? { temperature: temperatureOf(config, opts) } : {}),
  };
  // OpenAI's GPT-5 / o-series are reasoning models on Chat Completions: they
  // reject `max_tokens` (require `max_completion_tokens`). We also force
  // reasoning OFF — with function tools + reasoning on, GPT-5.6 rejects the
  // request outright ("Function tools with reasoning_effort are not supported …
  // set reasoning_effort to 'none'"), and for our structured-extraction pass we
  // want the cheap/fast non-reasoning path anyway. Headroom above the classic
  // cap keeps the forced tool call from being starved into a "length" failure.
  // Every other OpenAI-compatible model (Groq, Llama, GPT-4o) keeps `max_tokens`.
  if (/^(gpt-5|o[13])/.test(config.model)) {
    body.max_completion_tokens = Math.max(maxOut, REASONING_HEADROOM_TOKENS);
    body.reasoning_effort = "none";
  } else if (isReasoningBudgetModel(config.model)) {
    // These models spend part of `max_tokens` on reasoning before emitting the
    // forced tool call. Give them headroom and request low reasoning effort so
    // the structured result is not starved. The caller's larger cap still wins.
    body.max_tokens = Math.max(maxOut, REASONING_HEADROOM_TOKENS);
    body.reasoning_effort = GPT_OSS_REASONING_EFFORT;
  } else {
    body.max_tokens = maxOut;
  }

  let res: Response;
  try {
    res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
        // OpenRouter attribution (optional, harmless).
        "x-title": "Cyrano",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutOf(config)),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    throw new LlmCallError(
      isTimeout ? `LLM call timed out after ${timeoutOf(config)}ms` : `LLM call failed: ${String(err)}`,
      undefined,
      isTimeout ? "timeout" : "transport",
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw new LlmCallError(httpErrorMessage(res.status, text, config.logContent), res.status, "http", text);
  }

  const json = (await res.json()) as ChatCompletionsResponse;
  // Map OpenAI-shape usage onto LlmUsage so the per-session budget still bounds
  // a BYOK session. (BYOK is never metered for OUR dollars — see SessionDO.)
  // `prompt_tokens` is the WHOLE prompt
  // side; `cached_tokens` (reads) and `cache_write_tokens` (writes) are subsets
  // of it, so fresh input is what remains after removing both. Writes used to be
  // hardcoded to 0, which left them inside `input_tokens` and priced them at
  // 1.0x — a silent 25% under-count the moment an Anthropic-family model is
  // fronted by an OpenAI-compatible gateway on our key (cache writes bill at
  // 1.25x input there). Correct for configurable fallback destinations.
  const details = json.usage?.prompt_tokens_details;
  const nonNegative = (n: number | undefined): number =>
    typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  const cacheRead = nonNegative(details?.cached_tokens);
  const cacheWrite = nonNegative(details?.cache_write_tokens);
  const promptTokens = nonNegative(json.usage?.prompt_tokens);
  reportUsage(
    config,
    {
      input_tokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
      output_tokens: json.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
    },
    leg,
  );

  const choice = json.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new LlmCallError("LLM output hit max_tokens before completing the tool call");
  }
  const named = choice?.message?.tool_calls?.find((c) => c.function?.name === tool.name);
  const call = named ?? choice?.message?.tool_calls?.[0];
  if (!named && call) {
    // The forced tool came back under a different name. Still parseable, but
    // this is exactly the kind of silent divergence from the Anthropic path
    // that makes one engine's output quietly incomplete — say so in the logs.
    console.error(
      `LLM tool call name mismatch (model=${config.model}): expected "${tool.name}", got "${call.function?.name ?? "?"}" — using it anyway`,
    );
  }
  const raw = call?.function?.arguments;
  if (raw === undefined || raw === null || raw === "") {
    throw new LlmCallError("LLM response did not include a tool call");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    // Under-specified schemas make some models double-encode the arguments (a
    // JSON string wrapping the real object) — the exact failure that made the
    // old OpenAI-compat shim unreliable. Unwrap one level defensively.
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    throw new LlmCallError("LLM tool call arguments were not valid JSON");
  }
  return parsed as TOutput;
}

/**
 * Minimal reachability + credential probe for the Settings "Test connection"
 * flow: one 1-output-token message. Distinguishes a bad Anthropic key
 * (401/403) from every other failure so the client can show the right fix.
 */
export async function pingLlm(
  config: LlmConfig,
): Promise<{ ok: true } | { ok: false; kind: "auth" | "error"; status?: number; message: string }> {
  if (isOpenAiCompat(config.provider)) return pingOpenAiCompat(config);
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, kind: "error", message: `LLM endpoint unreachable: ${String(err)}` };
  }
  if (res.ok) {
    await reportPingUsage(config, res, false);
    return { ok: true };
  }
  const message = (await res.text()).slice(0, 500);
  return {
    ok: false,
    kind: res.status === 401 || res.status === 403 ? "auth" : "error",
    status: res.status,
    message,
  };
}

/**
 * Report the usage of a successful {@link pingLlm} probe through
 * `config.onUsage`, exactly like a real call.
 *
 * The probe is one input token and one output token — roughly $0.00002 — but it
 * is a call on OUR key, and "every dollar we spend is attributed to a subject"
 * has no smallness exemption; an unmetered our-key path is also the sort of
 * thing that stays small only until something starts hammering it. Best-effort
 * by construction: an unparseable body attributes nothing and never turns a
 * healthy probe into a failure.
 */
async function reportPingUsage(config: LlmConfig, res: Response, openAiCompat: boolean): Promise<void> {
  if (!config.onUsage) return;
  try {
    const json = (await res.json()) as {
      usage?: Partial<LlmUsage> & { prompt_tokens?: number; completion_tokens?: number };
    };
    const u = json.usage;
    if (!u) return;
    reportUsage(
      config,
      openAiCompat
        ? {
            input_tokens: u.prompt_tokens ?? 0,
            output_tokens: u.completion_tokens ?? 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          }
        : u,
      legOf(config, false),
    );
  } catch {
    // Unparseable probe body: nothing to attribute, and never a probe failure.
  }
}

/** OpenAI-compatible reachability + credential probe, so the Settings "Test
 * connection" flow works for an OpenRouter BYOK key too. */
async function pingOpenAiCompat(
  config: LlmConfig,
): Promise<{ ok: true } | { ok: false; kind: "auth" | "error"; status?: number; message: string }> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
        "x-title": "Cyrano",
      },
      body: JSON.stringify({ model: config.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, kind: "error", message: `LLM endpoint unreachable: ${String(err)}` };
  }
  if (res.ok) {
    await reportPingUsage(config, res, true);
    return { ok: true };
  }
  const message = (await res.text()).slice(0, 500);
  return {
    ok: false,
    kind: res.status === 401 || res.status === 403 ? "auth" : "error",
    status: res.status,
    message,
  };
}

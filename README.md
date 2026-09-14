# Cyrano Backend

The server half of Cyrano, a conversation copilot for iPhone and Mac. The client transcribes and diarizes on-device; this Cloudflare Worker takes the resulting text, keeps the session, runs the analysis passes against an LLM, and pushes what it finds back to the client while the conversation is still happening.

Run your own so that your transcripts land on your Cloudflare account, your analysis runs on your API key, and the only server that ever sees your conversations is one you deployed.

- **Live extraction** — commitments, open asks, subtext, next-move suggestions, decisions, and whisper candidates from a rolling transcript window, in one batched call.
- **Sessions that survive the network** — WebSocket sessions backed by Durable Objects, with resume-from-sequence, presence, and end-of-session flush.
- **Your keys or the operator's** — clients can bring an Anthropic or OpenRouter key per session; a client key is never failed over onto the operator's.
- **Retention is the client's call** — `ephemeral`, `24h`, or `pinned`, narrowable mid-session, with redaction and purge.
- **Agents can read and write** — a scoped agent token lets an external assistant read session context and push notes back; an OAuth/MCP surface lets ChatGPT and Claude connect as connectors.
- **Fails closed** — billing, App Store, trials, price-testing, fallback providers, and content logging are all off until you deliberately configure them.

## How it works

```
Cyrano client ──WebSocket──▶ SessionDO ──▶ LLM (Anthropic Messages API)
  transcript segments          rolling window, batched extraction
  ◀── analysis.result ─────────┘

                              RegistryDO      users, tenants, entitlements,
                                              license and promo keys, usage
                              AccountInboxDO  per-account index and
                                              agent → user pings
```

Three Durable Object classes hold all state; there is no database to provision. `SessionDO` owns one conversation: it buffers transcript segments, windows them, runs the analysis passes (see [`schemas/`](schemas/) for the tool schemas the model is forced to call), meters usage, and streams results back. `RegistryDO` is the single-instance directory of who may connect and what they are entitled to. `AccountInboxDO` is one-per-account: a session index the client can list, and a standing inbox for proactive agent messages.

Stateless HTTP routes cover everything that does not need a live session: `/analyze` and `/ask` over a supplied transcript, `/dictation/polish`, `/context/refine`, and a `/health/llm` probe that spends one output token to verify a key.

## Quick start

You need Node.js 22.12+, a Cloudflare account with Workers and Durable Objects, and an Anthropic API key.

```sh
git clone https://github.com/F-RND/cyrano-backend.git
cd cyrano-backend
npm ci
npm run typecheck && npm test      # runs offline, no API key needed

npx wrangler login
npx wrangler secret put AUTH_TOKEN  # any long random string; clients present it as a bearer token
npx wrangler secret put LLM_API_KEY # your Anthropic key
npm run deploy
```

Wrangler deploys to whichever account you logged in with and prints the Worker URL. Nothing in [`wrangler.jsonc`](wrangler.jsonc) is bound to a particular account, hostname, or billing catalog; CI runs a dry-run deploy against it on every push.

Then, in the Cyrano app, open Settings → Backend and enter the Worker URL and the `AUTH_TOKEN` you set. Start a session; the analysis panel should populate within the first window.

`GET /health` on the deployed URL returns `ok` without authentication if you want to check the deploy before touching the app.

## Local development

```sh
cp .dev.vars.example .dev.vars   # then fill in AUTH_TOKEN and LLM_API_KEY
npm run dev                      # wrangler dev, with local Durable Objects
npm run test:watch
```

`.dev.vars` is ignored by git, as are `.env*`, Wrangler state, and anything matching the generated-report patterns in [`.gitignore`](.gitignore). The test suite runs offline against mocked providers; no API key or Cloudflare account is needed to run it.

Layout:

| Path | What lives there |
| --- | --- |
| `src/index.ts` | Route table and request auth; forwards into the Durable Objects |
| `src/session-do.ts`, `src/registry-do.ts`, `src/account-inbox-do.ts` | The three Durable Object classes |
| `src/analysis/` | Windowing, the batched extraction pass, custom categories, whisper tiers, re-analysis, dictation polish |
| `src/llm/` | Provider client (Anthropic native + OpenAI-compatible), fallback leg, pricing and spend metering |
| `src/policy/` | The interruption-etiquette grammar and simulator that gates whisper delivery |
| `src/auth.ts`, `src/entitlement.ts`, `src/license.ts`, `src/promo.ts`, `src/trial.ts` | Identity, plans, and the key formats |
| `src/stripe.ts`, `src/appstore*.ts` | Optional hosted-tier billing, inert without their secrets |
| `src/chatgpt-mcp.ts` | OAuth 2.1 / PKCE authorization server and MCP resource for connector clients |
| `schemas/` | JSON schemas for every forced tool call the model makes |
| `test/` | Vitest unit and integration tests |

## Bring your own key

A client may send `llm_api_key` (with `llm_provider` `anthropic`, `openrouter` or `openai`, and an `llm_model` — required for the latter two) in its session `hello`. That session then runs on the user's key and the user's provider; the operator's `LLM_API_KEY` is not touched, usage is counted but not priced, and the operator's fallback leg is never applied. The key is held in the Durable Object's memory for the connection and is cleared on the next `hello` that omits it.

## Configuration reference

### Where values go

| Kind | Examples | Production | Local `npm run dev` |
| --- | --- | --- | --- |
| Secrets | `AUTH_TOKEN`, `LLM_API_KEY`, `STRIPE_SECRET_KEY`, any key named by a `*_KEY_ENV` variable | `npx wrangler secret put NAME` | `.dev.vars` |
| Variables | `LLM_MODEL`, `LLM_BASE_URL`, `FALLBACK_*`, feature flags | `vars` block in `wrangler.jsonc` | `.dev.vars` (overrides `vars`) |

Every value the Worker reads is a string. Boolean flags are opt-in only on the literal, case-sensitive string `"true"`. `.dev.vars.example` lists every variable with its optional groups commented out.

### Which providers the primary path accepts

`LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` configure the primary analysis path. `LLM_PROVIDER` names the **wire protocol** the Worker speaks to `LLM_BASE_URL`, not a company:

| `LLM_PROVIDER` | Wire | `LLM_BASE_URL` examples |
| --- | --- | --- |
| `anthropic` (default) | native Anthropic Messages API (`POST {LLM_BASE_URL}/messages`) | `https://api.anthropic.com/v1`; any endpoint implementing the Messages API — a Cloudflare AI Gateway Anthropic route, a self-hosted proxy |
| `openrouter` (alias `openai`) | OpenAI-compatible Chat Completions (`POST {LLM_BASE_URL}/chat/completions`) | `https://api.openai.com/v1`; `https://openrouter.ai/api/v1`; any compatible server |

The tag never changes the URL: an operator choosing `openrouter` sets `LLM_BASE_URL` to the endpoint they mean. Running on OpenAI is therefore four settings:

```jsonc
// wrangler.jsonc → "vars"
"LLM_PROVIDER": "openrouter",            // or "openai" — same thing
"LLM_BASE_URL": "https://api.openai.com/v1",
"LLM_MODEL": "gpt-5.6-luna",
```

```sh
npx wrangler secret put LLM_API_KEY      # the OpenAI key
```

Cost reporting resolves the billing account from the base URL's host, so an `openrouter`-wire primary pointed at `api.openai.com` prices on the OpenAI rate card without further configuration. The same tag vocabulary applies to the optional groups below (`FALLBACK_PROVIDER`, `HOSTED_PAID_PROVIDER`, price-test targets). Cyrano clients may also bring their own key per session (`hello.llm_api_key` with `llm_provider` `"anthropic"`, `"openrouter"` or `"openai"` — the client names a destination, and the server owns the base URL for each); a client key is never failed over onto the operator's key.

### Primary path

| Name | Kind | Default | Notes |
| --- | --- | --- | --- |
| `AUTH_TOKEN` | secret | — | Required. Bearer token for clients and admin routes. |
| `LLM_PROVIDER` | var | `anthropic` | Wire for the primary path: `anthropic` or `openrouter` (`openai` accepted as an alias). Unknown values fall back to `anthropic`. |
| `LLM_API_KEY` | secret | — | Required. Key for the primary path, at whichever provider `LLM_PROVIDER` names. |
| `LLM_BASE_URL` | var | `https://api.anthropic.com/v1` | `/v1` root of the primary provider. Never redirected by `LLM_PROVIDER`. |
| `LLM_MODEL` | var | `claude-sonnet-5` | Model for operator and self-host sessions. |
| `TRANSCRIPT_CONTENT_LOGGING` | var | `false` | Keep `false`; `true` permits transcript-derived text in logs and exceptions. |

### Fallback leg (optional, off by default)

A second provider tried exactly once after the primary fails in a retryable way. Never used for client-supplied keys. Inert unless `FALLBACK_PROVIDER` names a provider *and* the key it points at is non-empty.

| Name | Kind | Default | Notes |
| --- | --- | --- | --- |
| `FALLBACK_PROVIDER` | var | `""` | `anthropic` or `openrouter`. Anything else disables the feature. |
| `FALLBACK_KEY_ENV` | var | — | Required. The *name* of the secret holding the fallback key (for example `OPENROUTER_API_KEY`), never the key itself. |
| `FALLBACK_MODEL` | var | — | Required. Model on the fallback provider. |
| `FALLBACK_BASE_URL` | var | OpenRouter's public root for `openrouter`; none for `anthropic` | `/v1` root. Required for `anthropic`. |
| `FALLBACK_TIMEOUT_MS` | var | `15000` | Budget for the fallback attempt alone. |
| `FALLBACK_RATE_USD_PER_M` | var | — | Flat USD per 1M tokens for cost reporting when the provider has no published per-model price. |

### Hosted paid tier (optional)

Only meaningful when sessions have an owning user (Stripe or App Store entitlement). Self-host deployments that set none of these run unchanged.

| Name | Kind | Default | Notes |
| --- | --- | --- | --- |
| `HOSTED_PAID_MODEL` | var | — | Model for owned (paid) sessions; unset falls back to `LLM_MODEL`. |
| `HOSTED_PAID_PROVIDER` | var | — | `openrouter` runs owned sessions over OpenAI-compatible Chat Completions; unset keeps native Anthropic. |
| `HOSTED_PAID_BASE_URL` | var | OpenRouter's public root | `/v1` root for the paid provider (for example `https://api.openai.com/v1`). |
| `HOSTED_PAID_KEY_ENV` | var | `LLM_API_KEY` | Name of the secret holding the paid-provider key. |
| `STRIPE_SECRET_KEY` | secret | — | Stripe routes return 503 without it. |
| `STRIPE_WEBHOOK_SECRET` | secret | — | Webhook signature verification. |
| `STRIPE_PRICE_ANNUAL`, `STRIPE_PRICE_MONTHLY` | var | — | Recurring Price ids. |
| `LANDING_BASE_URL` | var | — | Origin for Checkout return/cancel URLs. |
| `TRIAL_SIGNING_PRIVATE_KEY` | secret | — | Base64 PKCS8 Ed25519 key for signing trial tokens; unset disables `/trial/*`. |
| `PLAN_REVENUE_USD_PER_MONTH` | var | list prices | JSON `{plan: usd}` for the `/costs` report only; nothing bills on it. |

### Token-less routes (optional, off by default)

| Name | Kind | Default | Notes |
| --- | --- | --- | --- |
| `APP_STORE_ENABLED` | var | `false` | Enables `/appstore/*`. Still rejects everything until both values below are set. |
| `APPLE_BUNDLE_IDS` | var | — | Comma-separated bundle identifiers allowed to link. |
| `APPLE_ENVIRONMENT` | var | — | Exact accepted environment, normally `Production` or `Sandbox`. |
| `FREE_COLD_ENROLLMENT_ENABLED` | var | `false` | Enables token-less `/free-cold/enroll`. |

### Shadow price testing (optional, off by default)

Fans each hosted analysis window out to additional providers on the operator's keys for measurement. Adds egress and spend; leave disabled unless deliberately evaluating providers with synthetic data.

| Name | Kind | Default | Notes |
| --- | --- | --- | --- |
| `PRICE_TEST_ENABLED` | var | `false` | Literal `true` enables. Never runs on client-key sessions. |
| `PRICE_TEST_SAMPLE_RATE` | var | `1` | Fraction of windows to shadow, `0`–`1`. |
| `PRICE_TEST_TARGETS` | var | `[]` | JSON array of `{ label, provider, baseUrl, model, keyEnv, inputPerM, outputPerM }`. |

## What stays off until you turn it on

Every optional integration either returns 503 or is skipped entirely when its configuration is absent, and the checked-in `wrangler.jsonc` sets each flag to its off value explicitly so the dry-run bindings table shows the posture:

- Transcript-derived content in logs and exception strings (`TRANSCRIPT_CONTENT_LOGGING`)
- The fallback provider leg (`FALLBACK_PROVIDER`)
- Shadow price testing across additional providers (`PRICE_TEST_ENABLED`)
- App Store link and notification routes (`APP_STORE_ENABLED`, plus `APPLE_BUNDLE_IDS` and `APPLE_ENVIRONMENT`)
- Token-less free-tier enrollment (`FREE_COLD_ENROLLMENT_ENABLED`)
- Stripe checkout and webhooks, trials, and the hosted paid model (their secrets)
- Cloudflare observability (`observability.enabled`)

Flags are opt-in only on the literal string `"true"`; a missing, empty, or differently-cased value leaves the route unavailable. Read the data-flow notes in the section below before enabling anything that adds a provider or a public route.

## Data and trust boundaries

- Transcript segments travel over TLS to the operator-controlled Worker.
- Session data is stored in Durable Objects according to the client-selected retention mode.
- Analysis windows are sent to the configured LLM provider under the operator's or user's provider account.
- A user-supplied provider key passes through the Worker and can be serialized in the active WebSocket attachment for that connection; users must trust the operator and deployed code.
- `TRANSCRIPT_CONTENT_LOGGING=true` deliberately enables transcript-derived diagnostics. Leave it unset or `false` for real sessions.
- Rotating `AUTH_TOKEN` blocks new authentication and reconnects; an already-open WebSocket can remain active until disconnected.

See [SECURITY.md](SECURITY.md) before exposing a deployment to the internet.

## Scope

This is a Cloudflare-specific Worker, not a portable server image; Durable Objects are load-bearing. The clients (Apple, Linux), the hosted service's own configuration, and the model-evaluation harness live elsewhere. The package is marked `private` in `package.json` only to prevent accidental npm publication.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR; changes to auth, retention, redaction, egress, schemas, or Durable Object migrations need tests and a security-minded review. Report vulnerabilities privately through GitHub's advisory flow as described in [SECURITY.md](SECURITY.md) — never with real transcripts, keys, or customer data in the report.

## License

Apache License 2.0. Preserve the [LICENSE](LICENSE), copyright notices, and [NOTICE](NOTICE) when redistributing; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for dependency licenses. The license covers the source; it does not grant rights to the Cyrano name or branding beyond customary attribution, nor access to any hosted service.

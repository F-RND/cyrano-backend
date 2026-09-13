# Cyrano Backend

A self-hostable Cloudflare Worker for Cyrano's opt-in copilot features. It accepts transcript text from an authenticated Cyrano client, stores session state in Durable Objects, and sends analysis windows to the configured LLM provider. Raw audio is not part of the backend protocol.

## What is included

- Worker source and JSON schemas
- Durable Object session, registry, and account-inbox classes
- Authentication, tenant isolation, retention, redaction, and purge behavior
- Anthropic-compatible analysis and optional integrations that fail closed when unconfigured
- Unit and integration tests

Operator-only beta distribution scripts, private model-evaluation assets and
live-provider probes, private deployment identifiers, production secrets, and
monorepo history are intentionally excluded. The source still contains an
optional shadow price-testing path; it is disabled in the checked-in
configuration and should remain disabled unless an operator deliberately
configures and reviews its additional provider egress.

## Requirements

- Node.js 22.12 or newer
- A Cloudflare account with Workers and Durable Objects
- An Anthropic API key (or a key for an Anthropic-compatible gateway; see [Configuration reference](#configuration-reference))

## Install and verify

```sh
npm ci
npm run typecheck
npm test
npm run deploy:dry-run
```

## Local development

```sh
cp .dev.vars.example .dev.vars
# Replace both placeholder values in .dev.vars.
npm run dev
```

`.dev.vars`, `.env`, Wrangler state, generated reports, and dependency directories are ignored. Never commit credentials or transcripts.

## Deploy

Authenticate Wrangler, set the two required secrets, and deploy:

```sh
npx wrangler login
npx wrangler secret put AUTH_TOKEN
npx wrangler secret put LLM_API_KEY
npm run deploy
```

Wrangler uses the Cloudflare account selected by your authenticated session. The checked-in configuration contains no account ID, production hostname, bucket ID, email binding, or billing catalog ID.

### Required secrets

| Name | Purpose |
| --- | --- |
| `AUTH_TOKEN` | Operator bearer token used by Cyrano clients and administrative endpoints |
| `LLM_API_KEY` | Anthropic API key used for copilot analysis on the operator's account |

Use a randomly generated `AUTH_TOKEN` and store both values with `wrangler secret put`. Do not put real values in `wrangler.jsonc`, `.dev.vars.example`, shell history, issue reports, or chat messages.

## Configuration reference

### Where values go

| Kind | Examples | Production | Local `npm run dev` |
| --- | --- | --- | --- |
| Secrets | `AUTH_TOKEN`, `LLM_API_KEY`, `STRIPE_SECRET_KEY`, any key named by a `*_KEY_ENV` variable | `npx wrangler secret put NAME` | `.dev.vars` |
| Variables | `LLM_MODEL`, `LLM_BASE_URL`, `FALLBACK_*`, feature flags | `vars` block in `wrangler.jsonc` | `.dev.vars` (overrides `vars`) |

Every value the Worker reads is a string. Boolean flags are opt-in only on the literal, case-sensitive string `"true"`. `.dev.vars.example` lists every variable with its optional groups commented out.

### Which providers the primary path accepts

`LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` configure the primary analysis path, and that path speaks the **native Anthropic Messages API** (`POST {LLM_BASE_URL}/messages`). Accepted values are therefore:

- an Anthropic API key with the default `LLM_BASE_URL` of `https://api.anthropic.com/v1`; or
- a key for any endpoint that implements the Anthropic Messages API, with `LLM_BASE_URL` pointed at its `/v1` root (a Cloudflare AI Gateway Anthropic route, a self-hosted proxy, and so on).

An OpenAI key does not work here. OpenAI-compatible Chat Completions endpoints (OpenAI, OpenRouter, any compatible server) are reachable only through the optional groups below, each of which takes `provider: "openrouter"` — the tag names the wire protocol, not the OpenRouter company. Cyrano clients may also bring their own key per session (`hello.llm_api_key` with `llm_provider` `"anthropic"` or `"openrouter"`); a client key is never failed over onto the operator's key.

### Primary path

| Name | Kind | Default | Notes |
| --- | --- | --- | --- |
| `AUTH_TOKEN` | secret | — | Required. Bearer token for clients and admin routes. |
| `LLM_API_KEY` | secret | — | Required. Anthropic-compatible key for the primary path. |
| `LLM_BASE_URL` | var | `https://api.anthropic.com/v1` | Anthropic Messages API `/v1` root. |
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

### Safe checked-in defaults

- Transcript-derived content logging is disabled.
- Shadow price testing is disabled.
- Provider fallback is disabled.
- App Store link and notification routes are disabled.
- Free-cold enrollment is disabled.
- Cloudflare observability is disabled.
- Hosted billing and transactional-email bindings are absent.

Optional code paths remain inert or return an unavailable response unless an operator deliberately adds their bindings, variables, and secrets. Review those paths and their data flows before enabling them.

### Optional token-less routes

These public routes use feature flags with literal, case-sensitive `"true"`
opt-ins. Any missing, empty, or other value leaves the route unavailable:

| Flag | Default | Additional required configuration |
| --- | --- | --- |
| `APP_STORE_ENABLED` | `false` | `APPLE_BUNDLE_IDS` (comma-separated allowlist) and `APPLE_ENVIRONMENT` (exact accepted environment) |
| `FREE_COLD_ENROLLMENT_ENABLED` | `false` | None; review the enrollment and relay data flow before opting in |

There are no built-in App Store bundle identifiers or environment defaults. An
enabled App Store route still rejects all transactions until both values are
configured. Keep `TRANSCRIPT_CONTENT_LOGGING` unset or `false`; setting it to
`true` permits transcript-derived diagnostics and provider response bodies in
exception strings.

## Data and trust boundaries

- Transcript segments travel over TLS to the operator-controlled Worker.
- Session data is stored in Durable Objects according to the client-selected retention mode.
- Analysis windows are sent to the configured LLM provider under the operator's or user's provider account.
- A user-supplied provider key passes through the Worker and can be serialized in the active WebSocket attachment for that connection; users must trust the operator and deployed code.
- `TRANSCRIPT_CONTENT_LOGGING=true` deliberately enables transcript-derived diagnostics. Leave it unset or `false` for real sessions.
- Rotating `AUTH_TOKEN` blocks new authentication and reconnects; an already-open WebSocket can remain active until disconnected.

See [SECURITY.md](SECURITY.md) before exposing a deployment to the internet.

## Scope and limitations

This is a Cloudflare-specific deployment, not a portable server image. The repository does not include the Cyrano Apple client, hosted service configuration, production credentials, operator mailing tools, payment setup, or private model-evaluation assets.

The package remains marked `private` only to prevent accidental npm publication. Source licensing is governed by [Apache License 2.0](LICENSE).

## License and attribution

Licensed under Apache License 2.0. Preserve the license, copyright notices, modification notices, and [NOTICE](NOTICE) content when redistributing covered work. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for dependency information.

The license covers source code, not trademarks, hosted-service access, credentials, or rights to the Cyrano name and branding beyond customary attribution.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md); do not put credentials, transcripts, customer information, or unredacted diagnostics in a public issue.

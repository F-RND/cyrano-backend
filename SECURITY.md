# Security policy

## Supported version

Only the current `main` branch receives security fixes.

## Reporting a vulnerability

Use GitHub's private vulnerability-reporting flow for this repository. If that flow is unavailable, contact the repository owner privately. Do not open a public issue for a suspected vulnerability.

Never include live credentials, bearer tokens, API keys, transcripts, customer identifiers, unredacted Worker logs, or private deployment metadata in a report. Use synthetic reproduction data and redact request headers.

A useful report includes the affected commit, impact, reproduction steps, and a proposed mitigation if known. Maintainers will acknowledge receipt, investigate, coordinate remediation, and credit reporters who want attribution.

## Operator responsibilities

- Store secrets only with `wrangler secret put` or an equivalent secret manager.
- Keep transcript-content logging and shadow-provider testing disabled unless using synthetic data in an isolated deployment.
- Review every optional egress path before enabling it.
- Rotate exposed credentials and terminate already-authenticated sessions; token rotation alone does not invalidate an existing WebSocket.
- Apply Cloudflare access controls, rate limits, and abuse controls appropriate to the deployment.
- Review retention modes and purge behavior against applicable privacy obligations.

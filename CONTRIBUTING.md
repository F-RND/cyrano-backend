# Contributing

Coordinate with a maintainer before beginning substantial work.

## Development gate

```sh
npm ci
npm run typecheck
npm test
npm run deploy:dry-run
```

Changes to authentication, authorization, retention, redaction, egress, schemas, Durable Object migrations, billing, or secrets require explicit security review and tests.

## Contribution terms

Contributions are submitted under Apache License 2.0. Commits must include a Developer Certificate of Origin sign-off:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Add it with `git commit -s`. The sign-off certifies the contribution under the [Developer Certificate of Origin 1.1](https://developercertificate.org/).

## Rules

- Do not contribute code copied from incompatible licenses.
- Identify generated or AI-assisted material and verify its provenance and correctness.
- Do not commit credentials, transcripts, customer data, production identifiers, or generated operator reports.
- Keep optional integrations disabled by default.
- Update documentation when behavior or data flows change.
- Preserve Apache-2.0 SPDX headers and NOTICE attribution.

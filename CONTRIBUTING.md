# Contributing to cyrano-backend

Thanks for your interest in contributing. This document covers how to propose changes, the checks every change must pass, and the terms contributions are accepted under.

## Before you start

For anything beyond a small fix, open an issue and get a maintainer's go-ahead before writing code. This avoids duplicated effort and work that can't be merged.

## Local checks

Every change must pass the full gate before review:

```sh
npm ci                  # clean install from the lockfile
npm run typecheck       # TypeScript type checking
npm test                # test suite
npm run deploy:dry-run  # validate the deploy without publishing
```

Pull requests that fail any of these will not be reviewed.

## Security-sensitive changes

Changes to any of the following require tests **and** explicit security review from a maintainer before merge:

- Authentication or authorization
- Data retention or redaction
- Network egress
- Schemas or Durable Object migrations
- Billing
- Secrets handling

Call out these areas in your pull request description so the right reviewer is assigned.

## Contribution guidelines

- **Licensing.** Do not submit code copied from sources with licenses incompatible with Apache-2.0.
- **AI-assisted work.** Disclose generated or AI-assisted material in your pull request, and verify its correctness and provenance yourself.
- **Sensitive data.** Never commit credentials, transcripts, customer data, production identifiers, or generated operator reports.
- **Integrations.** Optional integrations must be disabled by default.
- **Documentation.** Update the docs whenever behavior or data flows change.
- **Attribution.** Preserve existing Apache-2.0 SPDX headers and `NOTICE` attribution.

## License and sign-off

Contributions are accepted under the [Apache License 2.0](LICENSE).

Every commit must carry a Developer Certificate of Origin sign-off, which certifies that you have the right to submit the work under the [DCO 1.1](https://developercertificate.org/). Add it automatically with:

```sh
git commit -s
```

This appends a line like:

```text
Signed-off-by: Your Name <your-email@example.com>
```

Commits without a sign-off cannot be merged.

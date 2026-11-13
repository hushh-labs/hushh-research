# Hussh Rebrand Classification

## Visual Context

Canonical visual owner: [Operations Index](./README.md). Use that map for the top-down operations view; this page classifies repo naming surfaces for the current non-breaking rebrand phase.

## Purpose

This page classifies remaining `hushh` / `Hushh` occurrences so the repository can expand the `Hussh` public brand without breaking live functionality.

The current phase is:

1. broad internal rename where safe
2. preserve runtime-sensitive compatibility identifiers
3. default ambiguous occurrences to manual review

## Classification Buckets

### `public-brand prose`

Rewrite to `Hussh`.

Examples:

1. docs headings, captions, and narrative prose
2. README titles and contributor-facing explanations
3. founder/shareable artifacts
4. user-facing product copy that is not protocol- or integration-sensitive

### `compatibility identifier`

Preserve exactly.

Examples:

1. `./bin/hushh`
2. `hushh-webapp`
3. `@hushh/mcp`
4. `hushh-labs/hushh-research`
5. `*.hushh.ai`
6. `HUSHH_*`
7. native plugin names such as `HushhVault`, `HushhConsent`, `HushhAuth`
8. protocol/resource/server IDs such as `hushh://...`, `hushh-consent`, `hushh-mcp`
9. headers such as `X-Hushh-Consent`

### `copy-sensitive runtime string`

Preserve unless there is a dedicated alias or migration plan.

Examples:

1. bundle IDs and app IDs
2. logger names and cache directory names
3. event names and notification message types
4. published package and binary names
5. GitHub org/repo slugs in clone commands and package metadata

### `internal safe rename`

Rewrite when the change is clearly non-breaking.

Examples:

1. comments and explanatory docstrings
2. descriptive help text and parser descriptions
3. generated README prose from repo-owned templates
4. user-facing copy such as `Hushh User` fallback labels or `Hushh app` copy

### `needs manual review`

Use when the string may be visible to users but might also be integration-sensitive.

Examples:

1. server display names surfaced over protocols
2. GitHub project names used by automation lookups
3. analytics stream names
4. CSS class names or internal symbols that may be externally referenced

## High-Risk Preserved Areas

The following paths contain many intentional compatibility literals and should not be bulk-renamed:

1. `packages/hushh-mcp/`
2. `hushh-webapp/`
3. `consent-protocol/hushh_mcp/`
4. native plugin and bundle-ID surfaces under `hushh-webapp/android` and `hushh-webapp/ios`
5. deployment/runtime metadata that includes `*.hushh.ai`

## Audit Rule

The brand audit should fail on stray standalone `Hushh` prose in maintained docs and selected public-facing source files, while allowing approved compatibility identifiers.

If a match is not obviously prose or obviously compatibility-sensitive, classify it as `needs manual review` and do not rename it automatically.

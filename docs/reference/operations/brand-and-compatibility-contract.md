# Hussh Brand And Compatibility Contract

## Visual Context

Canonical visual owner: [Operations Index](./README.md). Use that map for the top-down operations view; this page defines the repo-wide naming and compatibility contract beneath it.

## Purpose

This document defines the public documentation rebrand from `Hushh` to `Hussh (Human Secure Socket Host)`.

`Hussh` is the public documentation and architecture brand for this repository.

This contract does **not** rename code, package names, CLI commands, repo slugs, deployed URLs, env vars, bundle IDs, or service identifiers. Those remain literal compatibility surfaces until a separate engineering rebrand program lands.

## Public Brand Rule

Use `Hussh` in:

1. root docs
2. `docs/` architecture, operations, vision, and guide prose
3. maintained package-local docs when they are speaking in product or architecture language
4. Codex skills, workflow packs, and contributor-facing automation prose
5. shared founder, board, or partner-facing technical artifacts unless the user requests a different one-off treatment

## Compatibility Rule

Keep the literal compatibility identifier unchanged when the reader must copy, invoke, or match a real runtime surface exactly.

This includes:

1. `./bin/hushh`
2. `hushh-webapp`
3. `consent-protocol`
4. `@hushh/mcp`
5. repo and org slugs such as `hushh-labs/hushh-research`
6. environment variables such as `HUSHH_DEVELOPER_TOKEN`
7. package names, bundle IDs, app IDs, native plugin names, class names, logger names, cache dirs, table names, server names, and service names
8. deployed hostnames and URLs
9. message or protocol identifiers such as `hushh:*`, `hushh://...`, `hushh-consent`, and `hushh-mcp`
10. header names such as `X-Hushh-Consent` and `X-Hushh-Client-Version`

When prose needs both the public name and the exact identifier, lead with the public name and map back immediately.

Examples:

- `Hussh uses the repo-level CLI surface exposed as ./bin/hushh.`
- `The Hussh developer lane is implemented today through /api/v1, the hosted MCP endpoint, and @hushh/mcp.`
- `The Hussh mobile shell depends on compatibility identifiers such as HushhVault and HushhConsent in native code and docs examples.`

## Classification Model

Classify remaining `hushh` / `Hushh` occurrences using these buckets:

1. `public-brand prose`
2. `compatibility identifier`
3. `copy-sensitive runtime string`
4. `internal safe rename`
5. `needs manual review`

Default handling:

1. rewrite `public-brand prose` to `Hussh`
2. preserve `compatibility identifier` exactly
3. preserve `copy-sensitive runtime string` unless a dedicated migration or alias plan exists
4. rewrite `internal safe rename` only when the change is clearly non-breaking
5. route ambiguous cases to manual review instead of search-and-replace

## Diagram And Shared-Artifact Rule

Branding and reference hygiene must stay aligned:

1. canonical docs use `Hussh` in headings, captions, and explanatory prose
2. shared artifacts must use shareable GitHub `blob/main` links for canonical references
3. local filesystem paths, `file://` links, and machine-specific absolute paths must not appear in shareable HTML/PDF artifacts
4. diagram labels should use `Hussh` unless they are quoting a literal runtime identifier

## Rebrand Note

The repository was originally documented under the `Hushh` public name. Maintained docs, skills, and workflows now use `Hussh` as the public architecture brand.

Compatibility identifiers are intentionally preserved so the docs stay operationally correct while the broader engineering rebrand remains separate.

## Enforcement

This contract is enforced through:

1. [docs-governance.md](./docs-governance.md)
2. `node scripts/verify-doc-brand.cjs`
3. `node scripts/verify-shareable-links.cjs`

## Related References

1. [documentation-architecture-map.md](./documentation-architecture-map.md)
2. [docs-governance.md](./docs-governance.md)
3. [hussh-rebrand-classification.md](./hussh-rebrand-classification.md)
4. [../architecture/founder-language-matrix.md](../architecture/founder-language-matrix.md)

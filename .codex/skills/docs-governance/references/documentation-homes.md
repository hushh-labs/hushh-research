# Documentation Homes

This repo uses a strict three-home model plus thin root entrypoints and an explicit future-roadmap tier inside root `docs/`.

## Root markdowns

Use root markdowns for:

- repo orientation
- contributor expectations
- thin setup/testing pointers
- policy docs

Do not use root markdowns as detailed source-of-truth specs.

## Root `docs/`

Use `docs/` for:

- cross-cutting architecture
- cross-cutting operations and governance
- quality and design-system contracts
- repo-wide guides
- product vision
- future roadmap and R&D planning

Within root `docs/`, keep these boundaries explicit:

- `docs/vision/` = durable north stars only
- `docs/future/` = planning-only future-state concepts and R&D assessments
- `docs/reference/` = execution-owned cross-cutting contracts

## `consent-protocol/docs/`

Use `consent-protocol/docs/` for:

- backend architecture details
- protocol concepts
- backend reference material
- protocol contributor guidance

Keep it understandable as a standalone backend/protocol surface.

## `hushh-webapp/docs/`

Use `hushh-webapp/docs/` for:

- frontend/native implementation references
- package-local plugin or native behavior docs
- package-specific technical notes that do not belong in cross-cutting root docs

## Consolidation rules

When deciding whether to keep or remove a doc, classify it as one of:

- `canonical`
- `pointer/index`
- `merge into canonical doc`
- `delete`

Default bias:

1. delete stale docs
2. merge duplicated guidance
3. keep package docs local
4. keep root docs thin

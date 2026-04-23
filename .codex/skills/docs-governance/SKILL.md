---
name: docs-governance
description: Use when reorganizing docs, deciding documentation homes, consolidating redundant docs, updating diagrams or doc maps, or changing documentation verification policy in this repo.
---

# Hussh Docs Governance Skill

## Purpose and Trigger

- Primary scope: `docs-governance-intake`
- Trigger on documentation placement, docs-home decisions, consolidation, doc maps, and docs verification policy changes.
- Avoid overlap with `repo-context`, `frontend`, and `repo-operations`.

## Coverage and Ownership

- Role: `owner`
- Owner family: `docs-governance`

Owned repo surfaces:

1. `docs`
2. `consent-protocol/docs`
3. `hushh-webapp/docs`

Non-owned surfaces:

1. `frontend`
2. `backend`
3. `repo-operations`

## Do Use

1. Deciding where maintained docs belong across the three canonical docs homes.
2. Merging, deleting, or downgrading redundant docs and updating inbound links in the same change.
3. Updating docs maps, diagram ownership, or docs verification/governance rules.

## Do Not Use

1. Product implementation work that only happens to mention docs.
2. Broad repo scanning before the correct owner family is known.
3. CI/deploy/branch-protection work that belongs to `repo-operations`.

## Read First

1. `docs/reference/operations/documentation-architecture-map.md`
2. `docs/reference/operations/docs-governance.md`
3. `docs/reference/operations/brand-and-compatibility-contract.md`
4. `.codex/skills/docs-governance/references/documentation-homes.md`
5. `.codex/skills/docs-governance/references/founder-document-cadence.md` when the request is for a founder-facing artifact, technical brief, or PDF

## Workflow

1. Classify each touched doc as canonical, pointer/index, merge into canonical, or delete.
2. Choose the correct docs home before editing content.
3. Keep root docs thin and package-specific docs package-local.
4. Update diagrams, inbound links, and verification references in the same change when a canonical doc changes.
5. For contributor and setup docs, keep one blessed monorepo path and one aligned standalone upstream path; do not let legacy bootstrap instructions coexist.
6. For command docs, verify the documented command against the real CLI or script surface after editing, then rerun docs verification once more from the canonical repo entrypoint.
7. For founder-facing artifacts, follow the cadence of the supplied founder sample; do not introduce glossary cards, `Founder Mapping` sections, brochure-style panel layouts, or defensive opening caveats unless the user explicitly asks for them.
8. Route founder or board-facing shared briefs, architecture PDFs, and paper-style founder artifacts to `founder-brief-curation` after docs-home scope is clear.
9. Keep public prose on the Hussh brand while preserving exact compatibility identifiers such as `./bin/hushh`, `hushh-webapp`, and `@hushh/mcp`.
10. Treat diagram quality and shareable-link hygiene as blocking issues for shared artifacts, not optional polish.

## Handoff Rules

1. If the task starts with broad repo orientation or ambiguous ownership, start with `repo-context`.
2. If the work is primarily frontend structure, use `frontend`.
3. If the work is primarily backend runtime or package behavior, use `backend`.
4. If the work is operational policy rather than docs policy, use `repo-operations`.
5. If the work is primarily contributor-first-run experience or bootstrap contract ownership, use `contributor-onboarding`.
6. If the work is a founder-facing architecture brief or shared PDF artifact, use `founder-brief-curation`.

## Required Checks

```bash
./bin/hushh docs verify
python3 .codex/skills/docs-governance/scripts/doc_inventory.py tier-a
```

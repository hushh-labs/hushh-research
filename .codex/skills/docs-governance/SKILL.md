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
11. Enforce current-state versus future-state wording for the Hussh / One / Kai / Nav / KYC ontology:
    - Hussh is platform, trust model, and infrastructure.
    - One is approved top personal-agent direction unless a checked-in runtime surface proves current implementation.
    - Kai is the current finance specialist, not the platform-level identity.
    - Nav is reserved for privacy, consent, vault, deletion, and scope-review language, not ordinary navigation.
    - KYC is a bounded identity/KYC workflow specialist under One, not a second top-level app or broad email agent.
12. Keep navigation action ids under `route.*` in docs. Treat `nav.*` as valid only for true Nav guardian capabilities or clearly marked future-roadmap prose.
13. Do not introduce celebrity voice references or personal numeric preferences into canonical docs.
14. Normalize founder draft language before promoting it into canonical docs:
    - approved: `Hussh is the platform and trust infrastructure. One is the personal agent.`
    - approved: `One listens, remembers, decides, and acts under consent.`
    - approved: `Kai is the finance specialist One summons.`
    - approved: `Nav is the privacy and consent guardian One summons.`
    - approved: `KYC is the identity workflow specialist One summons.`
    - retired: `Hussh is your personal MCP server and AI agent.`
    - retired: `One has two faces.`
    - retired: `Kai is the One who remembers.`
15. Treat `hu_ssh` and `SSH for humans` as secondary founder metaphors only. Keep `Human Secure Socket Host` as the canonical architecture expansion.
16. Keep strong claims about on-device memory, no platform-controlled recovery, BYO model execution, portable One memory, and user-private action receipts in `docs/future/` until implementation docs and tests prove them.

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

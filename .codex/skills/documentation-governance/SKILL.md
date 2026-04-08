---
name: documentation-governance
description: Use when reorganizing docs, deciding doc placement, merging or deleting redundant docs, updating diagrams or doc maps, or changing documentation verification and governance in this repo. Follow the three-home docs model across root docs, docs/, consent-protocol/docs/, and hushh-webapp/docs/.
---

# Hushh Documentation Governance Skill

Use this skill for documentation structure, placement, consolidation, and authoring workflow.

## Source of truth

Read these first:

1. `docs/reference/operations/documentation-architecture-map.md`
2. `docs/reference/operations/docs-governance.md`
3. `.codex/skills/documentation-governance/references/documentation-homes.md`

Use the helper for inventory work:

```bash
python3 .codex/skills/documentation-governance/scripts/doc_inventory.py inventory
```

## Canonical documentation homes

1. Root markdowns are thin contributor entrypoints only.
2. `docs/` is for cross-cutting repo contracts, guides, operations, quality, and vision.
3. `consent-protocol/docs/` is for backend and protocol-specific docs.
4. `hushh-webapp/docs/` is for frontend/native package-specific docs.
5. Do not duplicate source-of-truth content across those homes; link instead.

## Placement rules

1. Put first-run setup in `docs/guides/getting-started.md`, not in root docs or package docs.
2. Keep `README.md`, `getting_started.md`, `contributing.md`, and `TESTING.md` thin.
3. Keep backend setup/orientation in `consent-protocol/README.md`; keep `consent-protocol/docs/README.md` as a package docs index.
4. Keep package-local implementation details in package docs, not in cross-cutting root `docs/`.
5. If a doc is mostly navigation, make it a short index or pointer instead of a second spec.

## Diagram rules

1. Tier A docs must include `## Visual Map` or `## Visual Context`.
2. Canonical indexes and architecture/map owners always need diagrams.
3. One-off maintenance notes do not need diagrams.

## Consolidation rules

1. Hard-delete stale or redundant docs when the canonical replacement exists.
2. Merge duplicated guidance into the canonical doc instead of keeping parallel copies.
3. Update all inbound links in the same change.
4. Tighten verification in the same PR when the docs contract changes.

## Required checks

```bash
node scripts/verify-doc-links.cjs
node scripts/verify-doc-governance.cjs
python3 .codex/skills/documentation-governance/scripts/doc_inventory.py tier-a
```

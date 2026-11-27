---
name: docs-governance
description: Use when reorganizing docs, deciding documentation homes, consolidating redundant docs, updating diagrams or doc maps, or changing documentation verification policy in this repo.
---

# Documentation governance

## Purpose and Trigger

- Primary scope: `docs-governance-intake`
- Trigger on documentation structure, canonical homes, brand visual assets, `llms.txt` discovery, consolidation, stale-plan retirement, and verification.
- Avoid overlap with `repo-context`, `frontend`, `backend`, and `repo-operations`.
Use the [authoring contract](../../../docs/development/documentation.md) for policy;
use this skill to execute the change.

## Coverage and Ownership

- Role: `owner`
- Owner family: `docs-governance`

Owned repo surfaces:

1. `docs`
2. `llms.txt`
3. `consent-protocol/docs`
4. `hushh-webapp/docs`

Non-owned surfaces:

1. `frontend`
2. `backend`
3. `repo-operations`
4. `contributor-onboarding`

## Do Use

1. Moving, consolidating, modularizing oversized specs, or retiring superseded plans and repairing their consumers.
2. Reconciling source truth, dark/light brand hero banners, layered Mermaid diagrams, and `Live` / `Preview` / `Proposed` status claims.
3. Updating documentation navigation, `llms.txt` machine discovery, Hybrid Tiered human-first layouts, and verification tools.

## Do Not Use

1. Product implementation merely because documentation accompanies it.
2. Release-policy or deployment changes owned by repo-operations.
3. Broad orientation before the owning surface is known; begin with repo-context.

## Read First

1. `docs/README.md`
2. `docs/development/documentation.md`
3. `docs/architecture/README.md`
4. `docs/operations/brand-and-compatibility-contract.md`
5. `llms.txt`

## Workflow

1. Inventory first-party Markdown and inspect runtime, generator, `llms.txt`, and package consumers.
2. Classify current guides, technical contracts, active proposals, active peer work, superseded plans, and imported/generated/legal/runtime assets before changing them.
3. Apply the **Hybrid Tiered** layout: open with a crisp, jargon-free Human Hero (purpose, maturity status, visual diagram, boundaries, and journey), and isolate coding-agent invariants, seams, and commands into a separated bottom section or collapsible drawer. Never use em or en dashes.
4. Choose the canonical Product, Architecture, Development, Operations, or Roadmap home with explicit Diataxis intent. Keep human overview pages concise (~150 to 300 lines) and split oversized reference monoliths into modular contracts. Keep root `AGENTS.md` lean and `llms.txt` synchronized.
5. Verify substantive claims against current source. One is the implemented root private agent; Kai is its finance specialist. Distinguish `Live`, `Preview`, and `Proposed` truthfully; never turn source evidence into deployment or installed-owner acceptance.
6. Apply **Zero-Archive Distillation**: reconcile unique durable facts into their canonical owner before deleting superseded historical plans outright, relying on Git history for prior versions.
7. Move links, anchors, dark/light SVG heroes, manifests, `llms.txt`, inventories, and generators in the same PR. Required package assets and runtime Markdown retain their existing contracts.
8. Verify every changed Mermaid diagram structurally (declared nodes, trust-boundary subgraphs, zero broken HTML labels) and verify both positive and negative controls when touching verifiers.
9. Run affected checks, keep audit evidence ignored, and release through repo-operations. Docs-only PRs across `dev`, `uat`, and `main` must preserve environment truthfulness without pulling unpromoted runtime code.

## Handoff Rules

Route implementation to frontend/backend owners, release operations to repo-operations,
and explicitly requested executive artifacts to founder-brief-curation. Ordinary
product documentation leads with human clarity and separates coding-agent detail cleanly.
Preserve literal compatibility identifiers and the approved Hussh personal-agent identity.

## Required Checks

```bash
./bin/hushh docs verify
python3 scripts/licenses/verify_apache_surface.py
python3 .agents/skills/docs-governance/scripts/doc_inventory.py inventory
python3 .agents/skills/docs-governance/scripts/doc_inventory.py stale-candidates
python3 .agents/skills/docs-governance/scripts/doc_inventory.py folders
python3 .agents/skills/skill-authoring/scripts/skill_lint.py
```

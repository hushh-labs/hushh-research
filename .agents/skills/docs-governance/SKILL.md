---
name: docs-governance
description: Use when reorganizing docs, deciding documentation homes, consolidating redundant docs, updating diagrams or doc maps, or changing documentation verification policy in this repo.
---

# Documentation governance

## Purpose and Trigger

- Primary scope: `docs-governance-intake`
- Trigger on documentation structure, canonical homes, consolidation and verification.
- Avoid overlap with `repo-context`, `frontend`, `backend`, and `repo-operations`.
Use the [authoring contract](../../../docs/development/documentation.md) for policy;
use this skill to execute the change.

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
4. `contributor-onboarding`

## Do Use

1. Moving, consolidating or retiring documentation and repairing its consumers.
2. Reconciling source truth, module diagrams and current versus future claims.
3. Updating documentation navigation and its existing verification tools.

## Do Not Use

1. Product implementation merely because documentation accompanies it.
2. Release-policy or deployment changes owned by repo-operations.
3. Broad orientation before the owning surface is known; begin with repo-context.

## Read First

1. `docs/README.md`
2. `docs/development/documentation.md`
3. `docs/architecture/README.md`
4. `docs/operations/brand-and-compatibility-contract.md`

## Workflow

1. Inventory first-party Markdown and inspect runtime, generator and package consumers.
2. Classify current guides, technical contracts, future designs, active peer work,
   history, and imported/generated/legal/runtime assets before changing them.
3. Choose the canonical Product, Architecture, Development, Operations or Roadmap
   home. Keep standalone package references local and root entrypoints useful.
4. Verify substantive claims against current source. One is the implemented root
   private agent; Kai is its finance specialist. Do not turn source evidence into
   deployment or installed-owner acceptance. Current chat Markdown remains in PKM.
5. Lead with purpose and behavior. Retain exact commands and identifiers where
   readers need them for implementation, custody, recovery or provenance.
6. Reconcile unique durable facts before retirement. Preserve active peer work and
   unresolved recovery facts. Use Git history for prior versions, not duplicate trees.
7. Move links, anchors, images, manifests, inventories and generators together.
   Required package assets and runtime Markdown retain their existing contracts.
8. Review navigation and source truth independently for cross-system migrations.
   Render changed diagrams and verify both valid and broken-link behavior.
9. Run affected checks, keep audit evidence ignored, and release through repo-operations.
   Source-only downstream syncs preserve branch content and never deploy.

## Handoff Rules

Route implementation to frontend/backend owners, release operations to repo-operations,
and explicitly requested executive artifacts to founder-brief-curation. Ordinary
product documentation has no default Founder/CTO audience. Preserve literal
compatibility identifiers and the approved Hussh personal-agent identity.

## Required Checks

```bash
./bin/hushh docs verify
python3 .agents/skills/docs-governance/scripts/doc_inventory.py inventory
python3 .agents/skills/docs-governance/scripts/doc_inventory.py stale-candidates
python3 .agents/skills/docs-governance/scripts/doc_inventory.py folders
```

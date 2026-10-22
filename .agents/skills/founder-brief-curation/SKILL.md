---
name: founder-brief-curation
description: Use when drafting or polishing founder-facing architecture briefs, presentation-grade markdown/html/pdf artifacts, generic report PDFs, Drive/shareable artifacts, or paper-style technical specs that must stay grounded in repo truth.
---

# Founder Brief Curation Skill

## Purpose and Trigger

- Primary scope: `founder-brief-curation-intake`
- Trigger on founder or board-facing technical briefs, architecture PDFs, generic Markdown/HTML/PDF report artifacts, Drive/shareable packet generation, diagram curation, and paper-style specs that need repo truth plus presentation polish.
- Avoid overlap with `repo-context`, broad `docs-governance` intake, and subsystem implementation skills.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `docs-governance`

Owned repo surfaces:

1. `.agents/skills/founder-brief-curation`

Non-owned surfaces:

1. `docs-governance`
2. `repo-context`
3. `frontend`
4. `backend`

## Do Use

1. Drafting founder-facing architecture briefs from checked-in docs and implementation contracts.
2. Converting markdown drafts into presentation-grade HTML/PDF artifacts.
3. Rendering generic report PDFs from repo Markdown when no narrower report skill owns the artifact.
4. Curating diagrams and shareable artifact rhythm without overstating unbuilt systems.

## Do Not Use

1. Canonical docs-home placement decisions.
2. Broad repo orientation when the right docs or subsystem are unknown.
3. Product implementation, API changes, marketing copy, or investor pitch decks.

## Read First

1. `.agents/skills/founder-brief-curation/references/brief-curation-rules.md`
2. `.agents/skills/founder-brief-curation/references/founder-brief-kernel.md`
3. `.agents/skills/founder-brief-curation/references/pdf-artifact-generation.md`
4. `.agents/skills/founder-brief-curation/references/world-class-artifact-standard.md`
5. `.agents/skills/founder-brief-curation/references/architecture-diagram-standard.md`
6. `.agents/skills/docs-governance/references/founder-document-cadence.md`
7. `docs/reference/operations/documentation-architecture-map.md`

## Workflow

1. Establish the audience and decision, then start from repo truth.
2. Use the Founder Wiki North-Star Probe for material product thesis, founder language, One/Kai/Nav ontology, PCHP/BYOA/on-device posture, or future-state alignment.
3. Bind implementation to source and live claims to dated runtime evidence; use founder wiki canon for direction. Divergence is `current_state_vs_north_star_drift`.
4. Keep private wiki evidence local-only unless the user asks for an internal private artifact.
5. Use `brief-curation-rules.md` and `founder-brief-kernel.md` for audience, narrative, diagrams and material limitations.
6. For generic Markdown-to-PDF rendering, use `pdf-artifact-generation.md` before trying ad hoc shell, npm, or OS conversion tools.
7. For a founder/organisation-facing HTML artifact, follow `world-class-artifact-standard.md` for the requested audience and theme, real brand, source tokens and headless visual verification.
8. Apply `architecture-diagram-standard.md` whenever the artifact contains a system, sequence, deployment, or information-boundary view.
9. Render and inspect actual PDFs before calling them shareable.

## Handoff Rules

1. Docs-home uncertainty routes to `docs-governance`.
2. Broad repo scanning starts with `repo-context`.
3. HTML/CSS/layout implementation routes to `frontend`.
4. Subsystem truth tightening routes to the relevant backend, IAM, MCP, or One Voice owner.

## Required Checks

```bash
python3 scripts/ops/verify_pdf_artifact_contract.py
./bin/hushh docs verify
python3 .agents/skills/docs-governance/scripts/doc_inventory.py tier-a
```

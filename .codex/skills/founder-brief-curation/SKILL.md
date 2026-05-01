---
name: founder-brief-curation
description: Use when drafting or polishing founder-facing architecture briefs, presentation-grade markdown/html/pdf artifacts, or paper-style technical specs that must stay grounded in repo truth.
---

# Founder Brief Curation Skill

## Purpose and Trigger

- Primary scope: `founder-brief-curation-intake`
- Trigger on founder or board-facing technical briefs, architecture PDFs, founder-style markdown/html artifacts, diagram curation for shared documents, and paper-style specs that need repo-backed truth plus presentation polish.
- Avoid overlap with `repo-context`, broad `docs-governance` intake, and subsystem implementation skills.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `docs-governance`

Owned repo surfaces:

1. `.codex/skills/founder-brief-curation`

Non-owned surfaces:

1. `docs-governance`
2. `repo-context`
3. `frontend`
4. `backend`

## Do Use

1. Drafting a founder-facing architecture brief from checked-in docs and implementation contracts.
2. Converting a markdown draft into a presentation-grade HTML/PDF artifact.
3. Curating architecture diagrams so labels fit, geometry stays symmetric, and the rendered PDF can be shared without caveats.
4. Reframing current-state platform truth into founder cadence without overstating unbuilt systems.

## Do Not Use

1. Canonical docs-home placement decisions that belong to `docs-governance`.
2. Broad repo orientation when the right docs or subsystem are not known yet.
3. Product implementation or API changes that happen to be adjacent to the brief.
4. Marketing copy, investor pitch decks, or community replies that are not repo-backed technical documents.

## Read First

1. `.codex/skills/founder-brief-curation/references/brief-curation-rules.md`
2. `.codex/skills/docs-governance/references/founder-document-cadence.md`
3. `docs/reference/operations/documentation-architecture-map.md`
4. `docs/reference/operations/brand-and-compatibility-contract.md`

## Workflow

1. Start from repo truth, not from prior pitch copy. Read the current architecture docs and implementation-contract docs that actually support the brief.
2. Build the narrative in founder cadence: platform thesis first, runtime and trust boundary second, present-state honesty later.
3. Expand every shortform on first use unless it is universally obvious in a first-read document.
4. Keep shared artifacts free of internal build commentary such as drafting provenance, prompt notes, or repo-process explanations.
5. Use a small coherent figure system. Prefer a few premium diagrams over many local boxes.
6. If a diagram label is tight, enlarge the box or rebalance the grid before shrinking the text too far.
7. Control page rhythm deliberately. Major section titles must either start on a fresh page with body that follows cleanly, or use an intentional title-divider page. Never let a new chapter title dangle under a preceding figure.
8. If a title-divider page is used, keep the title page clean and force the following body to the next page.
9. If the document is built around a layered platform model, add the cross-layer pointers or governing laws explicitly after the layer definition.
10. Keep heading treatment consistent across sections unless the user explicitly asks for a different chapter system.
11. For HTML-sourced PDFs, use measured page math when necessary to avoid oversized gaps, orphan headings, or brittle one-off page-start hacks.
12. Render the actual PDF and inspect rendered pages, not just source HTML. If needed, export the PDF pages to images and verify the diagram pages and chapter transitions directly.
13. Keep references hyperlinked and useful, but move source-detail inventory to the references section rather than the narrative body.
14. State what is not implemented only in a dedicated honesty section; do not open with defensive caveats.
15. Preserve founder cadence while normalizing the Hussh / One / Kai / Nav ontology:
    - Hussh is the platform and trust infrastructure.
    - One is the personal agent and relationship layer.
    - Kai is the finance specialist.
    - Nav is the privacy and consent guardian.
16. Do not promote stale founder-draft phrases such as `Hussh is your personal MCP server and AI agent`, `One has two faces`, or `Kai is the One who remembers` into shared artifacts unless quoting them as source material being corrected.
17. Treat `hu_ssh`, `SSH for humans`, and `Ask. Approve. Audit.` as founder-facing metaphors that must map back to Human Secure Socket Host and the current Consent Protocol.
18. Keep claims about on-device memory, no platform-controlled recovery, BYO model execution, portable One memory, and user-private receipts future-state unless repo truth proves them.

## Handoff Rules

1. If the docs home or canonical reference set is unclear, start with `docs-governance`.
2. If the task begins with broad repo scanning, use `repo-context` first.
3. Hand off to `frontend` when the work becomes primarily HTML/CSS/layout implementation beyond artifact curation.
4. Hand off to `backend`, `iam-consent-governance`, `mcp-developer-surface`, or `kai-voice-governance` when the brief needs subsystem truth tightened at the source.

## Required Checks

```bash
./bin/hushh docs verify
python3 .codex/skills/docs-governance/scripts/doc_inventory.py tier-a
```

# Documentation Recursive Knowledge Model

## Visual Context

Canonical visual owner: [Documentation Architecture Map](./documentation-architecture-map.md). This page defines the recursive rewrite contract under that map.

## Purpose

Hussh docs should read as one knowledge system, not as accumulated plans. Every folder owns a clear layer of truth, every index explains the local map, and every long document must justify why it remains monolithic.

The north-star filter is:

1. Hussh is the platform and trust infrastructure.
2. One is the private relationship layer.
3. Kai is the finance specialist One summons.
4. Nav is the privacy and consent guardian direction.
5. PCHP is the consent, scoped export, and audit boundary.
6. Current implementation truth must be backed by checked-in code, generated contracts, docs, and tests.
7. Future or wiki direction can shape language, but it cannot be claimed as shipped behavior without repo evidence.

## Recursive Folder Contract

Each maintained docs folder must answer five questions in its local `README.md` or nearest parent index:

| Question | Required answer |
| --- | --- |
| What truth does this folder own? | One sentence of ownership. |
| What does it not own? | Adjacent folders to link instead of duplicate. |
| Which docs are canonical? | Short list of stable source-of-truth pages. |
| Which docs are operational guides? | Short list of task-oriented guides. |
| Which docs are future or archive only? | Explicit status and promotion rule. |

## Granularity Rules

Use a folder when a subtopic has its own lifecycle, owner, or recurring workflow. Use a single page when the content is short and read as one contract.

Split or rewrite a document when any of these are true:

1. It exceeds 500 lines and contains more than one lifecycle.
2. It mixes current implementation truth with future roadmap.
3. It mixes operator steps, architecture, verification, and product positioning.
4. It duplicates a canonical reference elsewhere.
5. Its title says "plan", "audit", "test plan", or "migration" but readers treat it as current truth.

Do not split a document just because it is long if the topic is genuinely one contract and already has strong navigation.

## Folder Types

| Folder | Role | Rewrite bias |
| --- | --- | --- |
| root markdown | thin contributor entrypoints | shorten and link downward |
| `docs/guides/` | task-oriented workflows | split by workflow phase |
| `docs/reference/` | current execution contracts | keep precise, evidence-backed, and bounded |
| `docs/vision/` | durable north stars | remove implementation detail |
| `docs/future/` | roadmap and R&D plans | keep explicit status and promotion rule |
| `docs/superpowers/` | active agentic plan/spec snapshots only | delete completed artifacts after promotion |
| `consent-protocol/docs/` | backend/package truth | keep package-local |
| `hushh-webapp/docs/` | frontend/native package truth | keep package-local |
| `.codex/skills/` and `.codex/workflows/` | agent operating system | keep procedural, compact, and linked to docs |

## Rewrite Sequence

For every recursive pass:

1. Run `python3 .codex/skills/docs-governance/scripts/doc_inventory.py folders`.
2. Run `python3 .codex/skills/docs-governance/scripts/doc_inventory.py stale-candidates`.
3. Pick the highest-risk folder or document from evidence, not intuition.
4. Merge durable facts into the canonical owner.
5. Replace bloated pages with a short entrypoint and child pages only when a bounded subtopic exists.
6. Delete superseded pages after the link sweep is clean.
7. Run docs verification and skill lint before claiming completion.

## Current Recursive Findings

As of this pass, the proven oversized guide candidates are:

- `docs/guides/mobile.md`
- `docs/guides/one-location-uat-test-plan.md`

Both should become stable entrypoints with phase-specific child pages. This keeps the contributor path readable while preserving mobile parity and One Location UAT detail where it belongs.

## Verification

```bash
python3 .codex/skills/docs-governance/scripts/doc_inventory.py folders
python3 .codex/skills/docs-governance/scripts/doc_inventory.py stale-candidates
./bin/hushh docs verify
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
git diff --check
```

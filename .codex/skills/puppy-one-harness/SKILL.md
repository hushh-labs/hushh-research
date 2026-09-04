---
name: puppy-one-harness
description: Use when running, grading, or extending the on-device model harness for Puppy One, including the review-queue judge handoff, capability probing, and the evolution ledger.
---

# Puppy One Harness Skill

## Purpose and Trigger

- Primary scope: `puppy-one-harness`
- Trigger on benchmarking a local model, grading its output, adding a model to
  the ladder, or reading the evolution ledger.
- Avoid overlap with `quality-contracts` and `backend-agents-operons`.

The harness answers two different questions and must never conflate them. The
benchmark asks *well-formed and fast*; the judge asks *correct*. A model can emit
a perfectly shaped `save_to_pkm` call that files a dietary restriction under
`finance.accounts`, and the shape check passes it.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `backend`

Owned repo surfaces:

1. `.codex/agents/local_model_judge.toml`
2. `.codex/skills/puppy-one-harness/references/judging-contract.md`

Non-owned surfaces:

1. `consent-protocol`
2. `hushh-webapp`
3. `backend`

## Do Use

1. Running the benchmark or the judge over a local model.
2. Grading a review queue, or reviewing someone else's verdicts.
3. Adding a model to the ladder, or reading the ledger for a trend.
4. Grading the device's real daily jobs (the cron quality suite, see
   `.codex/skills/puppy-one-harness/references/cron-quality-suite.md`).

## Do Not Use

1. Changing the PKM write path or the vault (`vault-pkm-governance`).
2. Provider routing or the on-device gate itself (`backend-runtime-governance`).
3. Frontend surfaces for Puppy One (`frontend-surface-placement`).

## Read First

1. `.codex/skills/puppy-one-harness/references/judging-contract.md`
2. `.codex/agents/local_model_judge.toml`

## Workflow

1. Collect outputs from the local model, then write a review queue. Controls are
   planted, shuffled per run, and unmarked; their answers live in the manifest.
2. Grade in a session that did **not** write the queue. This cannot be enforced
   from a script, so it is a discipline the report states rather than assumes.
3. Never open `run-manifest.json` while grading. It holds the control positions,
   and reading it destroys the only property that makes a pass meaningful.
4. Every `wrong` verdict cites the offending value verbatim. Ingest checks the
   citation against the output and discards it if absent, because an uncited
   failure is indistinguishable from a hallucinated one.
5. Grade every row. Ungraded rows void the run: skipping the hard ones would
   raise accuracy for free.
6. Ingest, then append to the ledger. Record void runs too — dropping them makes
   the ledger an unbroken record of successes.
7. Before comparing two runs, check the capability profile. A model tested via
   tool calling and one tested via JSON mode were not asked the same question.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `backend`.
2. If the finding is a provider-routing or gate issue, use
   `backend-runtime-governance`.
3. If it touches the vault or the PKM write path, use `vault-pkm-governance`.

## Required Checks

```bash
python3 .codex/skills/agent-orchestration-governance/scripts/agent_orchestration_check.py
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
```

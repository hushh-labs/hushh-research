# PKM Structure Agent Live Eval


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This benchmark is temporary evaluation infrastructure for the PKM structure path.

It inherits the methodological rules in `./pkm-agent-north-star.md`.

## Purpose

- harden the PKM structure agent using live Gemini calls only
- keep preview-only behavior
- prevent vague fallback domains from masking weak classification
- measure whether smaller models stay inside the same structured contract

## Contract

The preview path is an ADK/A2A-style pipeline:

1. `Financial Guard Agent`
   - decides `financial_core` vs sanctioned financial memory vs non-financial
   - prevents finance-sensitive prompts from drifting into casual PKM structure

2. `Memory Intent Agent`
   - returns `IntentFrame`
   - decides durable vs ephemeral vs ambiguous
   - classifies ontology intent
   - decides mutation intent
   - returns broad candidate domains

3. `PKM Structure Agent`
   - returns `PKMStructurePreview`
   - chooses the target domain
   - emits candidate payload
   - emits structure decision and scope plan

Deterministic validation runs after the model and can downgrade output to `confirm_first` or `do_not_save`.

## Ontology

The intent ontology is fixed:

- `preference`
- `profile_fact`
- `routine`
- `task_or_reminder`
- `plan_or_goal`
- `relationship`
- `health`
- `travel`
- `shopping_need`
- `financial_event`
- `correction`
- `deletion`
- `note`
- `ambiguous`

## No `general` Policy

`general` is not a valid success-state domain for benchmark scoring.

- if the model proposes `general`, validation downgrades it to an unresolved decision
- unresolved decisions must become `confirm_first`
- confirmation choices must use broad top-level domains from the domain registry

## Phase Ladder

- `fresh_random_120`
  - `120` all-new single-turn prompts
  - no exact reuse of the earlier sanity strings
- `fresh_chain_60`
  - `60` chained prompts for one evolving PKM
- `fresh_chain_120`
  - `120` chained prompts for one richer evolving PKM

## Live Model Policy

Current live eval mode:

- model: `gemini-3.1-flash-lite-preview`
- posture: minimal-thinking / strict-small-model

Promotion discipline:

- keep the classifier on the lowest-latency posture first
- do not hide weak prompt behavior behind heavier reasoning modes

The benchmark always calls live models. It may cache only:

- domain registry snapshot
- synthetic persona state
- shadow baseline reconstruction
- prompt corpus and scoring config

It must not cache prior model outputs across runs.

The benchmark should recommend the current single-model minimal posture only if it stays inside the acceptance gates.

## KPI Definitions

- `save_class_ok_rate`
- `intent_ok_rate`
- `mutation_ok_rate`
- `domain_ok_rate`
- `confirmation_ok_rate`
- `fallback_rate`
- `finance_contamination_count`
- `unresolved_domain_count`
- `fragmentation_score`
- `average_latency_ms`
- `p95_latency_ms`
- `timeout_count`

`fragmentation_score` is the ratio of unique actual durable domains to unique expected domains for the run. Lower is better.

## Promotion Gates

Move from `fresh_random_120` to deeper runs only when:

- schema validity is stable
- `general` no longer appears as a success-state domain
- finance prompts resolve to the governed financial lane or sanctioned financial memory
- corrections and deletions stop over-confirming
- fallback rate stays at or near zero

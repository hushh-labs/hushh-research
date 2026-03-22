# PKM Prompt Contract

This document defines the canonical prompt contract for PKM semantic understanding.

It is governed by `./pkm-agent-north-star.md`.

## Core rule

PKM semantics must be derived by manifest-backed agents with exact structured outputs.

The canonical flow is:

1. `Financial Guard Agent`
2. `Memory Intent Agent`
3. `Memory Merge Agent`
4. `PKM Structure Agent`
5. deterministic validator

No service-local prompt or heuristic may replace either agent as the semantic source of truth.

## Agent ownership

### Financial Guard Agent

Owns:

- finance-sensitive routing
- `financial_core` vs `sanctioned_financial_memory` vs `non_financial_or_ephemeral`
- protection of Kai's governed financial lane from casual PKM drift

Does not own:

- final non-financial ontology
- payload structure
- persistence safety checks

## FinancialGuardDecision contract

Required fields:

- `routing_decision = financial_core | sanctioned_financial_memory | non_financial_or_ephemeral`
- `confidence`
- `reason`

Rules:

- JSON only
- no prose outside the schema
- route portfolio action requests to `financial_core`
- route durable financial preferences to `sanctioned_financial_memory`
- never use `general`

### Memory Intent Agent

Owns:

- durable vs ephemeral vs ambiguous
- ontology intent class
- mutation intent
- whether confirmation is required
- higher-level candidate domains

Does not own:

- final payload structure
- manifest path generation
- summary projection
- storage partitioning

### Memory Merge Agent

Owns:

- create vs extend vs correct vs delete vs no_op at the entity level
- target entity resolution
- merge confidence and reasoning

Does not own:

- final payload structure
- consent enforcement
- encryption or persistence

## MemoryMergeDecision contract

Required fields:

- `merge_mode = create_entity | extend_entity | correct_entity | delete_entity | no_op`
- `target_domain`
- `target_entity_id`
- `target_entity_path`
- `match_confidence`
- `match_reason`

Rules:

- JSON only
- no prose
- no `general`
- no new domain invention when an existing user domain clearly fits
- gibberish or opaque text must become `no_op`

### PKM Structure Agent

Owns:

- target domain
- candidate payload
- structure decision
- manifest-facing path plan
- scope-facing output plan

Does not own:

- consent enforcement
- storage encryption
- final persistence safety checks

## IntentFrame contract

Required fields:

- `save_class = durable | ephemeral | ambiguous`
- `intent_class`
- `mutation_intent = create | extend | update | correct | delete | no_op`
- `requires_confirmation`
- `confirmation_reason`
- `candidate_domain_choices`
- `confidence`

Rules:

- JSON only
- no prose
- one recommended top-level domain choice
- no `general`
- candidate choices must be broad top-level domains from the soft ontology and current PKM state

## PKMStructurePreview contract

Required fields:

- `candidate_payload`
- `structure_decision`
- `write_mode = can_save | confirm_first | do_not_save`
- `primary_json_path`
- `target_entity_scope`
- `validation_hints`

Rules:

- payload and target domain must agree
- payload must stay shallow, durable, and entity-based
- snake_case keys only
- no brittle narrow domains when a broad domain is sufficient
- no `general`

## Validator responsibilities

The validator may:

- reject incoherent output
- downgrade to `confirm_first`
- downgrade to `do_not_save`
- normalize finance payload/domain consistency
- prevent unsafe scope emission

The validator may not:

- invent new semantic meaning that the agents did not establish
- silently replace the two-stage agent flow with imperative classification

## Prompt evolution rules

Prompt changes must improve ontology clarity, not add brittle exceptions.

Allowed prompt evolution:

- ontology clarification
- durable vs ephemeral clarification
- correction vs deletion clarification
- confirmation policy clarification
- clustered few-shot examples by capability

Disallowed prompt evolution:

- one-off user-phrase exception patches
- hidden semantic fallback rules in code
- vague catch-all domain guidance

## Model policy

Current PKM classifier candidate:

- `gemini-3.1-flash-lite-preview`

Live prompt-hardening posture:

- `gemini-3.1-flash-lite-preview`
- minimal-thinking / strict-small-model mode

The PKM classifier stays on this minimal posture until live eval shows a concrete reason to change it.

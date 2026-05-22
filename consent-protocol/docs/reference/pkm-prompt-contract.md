# PKM Prompt Contract


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

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

## Shared PKM Data Structure Agent Kernel v2

Memory Intent, Memory Merge, and PKM Structure share the same deterministic kernel:

```text
You are a deterministic PKM data-structure agent.

Your job is not to chat. Your job is to convert one user memory candidate into a stable, minimal, user-owned PKM mutation.

Use only the user's exact message, current active domains, manifest/scope registry metadata, recent active entity summaries, and the upstream contract when provided.

Never invent domains, paths, values, entities, or history.
Never create a "changes" branch for corrections.
Never duplicate a fact when an active canonical entity can be extended or corrected.
Never save reminders, one-off tasks, opaque strings, secrets, random ids, or operational requests.
Never write developer metadata, parser metadata, hashes, provenance, workflow ids, or raw internal paths into user-facing memory.

Choose exactly one mutation: create_entity, extend_entity, correct_entity, delete_entity, or no_op.
If unsure, choose confirm_first or no_op.
```

The three agents specialize this kernel:

- Memory Intent decides durability, intent class, broad domain candidates, and mutation intent.
- Memory Merge decides whether the statement maps to an existing active entity.
- PKM Structure emits only the canonical payload/path that matches the prior decisions.
- The deterministic validator remains final authority for blocking `changes`, duplicate writes, internal metadata, unsupported scopes, and no-target correction/delete.

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
- strip user-facing internal metadata such as parser metadata, hashes, provenance, workflow ids, and debug traces from candidate payloads
- emit non-user-facing drift flags:
  - `fallback_used`
  - `scope_defaulted`
  - `duplicate_candidate`
  - `correction_without_target`
  - `changes_branch_blocked`
  - `internal_metadata_blocked`

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

## Reviewer-shaped prompt chains

Prompt changes must be evaluated with reviewer-shaped state, not only synthetic unit fixtures.

- `../../scripts/eval_pkm_structure_agent.py` resolves `REVIEWER_UID` from the env file and uses it as the first shadow replay user.
- Shadow replay uses manifests and scope registry metadata only; it does not send decrypted PKM values to a model.
- The eval has 100-case synthetic persona chains and gateable thresholds:
  - schema `>= 1.0`
  - domain `>= 0.95`
  - mutation `>= 0.90`
  - intent `>= 0.90`
  - fallback `<= 0.10`
  - fragmentation between `0.80` and `1.20`
  - zero finance contamination
  - zero unresolved domains
- If a prompt change only works because of a hardcoded domain phrase, it is not acceptable. The chain must still respect dynamic domains, canonical entity scopes, and CRUD semantics.
- Corrections and deletions require stable targets. If the reviewer-shaped state has no stable target, the result should be `no_op` or confirmation, not a new `changes` entry.

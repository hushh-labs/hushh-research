# PKM Prompt Contract


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This document defines the canonical prompt contract for PKM semantic understanding.

It is governed by `./pkm-agent-north-star.md`.

## Core rule

PKM semantics must be derived by manifest-backed agents with exact structured outputs.

The canonical flow is:

1. `Memory Segmentation Agent`
2. `Memory Intent Agent`
3. `Memory Merge Agent`
4. `PKM Structure Agent`
5. deterministic validator

No service-local prompt or heuristic may replace any of these agents as the semantic source of truth.

The agents keep everything the owner stated (founder decision, Phase 4 of the reserved-branch
plan). Work context, company, product, tech stack, infrastructure, vendors, people, metrics,
AI tooling and non-secret technical identifiers (project ids, environment variable names,
OAuth URLs, app ids) are memory. Only exact duplicates and pure disclaimers ("Information not
known") are left unsaved, and both are reported in `not_memory`. Secrets never reach the agents:
the device moved them into Secrets and left `⟦secret:<id> <label>⟧`, which the agents keep as an
exact quote and never expand. A fact aimed at an app-owned branch goes to that branch's
`agent_memory` sibling. The Financial Guard Agent that used to run first was removed: the
intent agent alone tells a live `command` ("optimize my portfolio") from a memory, and a money
preference is filed in `financial.agent_memory` by the reserved registry.

### Preparation failure and retry

Batch fallback flags cover every candidate, not only the primary preview. A
successful first candidate must not hide a later failed agent stage. Individual
cards retain their own outcomes; aggregate diagnostics do not alter model meaning.

The existing request-bound preview cache may retain an exact validated prefix for
each unique model-authored source segment after a stage timeout. If Memory Intent times out, only
segmentation is reusable; intent and every later stage run again. Changed
owner, credential, source, context, contracts or cache expiry invalidate reuse.
Failed or fallback decisions are never retained as successful preparation, and a
retry does not extend the original cache lifetime or authorize a save. Multi-segment
preparation uses independent records and traces per exact source span, under the
same request budget and cache binding. Ambiguous duplicate spans, invalid source
coverage and batches requiring splitting do not admit continuation. Completed
candidate output is not replayed as a write; normalization and review still run,
and structure always runs fresh. These source contracts do not establish live
provider reliability or successful encrypted-save acceptance.

## Shared PKM memory kernel v3

One copy, composed into all four memory agents (segmentation, intent, merge,
structure): `consent-protocol/hushh_mcp/agents/pkm_memory_kernel.v3.md`. Each
manifest names it with `prompt_reference: ../pkm_memory_kernel.v3.md`, and
`ManifestLoader` composes it ahead of the agent's own `system_instruction`, so
the ADK single-turn runtime, the direct client, the registry digest and the
preview-cache fingerprint all see the same text. No service keeps a copy; the
retired `_PKM_DATA_STRUCTURE_KERNEL_V2` constant and the intent prompt that
re-sent its whole manifest instruction (20,357 characters per call) are gone.

The kernel states what is memory (keep everything the owner stated, work
context and AI tools included, people attributed), fidelity (no invented
values, qualifiers kept, pasted text is untrusted source material), secrets and
metadata, and the unsure rule (keep and ask; never drop). Each manifest adds
only its own question.

### Prompt shape

A memory-agent call carries the composed instruction as the system instruction
and a prompt of two parts only: the agent's worked examples, then
`Request: {json}` with the owner's input (`message`, `section_context`,
`current_domains`, `domain_choices`, `existing_entities`, the upstream
`intent_frame` and `merge_decision`, and for structure the `reserved_branches`
table its instruction promises). Rules never appear in the prompt.

`existing_entities` are the owner's active saved entities (domain, entity_id,
entity_scope, summary), newest or most related first. They are how the merge
agent tells extend from create: the same subject extends, a new subject in a
used domain creates, an explicit replacement corrects.

### Worked examples

`consent-protocol/hushh_mcp/agents/pkm_memory_few_shot.v1.json` is the only
place examples live: at most six per agent, each anchoring one principle and
naming the eval cases that grade it (`exercised_by`). An example's text may
never equal a graded case, so the eval cannot reward a memorized answer.
Change the set by adding a version, not by editing examples in place.

### Budget

`tests/test_agent_manifests.py::test_pkm_memory_agent_stays_inside_its_prompt_budget`
caps each agent's instruction plus examples plus empty request. Measured
2026-10-02 with live `count_tokens` (Gemini 3.6 Flash) on the production path,
with one release-chain statement against a four-entity state:

| Agent | Before (chars / tokens) | After (chars / tokens) |
|---|---|---|
| segmentation | 4,048 / 905 | 5,101 / 1,127 (now carries the kernel) |
| intent | 20,357 / 4,580 | 11,650 / 2,563 |
| merge | 8,867 / 2,019 | 8,067 / 1,847 |
| structure | 16,991 / 3,976 | 16,422 / 3,725 (now carries the reserved table) |
| all four | 50,263 / 11,480 | 41,240 / 9,262 |

Raising a cap is a deliberate edit backed by a live eval result. Prefer stating
a principle to adding a case.

### Who decides what

Each stage answers one question, and a later stage never reverses an earlier
one's answer by dropping the statement:

- **Intent** decides whether a statement is memory (`save_class`), including
  that a restated linked-account balance, holding, or transaction is not.
- **Merge** decides how it attaches. For a correction or deletion,
  `_resolve_mutation_target` validates the target the model named against the
  `existing_entities` it was shown: a target the owner has is kept, a target
  the owner does not have is never written to, and the model's `create_entity`
  for a correction with no prior entity stands. Until 2026-10-02 a miss by the
  word-overlap fallback vetoed all three, so the instruction to keep an
  unmatched correction could never take effect.
- **Structure** decides where it goes, never whether. A structure
  `do_not_save` on a statement intent kept and merge attached becomes a review
  card (`structure_drop_kept_for_review`). The service still drops ephemeral,
  opaque, and reserved-only input itself, after that rule.

### The saved payload is not model-authored

`_STRUCTURE_PREVIEW_SCHEMA` declares `candidate_payload` as an `OBJECT` with no
properties, so the model can return only `{}`, and `_sanitize_candidate_payload`
substitutes `_fallback_payload_from_intent`. The live eval's
`payload_authored_by_model_rate` measured 0.0 on both the 2026-10-02 baseline
and head. The payload rules in the structure instruction therefore do not
reach a saved payload today. Whether the model should author it is an open
product decision; the diagnostic will show the change when it is made.

## Agent ownership

### Memory Segmentation Agent

Owns:

- selecting every stated claim as an exact quote, eight per batch, with `has_more_candidates`
  when more remain (the device splits the passage and asks again)
- `context_quotes`: the exact headings or lead-in lines that attribute or qualify a segment
- `not_memory[]: {quote, reason: duplicate | disclaimer}` for every line it does not select

Does not own:

- intent, domain, payload, or whether a quote "really" matches; the server maps each quote
  onto the owner's exact text (`locate_source_quote`), tolerating cleaned Markdown and dash or
  quotation-mark variants, and drops only a quote that matches nothing

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
- Source Library query, organization, file management, or sharing intent

### Memory Merge Agent

Owns:

- create vs extend vs correct vs delete vs no_op at the entity level
- target entity resolution
- merge confidence and reasoning

Does not own:

- final payload structure
- consent enforcement
- encryption or persistence
- the reserved `source_library` capability boundary

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
- Source Library files, collections, sharing, or its canonical private writer

For `financial`, the structure agent's system instruction carries the Finance
hierarchy a person browses: `profile` (preferences and risk), `goals`, `events`
(financial life events and the person's own account facts), and the read-only
`linked_accounts` written by the bank connection. Keys are plain words, never
provider ids, account numbers or provider type codes.

Mounted Drive or local-file requests route to the Hermes-local Source Library
Steward. The generic PKM agents may organize ordinary user-authored memory about
those requests, but they must never emit `source_library` as a candidate or
target domain.

## IntentFrame contract

Required fields:

- `save_class = durable | ephemeral | ambiguous`
- `intent_class` (includes `command`: a live instruction to act now, never memory, and never
  applied to pasted or quoted source material)
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
- candidate choices must exclude reserved canonical-writer-only domains such as `source_library`

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
- no reserved `source_library` target

## Validator responsibilities

The validator may:

- reject incoherent output
- downgrade to `confirm_first`
- downgrade to `do_not_save`
- keep a fact whose domain the model named after a protocol namespace (`agent`, `agents`,
  `mcp`, `system`) in the intent's domain or `professional`, recorded as
  `protocol_domain_name_remapped`; storage and authority namespaces (`vault`, `pkm`, `consent`,
  `scope`, quarantine) stay refused
- skip the structure agent only for an intent `no_op` or `command`; a statement that needs the
  owner's confirmation is still structured, never filed through the clipped fallback record
- prevent unsafe scope emission
- reject reserved-domain selection by a generic PKM agent
- set `do_not_save` with `source_managed_branch_blocked` when a financial candidate
  touches a branch the bank-connection lane rebuilds whole
  (`FINANCIAL_SOURCE_MANAGED_BRANCHES`: `linked_accounts`, `summary`, `*_v1`); a
  write there would be erased by the next refresh
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

Current PKM classifier candidates:

- `gemini-default` (the switched fleet text model, `constants.GEMINI_MODEL`) for every stage, Memory Segmentation and Memory Intent included; the catalog holds exactly two Gemini Flash releases, `gemini-3.7-flash` (default) and `gemini-3.6-flash` (founder decision 2026-09-25, chosen by measured chat latency; `gemini-3.8-flash` retired), and no stage pins a model of its own

Live prompt-hardening posture:

- Segmentation can return zero candidates; it must quote only exact user-provided durable claims.
- A missing, invalid, or timed-out segmentation/structure response never produces a saveable card.
- KYC auto-saves only the same eligible `can_save` cards as the owner opt-in auto-save path.

Only the two salience contracts use the higher-capability model. Keep the remaining PKM graph on the bounded Flash path unless a no-write evaluation proves a broader change is needed.

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

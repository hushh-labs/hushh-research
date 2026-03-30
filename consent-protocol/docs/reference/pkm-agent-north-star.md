# PKM Agent North Star


## Visual Context

Canonical visual owner: [consent-protocol](../README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This is the non-negotiable methodology for PKM development.

Supporting docs:

- `./pkm-prompt-contract.md`
- `./backend-semantic-boundary.md`
- `./backend-semantic-baseline-audit.md`
- `./pkm-structure-agent-live-eval.md`

## Core rule

Canonical PKM understanding must be derived through agents only.

- use ADK/A2A agent stages for semantic understanding
- use exact structured-output contracts
- use deterministic validation after the model
- do not add service-local classification heuristics as the primary source of truth

Imperative code is allowed only to:

- validate agent output
- enforce security and consent
- normalize storage shape
- reject unsafe or incoherent output

Imperative code must not replace the agent as the canonical semantic classifier.

## Required architecture

Every canonical PKM preview follows this flow:

1. `Financial Guard Agent`
   - decide whether the message belongs in governed financial core
   - decide whether it is sanctioned durable financial memory
   - keep non-financial and ephemeral requests out of the financial lane

2. `Memory Intent Agent`
   - classify durable vs ephemeral vs ambiguous
   - classify ontology intent
   - classify mutation intent
   - decide whether confirmation is required
   - return broad domain choices

3. `Memory Merge Agent`
   - decide whether the message creates, extends, corrects, deletes, or skips a durable entity
   - attach the message to a stable existing entity when possible
   - avoid append-only semantic drift

4. `PKM Structure Agent`
   - choose the target domain
   - emit the candidate payload
   - emit the structure decision
   - emit the manifest-facing scope plan

5. Deterministic validator
   - reject domain/payload mismatch
   - reject unsafe scope output
   - downgrade unresolved output to `confirm_first`
   - prevent non-financial prompts from contaminating `financial`
   - enforce that sanctioned financial memory stays inside guarded financial structure
   - reject gibberish, ciphertext-like input, and semantically empty text from entering PKM

## Prompt contract discipline

Prompts are not loose guidance. They are contracts.

Every canonical PKM agent prompt must:

- require JSON only
- define an exact schema
- run at low temperature
- avoid hidden fallback semantics
- use stable ontology labels
- use broad top-level domain choices
- avoid vague fallback domains such as `general`
- keep top-level domains dynamic per user while using a hidden soft ontology for stability

Prompt evolution must be ontology-first, not exception-first.

Do not patch prompts with one-off rules like:

- if the user says X, always map to Y
- if this edge case failed once, add a narrow exception

Instead:

- clarify ontology definitions
- clarify durable vs ephemeral policy
- clarify mutation semantics
- clarify confirmation policy
- add clustered few-shot examples by capability

## No-drift enforcement

New PKM development must not drift away from this methodology.

The repo should treat the following as mandatory:

- live-model eval before trusting prompt changes
- phase-based promotion from smaller evals to deeper chained evals
- comparison against a reference model
- latency-aware selection of the fastest model that does not materially reduce quality

## Model-selection policy

The preferred model is not the largest model. It is the lowest-latency model that stays inside the accuracy bar.

Promotion rule:

- compare against the reference model on live prompts
- allow a faster model only if:
  - intent accuracy delta is within `5` points
  - domain accuracy delta is within `5` points
  - mutation accuracy delta is within `5` points
  - finance contamination does not worsen

This is especially important because the long-term bar is future on-device models on iOS and Android.

## Phase ladder

- `fresh_random_120`
  - `120` all-new single-turn prompts
  - broad day-to-day coverage with no exact reuse from prior sanity strings
- `fresh_chain_60`
  - `60` chained prompts for one evolving PKM
- `fresh_chain_120`
  - `120` chained prompts for one richer evolving PKM

No phase should advance if it introduces measurable accuracy regression just to reduce latency.

## Product principle

The PKM should feel generally intelligent because the prompts, contracts, and agent choreography are strong enough to generalize, not because the codebase accumulates exceptions forever.

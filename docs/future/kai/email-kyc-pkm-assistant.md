# One-Led Email / KYC / PKM Specialist

## Status

- Status: superseded planning history
- Execution state: strict client-side One Email KYC is implemented for dev/UAT; production/public automation remains gated
- Current owner docs: [One Email Intake Roadmap](../one-email-intake-roadmap.md), [API contracts](../../reference/architecture/api-contracts.md), and `consent-protocol/docs/reference/agent-development.md`

## Visual Context

Canonical visual owner: [Vision Index](../../vision/README.md), with the detailed planning map in [One/Kai/Nav/KYC Runtime Plan](../one-nav-runtime-plan.md) and the mailbox rollout path in [One Email Intake Roadmap](../one-email-intake-roadmap.md). This page is retained only as planning history; it must not be used as the current implementation contract.

## Summary

This concept makes One the user-facing orchestrator and adds KYC as a delegated identity/workflow specialist that can execute narrow email-backed KYC tasks after on-demand scoped consent.

The goal is not a generic email bot or a public inbox-first workflow. The goal is a trust-bound workflow component that fits Hussh's existing architecture:

- One remains the user-facing relationship layer and orchestrator
- Nav owns consent and trust review when the workflow needs additional scope
- KYC owns identity/KYC workflow execution inside the granted scope
- PKM remains the durable personal memory layer
- Consent Protocol remains the authority layer
- delegated runtime state stays task-local and minimal

## North-Star Alignment

This concept aligns with existing Hussh north stars when it keeps these invariants intact:

1. consent-first access
2. BYOK and zero-knowledge boundaries
3. PKM as durable personal memory
4. One as the personal agent the user trusts directly
5. Kai, Nav, and KYC operating as delegated specialists inside explicit authority boundaries

## Current-State Overlap

What already exists in the repo today:

- PKM as the durable personal-memory model
- Consent Protocol for scoped access and audit
- ADK-backed agent orchestration surfaces in the backend
- One/Kai/Nav ontology in `docs/vision/agent-ontology.md`
- connector-aware runtime patterns for delegated actions
- authenticated support and feedback delivery routed through the existing Gmail-backed support transport

What is still not complete as product/runtime rollout:

- real post-`050`/`051` UAT smoke evidence across mailbox, vault unlock, consent, local decrypt/draft, approved send, encrypted PKM writeback, and retention
- production mailbox-watch ownership and production enablement
- public inbound KYC rollout
- accepted iOS device proof for `/one/kyc`

## Historical Concept

The future-state model is:

1. the user asks One to handle a scheduling or KYC email workflow
2. One determines that email-backed delegated execution is needed
3. One asks Nav to frame narrow, on-demand consent with task metadata when new scope is required
4. One delegates the task to the KYC specialist through an A2A-style boundary
5. the specialist executes only within the granted scope
6. only structured facts write back into PKM
7. One stays the visible relationship layer for status, approvals, and outcome

## Exemplar Workflows

### 1. Scheduling / reconnect assistant

- read the relevant email thread
- extract scheduling constraints
- combine that with calendar availability and PKM preferences
- draft or send low-risk scheduling replies within policy
- ask for confirmation before final booking

### 2. KYC document workflow

- read inbound requirements and missing-document requests
- draft follow-up or collection messages
- track completion state and next steps
- keep sensitive outbound actions approval-gated by default

## Memory Model

The planning boundary should stay explicit:

- `PKM` = durable personal memory
- delegated runtime memory = task-local execution state

Structured PKM writeback may include:

- scheduling preferences learned with confidence
- canonical workflow outcome
- verified document status
- relationship/contact summaries

It should not default to broad raw-thread persistence as durable memory.

## Historical Required Primitives

This historical list records what the concept expected before execution. Several items now exist in dev/UAT; use the current owner docs above for implementation truth.

1. delegated workflow consent metadata
2. explicit task-local runtime-state contract
3. outbound-action policy by workflow type
4. trust-state UX contract for waiting, approval, and completion
5. promotion of connector boundaries from concept to execution-owned docs
6. a transport-sharing rule that allows reuse of support/email queue primitives without inheriting the support trust model
7. `agent.kyc.*` scopes, a KYC agent manifest, and a One-to-KYC delegation contract
8. `one@hushh.ai` mailbox/delegated-sender ownership before public inbound rollout

## Edge and Risk Assessment

### Trust and authority

- a delegated specialist must not become a separate uncontrolled trust domain
- KYC must not become a second top-level personal agent; One owns the relationship layer
- send authority must stay workflow-specific and legible
- final authority boundaries need to distinguish low-risk coordination from sensitive KYC actions

### BYOK / zero-knowledge

- durable workflow state cannot become a plaintext shadow memory store
- decrypted task context should stay ephemeral and minimal
- PKM writeback must remain structured and scoped

### PKM vs runtime memory

- PKM should not absorb transient chain-of-thought or temporary tool state
- runtime execution needs enough state to resume work without turning into a second personal-memory system

### Delegation and connector boundaries

- on-demand consent should carry enough metadata for the user to understand what is being requested
- connector permissions must stay task-specific instead of broad background access
- delegated execution must fail closed when scope, authority, or freshness is unclear
- email/KYC may share delivery and queueing primitives with Support, but it must not share Support's authority model or bypass the consent boundary

### UX risk

- users need a simple trust-state surface:
  - needs approval
  - working
  - waiting on reply
  - waiting on you
  - completed
- the assistant must stay useful without becoming opaque

## Non-Goals

This concept does not assume:

- a fully autonomous email agent with broad standing authority
- raw email threads as permanent PKM memory by default
- immediate implementation of a durable workflow engine
- bypassing consent or trust-state UX in the name of speed
- approval of a live public `one@hushh.ai` inbound webhook before the trust and rollout contract is explicitly owned

## Historical Promotion Readiness Checklist

This checklist is preserved for provenance only. Do not use it to judge current implementation readiness:

1. workflow owners and execution surfaces
2. delegated-consent contract shape
3. PKM writeback contract
4. runtime-state contract
5. user-facing trust-state UX
6. approval policy for outbound actions
7. One/Nav/KYC prompt, speaker, and delegated-agent contracts

## Recommended Execution Split

Once approved, split by subsystem:

- cross-cutting assistant and trust contracts -> `docs/reference/...`
- backend agent/runtime and consent contracts -> `consent-protocol/docs/...`
- frontend workflow UX and trust states -> `hushh-webapp/docs/...`

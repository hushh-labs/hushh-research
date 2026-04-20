# Kai Email / KYC / PKM Assistant

## Status

- Status: future roadmap and R&D assessment only
- Execution state: not approved for implementation
- Promotion rule: move execution detail into `docs/reference/...`, `consent-protocol/docs/...`, and `hushh-webapp/docs/...` only after the workflow, authority boundaries, and owners are approved

## Visual Context

Canonical visual owner: [Kai Future Roadmap](./README.md). Use that map for the planning hierarchy; this page is the narrower concept note beneath it.

## Summary

This concept keeps Kai as the primary assistant and adds a Kai-owned delegated email/KYC specialist that can execute narrow workflow tasks after on-demand scoped consent.

The goal is not a generic email bot. The goal is a trust-bound workflow component that fits Hushh's existing architecture:

- Kai remains the user-facing orchestrator
- PKM remains the durable personal memory layer
- Consent Protocol remains the authority layer
- delegated runtime state stays task-local and minimal

## North-Star Alignment

This concept aligns with existing Hushh north stars when it keeps these invariants intact:

1. consent-first access
2. BYOK and zero-knowledge boundaries
3. PKM as durable personal memory
4. Kai as the assistant the user trusts directly
5. delegated agents operating only inside explicit authority boundaries

## Current-State Overlap

What already exists in the repo today:

- PKM as the durable personal-memory model
- Consent Protocol for scoped access and audit
- ADK-backed agent orchestration surfaces in the backend
- Kai as the user-facing assistant identity
- connector-aware runtime patterns for delegated actions

What does not yet exist as a first-class product/runtime contract:

- a Kai-owned email/KYC delegated sub-agent contract
- workflow-specific on-demand consent metadata for this task family
- a canonical runtime-memory/writeback split for delegated email/KYC workflows
- explicit user-facing trust-state UX for this workflow family

## Future Concept

The future-state model is:

1. the user asks Kai to handle a scheduling or KYC email workflow
2. Kai determines that email-backed delegated execution is needed
3. Kai requests narrow, on-demand consent with task metadata
4. Kai delegates the task to a Kai-owned specialist through an A2A-style boundary
5. the specialist executes only within the granted scope
6. only structured facts write back into PKM
7. Kai stays the visible orchestrator for status, approvals, and outcome

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

## Required New Primitives

Before execution, this concept likely needs:

1. delegated workflow consent metadata
2. explicit task-local runtime-state contract
3. outbound-action policy by workflow type
4. trust-state UX contract for waiting, approval, and completion
5. promotion of connector boundaries from concept to execution-owned docs

## Edge and Risk Assessment

### Trust and authority

- a delegated specialist must not become a separate uncontrolled trust domain
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

## Promotion Readiness Checklist

Do not promote this concept into execution docs until these are explicit:

1. workflow owners and execution surfaces
2. delegated-consent contract shape
3. PKM writeback contract
4. runtime-state contract
5. user-facing trust-state UX
6. approval policy for outbound actions

## Recommended Execution Split

Once approved, split by subsystem:

- cross-cutting assistant and trust contracts -> `docs/reference/...`
- backend agent/runtime and consent contracts -> `consent-protocol/docs/...`
- frontend workflow UX and trust states -> `hushh-webapp/docs/...`

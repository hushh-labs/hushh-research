# Kai Action Gateway vNext

Status: canonical capability-authoring reference for Kai voice, typed search, UI actionables, and planner grounding.

## Visual Map

```mermaid
flowchart TD
  local["Local .voice-action-contract.json files"]
  generator["generate-kai-action-gateway.mjs"]
  gateway["kai-action-gateway.vnext.json"]
  manifest["voice-action-manifest.v1.json"]
  frontend["Frontend gateway + registry adapters"]
  backend["Backend manifest loader"]
  runtime["Voice runtime, search, and UI actionables"]

  local --> generator
  generator --> gateway
  generator --> manifest
  gateway --> frontend
  gateway --> backend
  frontend --> runtime
  backend --> runtime
```

## Purpose

Kai now uses one generated action plane instead of hand-maintained voice maps spread across multiple files.

This document defines:

- how a Kai capability becomes discoverable
- where contributors author the capability contract
- how voice, search, UI actionables, analytics, and docs share the same action identity
- how persona, workspace, vault, consent, and onboarding constraints are enforced centrally
- how authored multi-step workflows are executed safely

## Founder Language Mapping

- the generated action plane is part of the platform's `Separation of Duties`: discoverability is authored locally, shared semantically, and enforced at runtime
- `Capability Tokens` and route guards remain the authority checks; action metadata does not create permission
- `TrustLink / A2A delegation` should consume stable `action_id` semantics when agent handoffs are introduced, but no separate delegation plane is implied by this doc

## Architecture

The action system is split into four deliberate layers.

### 1. Local authored contracts

Each voice-capable or search-capable Kai surface owns a colocated `.voice-action-contract.json` file next to the feature surface.

Current generated coverage includes 9 source contracts and 31 actions. Source contracts:

- [page.voice-action-contract.json](../../../hushh-webapp/app/kai/analysis/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/profile/page.voice-action-contract.json)
- [page-client.voice-action-contract.json](../../../hushh-webapp/app/profile/pkm-agent-lab/page-client.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/profile/receipts/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/ria/page.voice-action-contract.json)
- [consent-center-page.voice-action-contract.json](../../../hushh-webapp/components/consent/consent-center-page.voice-action-contract.json)
- [kai-command-bar-global.voice-action-contract.json](../../../hushh-webapp/components/kai/kai-command-bar-global.voice-action-contract.json)
- [dashboard-master-view.voice-action-contract.json](../../../hushh-webapp/components/kai/views/dashboard-master-view.voice-action-contract.json)
- [kai-market-preview-view.voice-action-contract.json](../../../hushh-webapp/components/kai/views/kai-market-preview-view.voice-action-contract.json)

These contracts are the authoring source of truth for capability existence.

### 2. Generated shared gateway

The generator in [generate-kai-action-gateway.mjs](../../../hushh-webapp/scripts/voice/generate-kai-action-gateway.mjs) scans all local contracts and emits:

- [kai-action-gateway.vnext.json](../../../contracts/kai/kai-action-gateway.vnext.json)
- [voice-action-manifest.v1.json](../../../contracts/kai/voice-action-manifest.v1.json)

The gateway is the shared semantic authority.
The manifest is a generated compatibility artifact for consumers that still read the neutral manifest shape.

### 3. Runtime adapter layer

Frontend and backend consume the generated gateway through thin adapters:

- [kai-action-gateway.ts](../../../hushh-webapp/lib/voice/kai-action-gateway.ts)
- [investor-kai-action-registry.ts](../../../hushh-webapp/lib/voice/investor-kai-action-registry.ts)
- [voice_action_manifest.py](../../../consent-protocol/hushh_mcp/services/voice_action_manifest.py)

The registry is no longer a hand-authored source of truth. It is a richer frontend adapter over the generated gateway.

### 4. Runtime metadata

Surface metadata still matters, but only for current state:

- active control
- selected entity
- visible modules
- busy operations
- explainable screen context

Runtime metadata must not invent capabilities. Capability existence comes from local contracts and the generated gateway.

## Universal Action Identity

Every actionable uses one stable `action_id` across:

- voice planning
- typed search
- tappable UI actionables
- command execution
- analytics correlation
- docs and review references

Do not create parallel ids for voice versus search versus tap.

## Authored Contract Shape

Each local contract can define one surface plus its actions.

Required action fields:

- `action_id`
- `surface_id`
- `label`
- `aliases`
- `meaning`
- `reachability`
- `guard_ids`
- `execution_policy`
- `execution_target`
- `control_ids`
- `search_keywords`

Optional but recommended action fields:

- `state_exposure`
- `docs_references`
- `expected_effects`
- `workflow`

## Multi-Step Workflow Model

Kai supports authored multi-step workflows for actions that require prerequisites before the final action can run.

Rule:

- if the UI can validly move from step 1 to step 2, the voice/search action may do the same
- the chain must be authored explicitly
- the runtime must not guess multi-step flows from transcript heuristics

Supported step types:

- `route_switch`
- `persona_switch`
- `tool_call`
- `prompt`

Each step may declare:

- `preconditions`
- `postconditions`
- `settlement_target`
- `failure_behavior`

Execution rules:

- normal prerequisites may auto-chain
- each step must settle before the next step runs
- any failed precondition or failed settlement stops the chain
- Kai explains the blocking reason instead of pretending success

## Persona, Workspace, and Locked Capability Policy

Persona and workspace are hard preconditions, not hint text.

Rules:

- actions unavailable in the active persona are not directly executable
- if the target persona is already earned, Kai may surface the action but must ask before switching persona when the workflow requires it
- if the capability is not unlocked yet, Kai must block and guide
- route visibility does not override persona, vault, auth, consent, or onboarding guards

Example:

- an investor asking for an RIA action may receive a `requires_persona_switch` availability result
- if RIA is not available, the action stays blocked with explicit setup guidance

## Search, Voice, and UI Parity

The Kai search bar now resolves actions from the same gateway used by voice grounding.

That means the same action contract controls:

- visible search suggestions
- voice-resolvable aliases
- control-id to action mapping
- workflow availability
- execution policy
- settlement expectations

Contributors should wire UI controls with stable `control_ids` so both screen context and action suggestions resolve through the same action id.

## Durable Memory Policy

Kai voice memory follows the Cryptographic Primitives north star:

- short-term turn memory stays in-memory only
- durable voice memory is accessible only when the vault is unlocked
- durable voice memory is stored only in encrypted client-side form
- durable voice memory must not fall back to plaintext browser storage

Current implementation:

- [voice-memory-store.ts](../../../hushh-webapp/lib/voice/voice-memory-store.ts)
- encrypted IndexedDB
- `localStorage` is not used for durable voice memory

Allowed durable summaries are limited to stable preference-like information.
Secrets, identifiers, documents, statements, tokens, and vault material are rejected.

## Contributor Workflow

When adding a new Kai capability that should be discoverable:

1. Add or update the local `.voice-action-contract.json` next to the surface.
2. Reuse or mint one stable `action_id`.
3. Add `control_ids` for the UI affordances that should map back to the action.
4. Add persona, vault, auth, consent, and route guards up front.
5. Add a `workflow` only when the UI actually supports the prerequisite chain.
6. Run the generator.
7. Run the gateway verifier.
8. Update targeted tests when capability semantics change.

If a feature ships without a local contract:

- it is not voice-discoverable
- it is not typed-search discoverable
- it should be surfaced in review as missing actionability coverage

## Governance

This starts as non-blocking governance, not a hard CI gate.

Local author command:

```bash
cd hushh-webapp && npm run build:voice-gateway
cd hushh-webapp && npm run verify:voice-gateway
```

Review expectations:

- `voice_systems_architect` checks contract and runtime drift
- `reviewer` flags missing local contracts and stale action ids
- `security_consent_auditor` checks persona, consent, vault, and memory policy regressions

Repo-local skill:

- [kai-voice-governance](../../../.codex/skills/kai-voice-governance/SKILL.md)

## Minimum Verification

```bash
cd hushh-webapp && npm run build:voice-gateway
cd hushh-webapp && npm run verify:voice-gateway
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run test -- __tests__/voice/kai-action-gateway.test.ts __tests__/voice/voice-action-manifest.test.ts __tests__/voice/investor-kai-action-registry.test.ts __tests__/voice/voice-grounding.test.ts __tests__/voice/voice-turn-orchestrator.test.ts
cd consent-protocol && python3 -m pytest tests/test_kai_voice_contract.py -q
./bin/hushh docs verify
```

## Related References

- [kai-voice-runtime-architecture.md](./kai-voice-runtime-architecture.md)
- [kai-voice-assistant-architecture.md](./kai-voice-assistant-architecture.md)

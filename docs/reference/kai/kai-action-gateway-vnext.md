# Kai Action Gateway vNext

Status: canonical capability-authoring reference for One Voice/Kai compatibility, typed search, UI actionables, and planner grounding.

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

One Voice and Kai compatibility now use one generated action plane instead of hand-maintained voice maps spread across multiple files.

This document defines:

- how a One Voice or Kai-specialist capability becomes discoverable
- where contributors author the capability contract
- how voice, search, UI actionables, analytics, and docs share the same action identity
- how persona, workspace, vault, consent, and onboarding constraints are enforced centrally
- how authored multi-step workflows are executed safely
- how generated goal metadata feeds One Goal across voice, chat, typed search, command bar, and UI actions
- how One, Kai, and Nav speaker ownership is declared without changing execution authority

## Founder Language Mapping

- the generated action plane is part of the platform's `Separation of Duties`: discoverability is authored locally, shared semantically, and enforced at runtime
- `Capability Tokens` and route guards remain the authority checks; action metadata does not create permission
- `TrustLink / A2A delegation` should consume stable `action_id` semantics when agent handoffs are introduced, but no separate delegation plane is implied by this doc

## Architecture

The action system is split into four deliberate layers.

### 1. Local authored contracts

Each voice-capable or search-capable Kai surface owns a colocated `.voice-action-contract.json` file next to the feature surface.

Current generated coverage includes 35 source contracts, 35 surfaces, and 130 actions. Source contracts:

- [page.voice-action-contract.json](../../../hushh-webapp/app/login/page.voice-action-contract.json) — Login-local Google and Apple popup actions shared with the visible provider buttons. Generic sign-in remains a provider-choice interaction.

- [page.voice-action-contract.json](../../../hushh-webapp/app/one/kai/analysis/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/one/page.voice-action-contract.json)
- [page-client.voice-action-contract.json](../../../hushh-webapp/app/marketplace/ria/page-client.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/one/kyc/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/one/marketplace/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/profile/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/one/gmail/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/ria/clients/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/ria/onboarding/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/ria/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/ria/picks/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/ria/requests/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/ria/settings/page.voice-action-contract.json)
- [page.voice-action-contract.json](../../../hushh-webapp/app/ria/workspace/page.voice-action-contract.json)
- [specialist-turns.voice-action-contract.json](../../../hushh-webapp/components/agent/specialist-turns.voice-action-contract.json)
- [consent-center-page.voice-action-contract.json](../../../hushh-webapp/components/consent/consent-center-page.voice-action-contract.json)
- [kai-command-bar-global.voice-action-contract.json](../../../hushh-webapp/components/kai/kai-command-bar-global.voice-action-contract.json)
- [dashboard-master-view.voice-action-contract.json](../../../hushh-webapp/components/kai/views/dashboard-master-view.voice-action-contract.json)
- [kai-market-preview-view.voice-action-contract.json](../../../hushh-webapp/components/kai/views/kai-market-preview-view.voice-action-contract.json)
- [ria-client-account-detail.voice-action-contract.json](../../../hushh-webapp/components/ria/ria-client-account-detail.voice-action-contract.json)
- [ria-client-request-detail.voice-action-contract.json](../../../hushh-webapp/components/ria/ria-client-request-detail.voice-action-contract.json)
- [ria-client-workspace.voice-action-contract.json](../../../hushh-webapp/components/ria/ria-client-workspace.voice-action-contract.json)

These contracts are the authoring source of truth for capability existence.

### 2. Generated shared gateway

The generator in [generate-kai-action-gateway.mjs](../../../hushh-webapp/scripts/voice/generate-kai-action-gateway.mjs) scans all local contracts and emits:

- [kai-action-gateway.vnext.json](../../../contracts/kai/kai-action-gateway.vnext.json)
- [voice-action-manifest.v1.json](../../../contracts/kai/voice-action-manifest.v1.json)

The gateway is the shared semantic authority.
The manifest is a generated compatibility artifact for consumers that still read the neutral manifest shape.

The companion [route orchestration index](../../../contracts/kai/one-route-orchestration-index.v1.json)
joins this gateway to every physical app route. The route-layout contract owns one
bounded `voicePlaybook` per route; local action contracts continue to own actions,
trust boundaries, and delegation policy. The joined output is guidance/discovery metadata only and
does not grant consent or alter TrustLink signatures.

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
- `speaker_persona`
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

- `delegate_agent_id`
- `state_exposure`
- `docs_references`
- `expected_effects`
- `workflow`
- `goal`
- `external_callback` for a provider action whose completion occurs after a
  full-page external redirect. It declares the provider, `external_redirect_started`,
  `firebase_redirect_callback`, `retain_goal_and_retry`, and the canonical return route.
- `trusted_activation_required` for a desktop-web action that must begin inside a
  browser-trusted tap, such as a Firebase provider popup. One may select the action,
  but an asynchronous directive must settle into the exact provider-specific Agent Bar
  action instead of synthesizing activation or changing authentication mode.

`external_callback` does not grant provider authority. It tells One that the original
directive ends at redirect launch and that a later browser callback, never the launch,
is the authentication success boundary.

`trusted_activation_required` does not authorize execution either. The trusted tap
must revalidate the current route, top interaction layer, visible control, guards, and
attempt correlation, then call the mounted handler synchronously before asynchronous
work begins.

## Active interaction-layer parity

Runtime publishers are authored as `route`, `chrome`, or `interaction_layer`. The
route contract remains the physical-screen source; the top open layer provides the
effective action inventory:

- modal and blocking layers replace underlying actions
- nonmodal layers retain only explicitly permitted route actions
- nested layers restore their parent inventory when they close
- nondismissible layers never receive an invented close action

Every executable layer control must name a generated `action_id`, stable `control_id`,
and mounted handler. A layer-specific dismiss or cancel action is preferable to a
global close command because its meaning and settlement remain explicit. Generated
parity joins gateway, manifest, frontend/native surface map, interaction-layer
coverage, and route-orchestration index in that order.

## Goal Metadata

Every generated action now receives a `goal` block. Simple actions are auto-wrapped as one-step goals by the generator; multi-step actions should author explicit goal metadata in their local `.voice-action-contract.json`.

Goal fields:

- `goal_id`: stable product goal identity, normally `goal.<action_id>` unless a richer workflow owns the goal
- `required_inputs`: ordered list of inputs One must collect before running
- `input_resolvers`: named app-state resolvers such as ticker, list/source, selected entity, vault readiness, or active workspace
- `slot_schema`: lightweight shape for slots the runner can pass to the generated action
- `workflow_steps`: generated action steps plus approved app service adapters
- `progress_contract`: event names and milestone copy for long-running goals
- `cancellation_contract`: whether cancellation is supported and which generated action cancels it
- `result_contract`: concise result summary rules
- `entrypoint_support`: `voice`, `chat`, `typed_search`, `command_bar`, and `ui` support

Rules:

- One Goal may infer a goal from natural language, but the generated contract decides required inputs and execution policy.
- If all required inputs are present and the action policy is `allow_direct`, One Goal may execute directly after guard evaluation.
- If an input is missing, One Goal asks for the next blocking input only.
- If an action is delegated, sensitive, or manual-only, One Goal routes to Agent Chat, consent, or the specialist surface.
- Providers such as Gemini Live and future OpenAI Realtime can propose a generated `action_id` plus slots; they never execute the action themselves.

Reference explicit goal:

- `analysis.start` owns `goal.analysis.start_debate`, requires `symbol` and `pickSource`, starts through `analysis.start`, then uses `kai_debate.ensure_run` for the long-running debate stream, cancellation, progress milestones, and final decision summary.

## Speaker Persona And Namespace Rules

Each action declares `speaker_persona`:

| Value | Meaning |
| --- | --- |
| `one` | One owns the spoken framing. Use for generic, route, shell, memory, notification, and handoff actions. |
| `kai` | Kai owns the spoken framing. Use for finance, analysis, portfolio, market, and RIA finance actions. |
| `nav` | Nav owns the spoken framing. Use for privacy, consent, vault, deletion, revocation, and scope-review actions. |
| `kyc` | KYC owns the spoken framing. Use only for explicit KYC workflow status, missing-document review, approval-gated drafts, and structured writeback actions. |

Speaker persona is presentation and prompt ownership only. It does not create authorization and must never bypass auth, vault, consent, persona, workspace, or rollout gates.

`delegate_agent_id` is nullable and declares which runtime specialist executes a user-facing action when One frames the handoff. Public `speaker_persona` remains limited to `one`, `kai`, `nav`, and `kyc`; delegate ids may name wired backend A2A specialists. Allowed delegate values are `one`, `kai`, `nav`, `kyc`, `agent_connected_systems`, `agent_connections`, `agent_email`, `agent_location`, and `agent_personal_information`.

Specialist-turn goals use `execution_target.target = "specialist_chat.turn"` and run through the existing Agent Chat A2A stream. Gemini Live or another provider may propose those action ids, but the One Goal planner remains authoritative and the backend only dispatches to a registered specialist. Read-only specialist turns may execute directly when the generated policy is `allow_direct`; write-like or confirmation-bound turns use `confirm_required` and settle into the governed chat/card path.

Action namespace rules:

- `route.*` is the namespace for navigation and route changes.
- `analysis.*` and `kai.*` remain finance/Kai specialist namespaces.
- `nav.*` is reserved for true Nav privacy/consent guardian actions.
- `kyc.*` is reserved for true KYC identity-workflow actions.
- Do not add legacy aliases from old navigation `nav.*` ids. This migration is a straight rename.

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
- if the target persona is already earned, One may sync the active workspace and route-settle a direct action only when the generated contract is `allow_direct` and `requires_persona_switch_confirmation` is `false`
- if the workflow requires persona-switch confirmation, One must ask before switching persona
- if the capability is not unlocked yet, Kai must block and guide
- route visibility does not override persona, vault, auth, consent, or onboarding guards

Example:

- an investor asking for an RIA action may receive a `requires_persona_switch` availability result
- if RIA is not available, the action stays blocked with explicit setup guidance

## RIA Voice Support

RIA voice support now covers the advisor workspace shell, onboarding, client roster, client workspace, account/request detail fallbacks, stock picks, compatibility routes, and marketplace RIA profile surfaces.

Important RIA action groups:

| Action group | Examples | Execution | Guardrails |
| --- | --- | --- | --- |
| RIA route navigation | `route.ria_home`, `route.ria_onboarding`, `route.ria_clients`, `route.ria_picks`, `route.ria_requests_compat`, `route.ria_settings_compat` | Wired route navigation | `auth_signed_in`, `ria_persona_available`; `route.ria_home` includes confirmed persona-switch workflow when entering from another persona |
| Picks read-only route state | `ria.picks.open_source_kai`, `ria.picks.open_category_top_picks`, `ria.picks.download_template` | Wired route/static download navigation | RIA persona and auth required |
| Client workspace tabs | `route.ria_client_workspace`, `ria.client_workspace.open_access_tab`, `ria.client_workspace.open_portfolio_tab`, `ria.client_workspace.open_explorer_tab` | Wired dynamic route navigation using the current `[userId]` from the active RIA client route | Auth, RIA persona, onboarding, and client relationship guards |
| RIA state-changing actions | `ria.picks.save_package`, `ria.client_workspace.request_access`, `ria.client_workspace.disconnect_relationship`, `marketplace.ria.request_advisory` | Manual-only or confirmation-required and currently unwired | Vault, consent, selected entity, manual execution, or explicit confirmation guards |

`route.ria_home` remains the workspace-entry workflow. It is authored in [page.voice-action-contract.json](../../../hushh-webapp/app/ria/page.voice-action-contract.json), generated into both [kai-action-gateway.vnext.json](../../../contracts/kai/kai-action-gateway.vnext.json) and [voice-action-manifest.v1.json](../../../contracts/kai/voice-action-manifest.v1.json), and projected through the frontend registry.

Execution behavior:

- if the user is already in the RIA persona, the workflow can route to `/ria`
- if the user has RIA available but is currently in another persona, Kai must ask before switching
- if RIA is locked or unavailable, the action blocks with setup guidance
- safe RIA navigation can execute directly
- dynamic client workspace tab routes execute only when the current URL provides the required client id
- RIA mutations remain manual-only or confirmation-required; Kai must not claim it completed them

Verification commands for this surface:

```bash
cd hushh-webapp && npm run verify:voice-gateway
cd hushh-webapp && npm run test -- __tests__/voice/kai-action-gateway.test.ts __tests__/voice/voice-action-manifest.test.ts __tests__/voice/investor-kai-action-registry.test.ts __tests__/voice/voice-grounding.test.ts __tests__/voice/voice-response-executor.test.ts
```

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

Runtime visibility is top-layer-aware. A generated action can exist without being
available on the current turn; hidden route controls must not remain in the active
inventory behind a modal or blocking layer. One assesses meaning against the bounded
inventory, and deterministic policy rejects stale or wrong-layer action ids rather
than substituting a nearby action.

## Durable Memory Policy

One Voice/Kai compatibility memory follows the Cryptographic Primitives north star:

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

When adding a new One Voice or Kai-specialist capability that should be discoverable:

1. Add or update the local `.voice-action-contract.json` next to the surface.
2. Reuse or mint one stable `action_id`.
3. Add `control_ids` for the UI affordances that should map back to the action.
4. Add persona, vault, auth, consent, and route guards up front.
5. Add a `workflow` only when the UI actually supports the prerequisite chain.
6. Run the generator.
7. Run the gateway verifier.
8. Update targeted tests when capability semantics change.

For interaction layers, also publish the authored role and lifecycle, expose only the
top effective actions, and verify focus restoration plus success-after-settlement. For
`trusted_activation_required` actions, verify both semantic provider selection and the
provider-specific trusted-tap continuation.

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

- [one-voice-kai-compatibility-runtime.md](../one/one-voice-kai-compatibility-runtime.md)
- [../one/one-voice-runtime-architecture.md](../one/one-voice-runtime-architecture.md)

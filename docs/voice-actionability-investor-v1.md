# Voice Actionability Investor V1

## Scope
Investor Kai only (no RIA flow in V1). This document describes the current grounding architecture, safety policy, observability, rollout flags, and next-step macro design.

## Architecture

### 1. Runtime context capture
- Source: `hushh-webapp/lib/voice/screen-context-builder.ts`
- Input: route/app runtime + voice context + live DOM hints.
- Output: `StructuredScreenContext` (route, active tab/section, selected entity, visible modules, runtime/busy state).

### 2. Planner response
- Source: `hushh-webapp/lib/voice/voice-turn-orchestrator.ts`
- Planner still returns normalized `VoiceResponse` payload.
- Orchestrator now computes a grounded layer on top of planner output.

### 3. Canonical action grounding
- Sources:
  - `hushh-webapp/lib/voice/investor-kai-action-registry.ts`
  - `hushh-webapp/lib/voice/voice-grounding.ts`
- Grounding resolves to:
  - `action_id`
  - `status` (`resolved`, `manual_only`, `unavailable`, `ambiguous`, `none`)
  - execution mode (`direct_tool`, `navigate_only`, `navigate_then_action`, etc.)
  - explicit execution steps.

### 4. Execution
- Source: `hushh-webapp/lib/voice/voice-response-executor.ts`
- Executor consumes `groundedPlan` and executes by step:
  - `navigate` via router
  - `tool_call` via dispatcher
  - `prompt` via toast
- Hidden-but-navigable actions are composed as simple `navigate -> single action` plans.
- Multi-step macro orchestration is intentionally deferred to V2.

### 5. UI wiring
- Sources:
  - `hushh-webapp/components/kai/kai-search-bar.tsx`
  - `hushh-webapp/components/kai/kai-command-bar-global.tsx`
- `turnId/responseId/groundedPlan` are threaded through the runtime callback boundary.

## Policy

### Destructive action policy (Investor V1)
- Destructive actions are **never auto-executed**.
- Voice response is forced to self-serve fallback:
  - `Please do that yourself in the app.`
- No confirmation flow and no execution attempt in V1.

### Unavailable action policy
- For dead/unwired/unresolvable actions:
  - user receives clear fallback message
  - execution status is logged as unavailable.

## Observability

### Grounding telemetry
- Intent to grounded action mapping is emitted from orchestrator:
  - debug event: `intent_grounded_action_mapped`
  - metric: `intent_grounded_action_mapping`
- Resolution details include:
  - planner intent name
  - grounded status
  - action id
  - execution mode.

### Hidden navigation path telemetry
- For `navigate_then_action` resolutions:
  - debug event: `hidden_navigation_resolution_path`
  - metric: `hidden_navigation_resolution`
  - payload includes ordered path (`navigate:/... -> tool:...`).

### Execution telemetry
- Emitted from executor (routed into dispatch debug stream):
  - `grounded_execution_success`
  - `grounded_execution_failure`
  - `grounded_unavailable`
  - `blocked_destructive_intent`
  - `grounded_execution_skipped_rollout_flag`
  - legacy branch events such as `legacy_execute_success` / `legacy_execute_failure`.

## Rollout controls

Flags in `hushh-webapp/lib/voice/voice-feature-flags.ts`:

- `NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_RESOLUTION_ENABLED`
  - Enables/disables grounding layer creation.
- `NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_POLICY_ENFORCEMENT_ENABLED`
  - Enables/disables policy override (`manual_only` / `unavailable` speak-only forcing).
- `NEXT_PUBLIC_VOICE_V2_GROUNDED_ACTION_EXECUTION_ENABLED`
  - Enables/disables grounded step execution (`navigate/tool_call` plan execution).

### Suggested rollout
1. Enable resolution + telemetry first.
2. Enable policy enforcement.
3. Enable grounded execution for a small traffic slice.
4. Ramp by environment cohorts.

## Extension plan to RIA

RIA phase should reuse the same layering:
1. Add `ria-action-registry.ts` with RIA scopes/guards/risk policies.
2. Add `resolveRiaGroundedPlan(...)` mirroring Investor contract.
3. Extend orchestrator to choose registry by active persona (Investor vs RIA).
4. Maintain separate destructive policy table for RIA workflows.
5. Keep telemetry schema unified with `persona=investor|ria` tag for comparability.

## V2 macro plan (deferred)

V2 will introduce multi-step macro execution with guardrails:
1. Macro planner graph (explicit step DAG).
2. Step-level preconditions + rollback hints.
3. Mid-macro user interruption handling.
4. Observable checkpoint events (`macro_step_started/completed/failed`).
5. Final user recap summarizing all steps completed/skipped.

V1 intentionally supports only:
- direct action
- hidden navigation + exactly one actionable step.

## Known limitations (current)
- Grounding inference still uses heuristic transcript matching for some hidden panels.
- Route readiness after navigation is currently immediate (no awaited route-settle hook).
- Cross-surface (Investor -> RIA) routing is intentionally out of scope.

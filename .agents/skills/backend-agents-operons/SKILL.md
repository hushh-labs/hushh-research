---
name: backend-agents-operons
description: Use when changing backend agents, operons, ADK surfaces, or orchestration contracts inside the consent-protocol runtime.
---

# Hussh Backend Agents Operons Skill

## Purpose and Trigger

- Primary scope: `backend-agents-operons`
- Trigger on agents, operons, ADK surfaces, orchestration boundaries, or tool/agent runtime changes.
- Avoid overlap with `backend-runtime-governance` and `security-audit`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `backend`

Owned repo surfaces:

1. `consent-protocol/hushh_mcp/agents`
2. `consent-protocol/hushh_mcp/operons`
3. `consent-protocol/hushh_mcp/tools`
4. `consent-protocol/hushh_mcp/hushh_adk`
5. `consent-protocol/hushh_mcp/adk_bridge`
6. `consent-protocol/hushh_mcp/one_adk`

Non-owned surfaces:

1. `backend`
2. `security-audit`
3. `repo-operations`

## Do Use

1. Agent and operon ownership or orchestration changes.
2. ADK integration boundaries and backend tool surfaces.
3. Agent-runtime docs and tests tied to orchestration behavior.

## Do Not Use

1. Broad backend intake where the correct spoke is still unclear.
2. Generic service-layer placement or API wire contract changes.
3. Trust-policy work where authorization or vault boundary is the primary concern.

## Read First

1. `consent-protocol/docs/reference/agent-development.md`
2. `docs/reference/one/one-agent-hierarchy.md`
3. `consent-protocol/docs/reference/kai-agents.md`
4. `docs/reference/ai/README.md`

## Workflow

1. Confirm whether the change is about orchestration, tool surface, or agent packaging before editing code.
2. Keep orchestration docs and relevant tests aligned with the implementation.
3. Route trust, consent, or scope-enforcement questions into `security-audit`.
4. For pod support, follow `agent-development.md`'s "One authored fleet, explicit runtime dependencies" procedure: reuse the agent and inject dependencies; verify authority and fail-closed behavior through the existing pod ledger. Follow the dev pod runbook's [startup qualification](../../../docs/reference/operations/dev-pod-first-light-runbook.md#qualifying-private-worker-startup) for provider-free rehearsal, incarnation recheck, the owned control socket and unchanged timeout deadlines.
5. Separate portable shared-runtime corrections from pod wiring before any ADK worktree transfer. Registration or local synthetic tests alone do not establish pod completion. Private GCP placements share one image and `PrivateGcpDeployment`; follow `deployment-standard.md`'s hosting-authority contract. Hosted custody is not user-owned cloud; its explicit dev inference binding neither widens the BYOC bridge nor qualifies admission.
6. For Computer Use, read `consent-protocol/docs/reference/private-browser-runtime.md`. One and Browser share the owner container. Qualify the exact host/image and trusted Chromium mode (GCP enabled; Azure Container Apps explicitly disabled), native model transport, owner authority, lifecycle and ephemeral-screen handling before activation. Do not claim Browser-to-One containment, silently change execution mode or create a second approval ledger.
7. Browser PKM selection requires independent model-processing and website-disclosure consent. Use the existing scoped-export and action-ledger ports; keep remembered sign-in state outside ADK context. The browser runtime reference owns manual login, Forget and recovery restrictions.
8. Scheduled pod work keeps the sealed recovery log and existing effect owner authoritative. Native task checkpoints and pending calls stay in that same sealed journal, never chat-key/shared session storage. Construct native task mode with its owned output schema; validate the matching finish call/response, and never let a model summary settle a pending or uncertain effect. Freeze the sealed AI choice and destination for restart; process-local cache counters are not durable identity. Retain original invocation and confirmation markers; exact ledger approval remains mandatory and uncertain dispatch cannot resume. Read the Scheduled tasks section of `docs/reference/operations/private-files-library.md`; bind approved revisions, current owner/incarnation and authorization expiry. Identifier-only due-time delivery is not model inference. Refuse unqualified cloud timers and uncertain-effect replay.
9. Native pod Google grants require exact project/account lifecycle handling: confirm project-wide revocation before fresh authorization, then remove fenced legacy hub credentials without revoking the new grant. Connector credentials, tool reviews and notification work keep their existing owners; metadata feeds cannot carry private observations. Read the dev pod runbook for notification checkpoint and native-client prerequisites.

9. Private command and MCP recovery must retain original expiry, exact owner/pod authority and dispatch-before-effect journals. Read the streaming implementation guide before changing those adapters; native resume must not replay a user turn or revive an uncertain effect.

Files retains one authored specialist across placements. Review the
[Files storage/processing boundary](../../../docs/reference/operations/private-files-library.md#shared-files--dev-pilot-partial-live-acceptance)
before changing its tool ports: Shared receives a selected foreground projection;
pod execution keeps its own admitted storage and background authority. Generated
registries never substitute for either boundary's live acceptance.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `backend`.
2. If the task becomes service/runtime boundary work, use `backend-runtime-governance`.
3. If the task becomes trust or consent enforcement work, use `security-audit`.

## Required Checks

```bash
cd consent-protocol && uv run pytest tests/agents -q
cd consent-protocol && uv run pytest tests/test_hushh_adk_foundation.py -q
cd consent-protocol && uv run python scripts/verify_agent_hierarchy_contract.py
```

# One Voice Review Checklist

Use this when reviewing One Voice, Kai compatibility runtime, or typed-search changes.

## Capability Authoring

- Does each new discoverable capability have a local `.voice-action-contract.json` entry?
- Is the `action_id` stable and reused across voice, search, and UI actionables?
- Does every action declare `speaker_persona` as `one`, `kai`, `nav`, or `kyc`?
- Does every One-framed action executed by a specialist declare a wired runtime `delegate_agent_id` such as `agent_location`, `agent_connections`, `agent_email`, `agent_personal_information`, or `agent_connected_systems` while keeping `speaker_persona` public-safe?
- Do specialist-turn actions use the shared `specialist_chat.turn` runner instead of route-only voice contracts or provider-side tool execution?
- Are ordinary navigation actions under `route.*`, with `nav.*` reserved for true Nav guardian actions?
- Are `control_ids` present for UI affordances that should map back to the action?

## Workflow And Gating

- If the action needs prerequisites, is the workflow explicitly authored?
- Does each workflow step have a clear settlement target or an intentional reason not to?
- Are persona, workspace, vault, auth, consent, and onboarding constraints modeled centrally?
- Is speaker persona treated as copy/prompt ownership rather than authority?
- Does an earned-but-inactive workspace require ask-before-switch?
- Does a locked capability block and guide instead of pretending to execute?

## Runtime Boundary

- Which existing voice runtime surfaces does this PR extend: generated gateway, manifest, realtime client, turn orchestrator, shared dispatcher, console sheet, backend voice intent, or voice tests?
- Is this a new input adapter over the current runtime, or is it creating a parallel voice system?
- Does runtime surface metadata describe current state rather than invent capabilities?
- Does the generated gateway remain the shared semantic authority?
- Is transcript fallback still only a compatibility path rather than the primary discoverability mechanism?
- If the PR uses browser SpeechRecognition or MCP tools, does it still preserve action gateway parity, settlement, gating, and telemetry?
- If Gemini Live or another realtime provider emits tool/function calls, does the relay acknowledge each call without executing provider-side?
- Do provider proposals enter One Goal/generated gateway validation before any action, A2A delegation, route settlement, or result speech?
- Are low-confidence provider proposals omitted from planning/orchestration so generated contract inference or ordinary conversation handles the turn instead?
- Do read-only specialist turns run directly only when the generated policy is `allow_direct`, and do directive/prompt results hand off to Agent Chat with the existing specialist card payload?
- Do write-like specialist turns use `confirm_required`, consent, or card-mediated execution before mutation?

## Memory Boundary

- Is short-term memory still in-memory only?
- Is durable voice memory vault-gated?
- Is durable storage encrypted client-side?
- Is plaintext browser storage avoided?
- Are sensitive summaries rejected?
- Are inferred PKM-worthy facts routed to preview/review instead of direct save?
- Are explicit "remember this" requests still confirmed through the PKM/vault path before persistence?

## Verification

- `npm run build:voice-gateway`
- `npm run verify:voice-gateway`
- targeted voice tests
- One intelligence eval cases for proposals, chained goals, memory candidates, and sensitive-information rejection
- backend voice contract test when shared semantics changed

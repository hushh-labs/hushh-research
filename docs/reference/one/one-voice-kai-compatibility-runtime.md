# One Voice Kai Compatibility Runtime

## Visual Context

This is the compatibility boundary beneath the [One Reference Index](./README.md)
and [One Voice Runtime Architecture](./one-voice-runtime-architecture.md).

## Purpose

One is the product-facing private agent. Kai is the finance specialist that
One may summon. Some generated contract and frontend filenames retain `kai`
for compatibility, but that identifier is not a second voice planner or a
second execution authority.

## Current Runtime Boundary

- In-bar live voice runs through `WS /api/one/adk/live` and One's ADK
  `Runner.run_live` relay in `consent-protocol/api/routes/one/adk_live.py`.
- Typed private-agent chat uses `consent-protocol/api/routes/kai/agent_chat.py`
  as a compatibility route into the same One semantic and generated-action
  boundary.
- Authored `*.voice-action-contract.json` files generate the shared
  `contracts/kai/kai-action-gateway.vnext.json`. That artifact is the only
  executable action inventory for Agent Bar, voice, Search, and command
  surfaces.
- `hushh-webapp/lib/voice/kai-action-gateway.ts` keeps the compatibility name
  while validating generated actions; it does not infer executable actions from
  route text or the DOM.
- `hushh_mcp/one_adk/action_tools.py` validates generated action policy and
  parks directives. The browser executes a directive and sends a correlated
  settlement before One can describe the outcome.

## Invariants

1. One is the only semantic decision-maker for a live or typed turn.
2. A generated `action_id`, not a model suggestion, is the only action
   authority.
3. Kai remains bounded to finance. Nav owns consent, vault, deletion, and
   scope review; KYC owns identity and verification.
4. The browser publishes only redacted route/surface context. Vault keys,
   credentials, PKM payloads, and raw page text are not model context.
5. Gmail is a dormant child of Connections and has no active One, voice,
   Search, or generated-discovery action.

## Migration Rule

Do not restore deleted Kai-era planner, composer, or client-side action runtime
modules as a fallback. Extend One's ADK relay, the generated action gateway,
and the governed browser settlement path. Preserve literal `kai` identifiers
only where an existing route, contract, or package must remain compatible.

## References

- [One Voice Runtime Architecture](./one-voice-runtime-architecture.md)
- [One Agent Hierarchy](./one-agent-hierarchy.md)
- [Kai Action Gateway vNext](../kai/kai-action-gateway-vnext.md)
- [Generated action gateway](../../../contracts/kai/kai-action-gateway.vnext.json)

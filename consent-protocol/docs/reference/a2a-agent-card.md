# A2A discovery card — `/.well-known/agent-card.json` (marketplace step 1)

**Status:** in pursuit, dev-branch only, feature-flagged **OFF**
(`A2A_AGENT_CARD_ENABLED`, default off). With the flag off the standard well-known
path returns **404** — the existing release gate is preserved.

## Visual Context

Canonical visual owner: [consent-protocol reference index](./README.md).

## Why

The founder directive is that 🤫 Agent One service agents be **deployable on external
agent marketplaces** (Google Agentspace / Vertex Agent Builder) and discoverable
agent-to-agent. The single prerequisite every A2A-based marketplace needs is a
**conformant Agent Card served at the standard discovery path**
`/.well-known/agent-card.json`. Today that path is intentionally 404 and the only
card (`/api/one/a2a/card`) is a non-standard `hussh.one.invocation-preview.v1` shape.

## What this ships

- A flag-gated `GET /.well-known/agent-card.json` on `well_known_router` that, when
  enabled, returns a **conformant A2A v1 AgentCard** — `protocolVersion`, `name`,
  `description`, `version`, `url`, `preferredTransport`, `provider`, `capabilities`,
  `defaultInputModes`/`defaultOutputModes`, `skills`, `securitySchemes`, `security`.
- It is **re-projected from the existing `_agent_card`** (same skills, provider, and
  security), so the discovery document never drifts from the invocation-preview card.

## Honesty (no overclaiming)

The card is a valid **discovery** document; it does **not** claim full A2A v1 Tasks
conformance. The current transport (`HTTP+JSON` invocation-preview, `officialA2A:
false`) is declared truthfully via a **capability extension**
(`https://hushh.ai/a2a/ext/invocation-preview/v1`) carrying the contract id and the
release-blocker note. A marketplace or peer agent reads an honest description of the
agent, its skills, and how to reach it — nothing we do not actually serve.

## Enabling (dev only)

`A2A_AGENT_CARD_ENABLED=1`. The card is public (no auth), as agent cards are meant to
be; it exposes only names, capabilities, skills, and security *schemes* — never
credentials.

## Honest limitations / next steps

- **Discovery, not full A2A v1 Tasks.** The official ADK A2A transport
  (`hushh_mcp/adk_bridge/official_a2a.py`, `to_a2a`) exists but is opt-in and pinned
  to `a2a-sdk < 0.4` until ADK-compatible; upgrading + flipping it on is the path to
  full-Tasks conformance.
- **Marketplace listing needs more than a card:** a Vertex/Agentspace deploy adapter
  (a `ComputeBackend` that renders an Agent Engine resource rather than Cloud Run) and
  a **cross-tenant consent/identity bridge** (OAuth2/OIDC client registration mapping
  marketplace callers to `cap.one.invoke` / HCT) — the consent-first wedge that makes
  a 🤫 agent safely callable by strangers. Both are scoped follow-ups.

Posture stays **"in pursuit"** — real in code, never presented as a shipped
marketplace listing until it is one.

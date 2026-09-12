# Gemini Runtime Configuration

## Visual Context

This is the AI access configuration boundary beneath the
[One Reference Index](./README.md), [One Agent Hierarchy](./one-agent-hierarchy.md), and the
[One Voice Runtime Architecture](./one-voice-runtime-architecture.md).

## Current Contract

AI access owns private runtime configuration, not an additional One
specialist. It appears before feature setup at `/one/setup/connections` and
can be reopened at `/one/connect/settings`. It is not a `/one` dashboard tile and
does not publish a voice or Search action.

| Mode | User input | Storage | User-facing scope |
| --- | --- | --- | --- |
| `hushh_managed_vertex` | None | No user secret | Typed private-agent turns and Location commands through Hussh workload identity |
| `byok` | Google AI Studio Gemini API key or Google Cloud Vertex API key with project and location | Encrypted PKM only | Typed private-agent turns; command recording uses the managed provider |

The key transport is explicit: `developer_api` uses the Google AI Studio
endpoint, while `vertex_api_key` uses the Google Cloud Vertex endpoint and
requires a project and location. A key is never classified from its shape.
Google OAuth is intentionally not presented as an active setup choice yet: the
current server-run ADK provider seam has no approved Developer API OAuth
transport or configured Google OAuth client. It must not be represented as a
working route until both are in place. Service-account JSON is not accepted. Existing encrypted
Gemini configuration remains readable after the UI move from Profile; legacy
BYOK values default to `developer_api`, so no storage migration is required.

### Fleet text model switch (2026-09-02)

Every text agent manifest names the alias `gemini-default`; the alias resolves to
`constants.GEMINI_MODEL`, which reads `HUSSH_GEMINI_TEXT_MODEL` (deploy substitution
`_HUSSH_GEMINI_TEXT_MODEL`) and falls back to `FLEET_TEXT_MODEL_DEFAULT`. One value moves
the whole fleet; a lane may flip it only after its project's Vertex
`constraints/vertexai.allowedModels` policy admits the id. UAT runs `gemini-3.8-flash`
(admitted in `hushh-pda-uat` on 2026-09-02); production stays on the default until its
allowlist changes. Every text agent, including the memory chain and the summary reducer, names the alias
(founder directive 2026-09-02: the fleet runs Flash, 3.8 preferred, 3.7 next, 3.6 worst
case, and never `gemini-3.1-pro-preview`). The Live head is retired.
`tests/test_fleet_text_model_switch.py` refuses any manifest that pins a Flash generation.

### Knobs removed as valueless (2026-09-02)

There is one name for the fleet text model and one way to override it. These were
removed because each was either an alias of `GEMINI_MODEL` or an environment key no
lane set, and every one of them implied a choice that did not exist:

| Removed | Why |
|---|---|
| `GEMINI_MODEL_VERTEX` | Always equal to `GEMINI_MODEL`; the name implied a separate Vertex model. |
| `KAI_PORTFOLIO_IMPORT_PRIMARY_MODEL` | Same value again, under a third name. |
| `KAI_PORTFOLIO_IMPORT_MODEL` (env) | Read by the portfolio route, set by no lane. |
| `AGENT_ONE_SPECIALIST_MODEL` (env) | Set by no lane, and it froze the specialist model at import. |
| `GMAIL_RECEIPT_LLM_MODEL` (env) | Pinned `gemini-2.5-flash-lite` in the local env, quietly outside the Flash-only rule. |
| `KAI_RECEIPT_MEMORY_LLM_MODEL` (env) | Read by the receipt memory service, set by no lane. |

Removing them is behaviour-preserving in every deployed lane, because no lane set any of
them. Locally, Gmail receipt extraction moves off the pinned 2.5 generation and onto the
fleet model like everything else.

### Who chooses the model (2026-09-02)

The environment names a default, never the only possibility. A turn resolves its model
at call time through `hushh_mcp/services/model_preference_service.py`, highest tier first:

1. **the person's own choice** — `one_model_preferences` (migration 196), set from Agent
   chat (`set_preferred_model`) or `PUT /api/one/models/preference`, and validated against
   the served catalog on write;
2. **the lane default** — `HUSSH_GEMINI_TEXT_MODEL`, read by module attribute rather than
   copied into any consumer;
3. **`FLEET_TEXT_MODEL_DEFAULT`** — 3.8 Flash. Every lane that can serve it runs it;
   production pins 3.7 in its workflow until its allowed-models policy admits 3.8.

The catalog of choices lives in `hushh_mcp/runtime_providers/model_catalog.py` and is
derived from the provider registry, so adding a generation is one registry row plus one
entry in `FLEET_TEXT_MODEL_CHOICES`; no client release and no browser environment variable
is involved. `GET /api/one/models/preference` serves the list, what the person chose, and
what is actually running.

Two failure rules keep a preference from ever costing a turn: a choice that outlived its
catalog entry degrades to the lane default (and stays visible so a surface can explain
it), and an unreachable preference store resolves to the lane default rather than raising.
A change takes effect on the person's next message; nothing is redeployed and no other
person is affected.

## Lifecycle

1. A person chooses managed Gemini or BYOK in AI access.
2. During setup, a BYOK credential is held only in process memory. A refresh,
   lock, sign-out, or account deletion clears it.
3. The backend performs a bounded probe against the selected Google endpoint
   without storing the credential.
4. Finish setup is the only durable boundary: it requires the canonical vault
   create/unlock flow, encrypts every staged setup draft, and only then writes
   the key into
   `pkm:runtime_secrets.llm.gemini_api_key`, the selected mode at
   `pkm:runtime_secrets.llm.credential_mode`, and endpoint metadata in
   encrypted runtime configuration references.
5. Typed private-agent turns resolve the current unlocked-vault key only for
   that request through the existing provider factory.
6. Location command recording uses the managed provider for two bounded ordinary
   model requests: audio transcription, then structured semantic planning. It
   never creates a Live session or sends generated speech.
7. Vault lock, owner changes or backgrounding cancel capture and pause the local
   command controller. Persisted continuation requires owner authentication,
   vault unlock, revalidation and explicit Resume within 24 hours.

Credentials never appear in URLs, browser storage, native preferences, command
capsules, action contracts, logs, telemetry or model prompts. Typed access keeps
its existing request-scoped provider resolution; command models receive only
sanitized current context and proposed inputs, without effect tools.

The managed command path resolves the configured non-Live model through the
provider factory. Verify exact-model audio and structured-output access in the
release environment. Authentication or quota failure produces an error card;
it cannot fall back to Live or report an operation completed.

## Retired Live compatibility

The previous Live registry, Developer API key and UAT rollback settings are
historical configuration. Live websocket and relay-token endpoints return
explicit retirement responses. Transport compatibility constructors fail before
networking. BYOK typed turns remain supported; no BYOK or managed Live session
is available from app entrypoints.

## Non-goals

- BYOK does not power CRM mapping, portfolio ingestion, consent execution, or
  other Hussh-operated background workflows in v1.
- The AI access surface never reads or receives the key after staging it for
  encrypted storage.
- Gmail is a disabled child of `agent_connections`; it remains a dormant route
  and manifest but is absent from One, voice, Search, and generated discovery.

## References

- [Google Gemini API key guidance](https://ai.google.dev/gemini-api/docs/api-key)
- [Google Cloud Vertex API-key guidance](https://cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys)
- [One Voice Runtime Architecture](./one-voice-runtime-architecture.md)
- [Personal Knowledge Model](../../../consent-protocol/docs/reference/personal-knowledge-model.md)

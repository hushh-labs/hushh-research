# Gemini Runtime Configuration

## Visual Context

This is the Connections-owned configuration boundary beneath the
[One Reference Index](./README.md), [One Agent Hierarchy](./one-agent-hierarchy.md), and the
[One Voice Runtime Architecture](./one-voice-runtime-architecture.md).

## Current Contract

Connections owns private runtime configuration, not an additional One
specialist. It appears before feature setup at `/one/setup/connections` and
can be reopened at `/one/connect/settings`. It is not a `/one` dashboard tile and
does not publish a voice or Search action.

| Mode | User input | Storage | User-facing scope |
| --- | --- | --- | --- |
| `hushh_managed_vertex` | None | No user secret | Default typed and live private-agent experience through Hussh workload identity |
| `byok` | Google AI Studio Gemini API key or Google Cloud Vertex API key with project and location | Encrypted PKM only | Typed private-agent turns; Live is an explicit, separately gated compatibility path |

The key transport is explicit: `developer_api` uses the Google AI Studio
endpoint, while `vertex_api_key` uses the Google Cloud Vertex endpoint and
requires a project and location. A key is never classified from its shape.
OAuth grants and service-account JSON are not accepted. Existing encrypted
Gemini configuration remains readable after the UI move from Profile; legacy
BYOK values default to `developer_api`, so no storage migration is required.

## Lifecycle

1. A person chooses managed Gemini or BYOK in Connections.
2. BYOK opens the canonical vault create/unlock flow.
3. The backend performs a bounded probe against the selected Google endpoint
   before the browser encrypts the key into
   `pkm:runtime_secrets.llm.gemini_api_key`, the selected mode at
   `pkm:runtime_secrets.llm.credential_mode`, and endpoint metadata in
   encrypted runtime configuration references.
4. Typed private-agent turns resolve the current unlocked-vault key only for
   that request through the existing provider factory.
5. Live voice sends its mode and, only for BYOK, the current key in the first
   authenticated WebSocket frame. The relay creates a connection-local runner
   and immediately drops the raw reference.
6. Key removal, mode change, vault lock, backgrounding, or reconnect closes a
   BYOK voice session. The next session must resolve configuration again.

The value never appears in a URL, relay ticket, browser storage, native
preferences, Postgres, logs, telemetry, action contracts, or model prompts.

## Live Compatibility Registry

Hussh-managed Vertex remains the default. BYOK Live is disabled unless an
operator explicitly enables a registry-approved model after an ADK UAT
rehearsal. `gemini-2.5-flash-live-preview` is the current candidate because it
supports the relay's mid-session client-content updates. Gemini 3.1 Live is
not eligible: its current contract limits `send_client_content` to initial
history, while One needs later route-state and action-settlement updates.

Google Cloud Vertex API-key BYOK is available for typed turns. It is not yet a
voice-compatible transport, so the app keeps it out of the live relay and
offers managed Gemini for voice until a separate Vertex Live rehearsal approves
an exact model and endpoint contract.

Invalid, quota-limited, or unsupported BYOK Live never falls back silently.
The user receives a safe managed-Gemini alternative. The generated action
authority, consent checks, directives, and browser settlement path remain the
same in both modes.

## Non-goals

- BYOK does not power CRM mapping, portfolio ingestion, consent execution, or
  other Hussh-operated background workflows in v1.
- Connections the agent never reads or receives the key.
- Gmail is a disabled child of `agent_connections`; it remains a dormant route
  and manifest but is absent from One, voice, Search, and generated discovery.

## References

- [Google Gemini API key guidance](https://ai.google.dev/gemini-api/docs/api-key)
- [Google Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [Google Cloud Vertex API-key guidance](https://cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys)
- [One Voice Runtime Architecture](./one-voice-runtime-architecture.md)
- [Personal Knowledge Model](../../../consent-protocol/docs/reference/personal-knowledge-model.md)

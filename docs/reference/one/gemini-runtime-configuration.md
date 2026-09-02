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
| `hushh_managed_vertex` | None | No user secret | Default typed and live private-agent experience through Hussh workload identity |
| `byok` | Google AI Studio Gemini API key or Google Cloud Vertex API key with project and location | Encrypted PKM only | Typed private-agent turns; Live is an explicit, separately gated compatibility path |

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
allowlist changes. Deliberate pins stay explicit in their manifests: the memory chain on
`gemini-3.1-pro-preview`, the reducer on `gemini-3.1-flash-lite`, and the Live head.
`tests/test_fleet_text_model_switch.py` refuses any manifest that pins a Flash generation.

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
6. Live voice sends its mode and, only for BYOK, the current key in the first
   authenticated WebSocket frame. The relay creates a connection-local runner
   and immediately drops the raw reference.
7. Key removal, mode change, vault lock, backgrounding, or reconnect closes a
   BYOK voice session. The next session must resolve configuration again.

The value never appears in a URL, relay ticket, browser storage, native
preferences, Postgres, logs, telemetry, action contracts, or model prompts.

The bounded credential/readiness probe uses the same manifest-owned
`gemini-3.7-flash` model as normal typed private-agent reasoning. Successful
setup therefore proves authentication, exact-model access, billing/quota
availability, and one minimal generation before a key can be saved. Managed
voice uses `gemini-3.1-flash-live-preview` over the Gemini Developer API with
the Hussh-managed live key (`HUSHH_MANAGED_GEMINI_LIVE_API_KEY`); the model is
not published on Vertex, and `gemini-live-2.5-flash-native-audio` (GA, Vertex)
remains the declared rollback via `AGENT_ONE_ADK_MODEL`. No standalone TTS
fallback is configured.

UAT currently activates that rehearsed Vertex rollback in the governed deploy
workflow. This keeps Agent Bar voice available when the separate Gemini
Developer API prepaid-credit pool is depleted; production retains the authored
canonical model unless its own release workflow explicitly selects a rollback.

Gemini 3.7 text requests use the global Vertex endpoint and omit legacy
sampling controls. The runtime retains `thinking_level` for bounded reasoning;
it does not send `temperature`, `top_p`, `top_k`, `candidate_count`, or
`thinking_budget` to 3.7.

## Live Compatibility Registry

Hussh-managed credentials remain the default. BYOK Live is disabled unless an
operator explicitly enables a registry-approved model after an ADK UAT
rehearsal. `gemini-3.1-flash-live-preview` is the canonical registry entry: the
2026-08-21 ADK rehearsal verified that the relay's later route-state and
action-settlement updates reach it mid-session — google-adk transposes each
single-text-part `send_content` into `send_realtime_input(text=...)` on Gemini
3.x Live names, and the rehearsal additionally confirmed mid-session
`send_client_content` is honored on the current preview build.
`gemini-2.5-flash-live-preview` and `gemini-live-2.5-flash-native-audio` stay
registry-approved as client-content-channel models.

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
- The AI access surface never reads or receives the key after staging it for
  encrypted storage.
- Gmail is a disabled child of `agent_connections`; it remains a dormant route
  and manifest but is absent from One, voice, Search, and generated discovery.

## References

- [Google Gemini API key guidance](https://ai.google.dev/gemini-api/docs/api-key)
- [Google Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [Google Cloud Vertex API-key guidance](https://cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys)
- [One Voice Runtime Architecture](./one-voice-runtime-architecture.md)
- [Personal Knowledge Model](../../../consent-protocol/docs/reference/personal-knowledge-model.md)

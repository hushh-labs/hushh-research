# One Live Voice: why Gemini Live returns, and under what contract (2026-09)

Status: implemented behind `ONE_VOICE_LIVE_ENABLED`; UAT first, production dark until UAT sign-off.

## Visual Context

This decision extends the runtime described in [one-voice-runtime-architecture.md](./one-voice-runtime-architecture.md) and the platform map in [../architecture/architecture.md](../architecture/architecture.md). The Live adapter's own flow is drawn in [one-voice-live-tool-contract.md](./one-voice-live-tool-contract.md).

## The decision

PR #6617 (2026-09-12) retired the Gemini Live path. Two things drove it: the canonical Live model was not served on Vertex, so Live ran on a prepaid Developer-API key pool that depleted (the 2026-08-20 billing denial is memorialised in `hushh_mcp/runtime_providers/dependency_health.py`), and the product wanted bounded, checkpointed, receipted commands.

One Live Voice brings Live back with those two causes removed, not ignored:

- **Cost/availability:** Vertex AI with Application Default Credentials only. There is no API key, no prepaid pool, no browser credential. The SDK's ephemeral browser tokens are Developer-API-only, so the only ADC-compatible topology is a server-side relay, and that is the only topology built.
- **Bounded, receipted actions:** the model interprets speech; it cannot read or change state. Every read and mutation is a typed tool bound to a generated gateway action id, confirmed by the person before it runs (spoken confirmation for reversible actions after the card is shown, a tap receipt for destructive or sensitive ones), and narrated only from the tool's result.

## Premise verification (AGENTS.md gate)

| Capability | Classification | Where it lives now |
|---|---|---|
| Gemini Live bidirectional audio via server relay on Vertex ADC | missing (deliberately retired) | `api/routes/one/voice.py`, `hushh_mcp/one_voice/session.py`, `factory.build_live_client` |
| Single-use relay tickets | partially existed (nonce table 084; module deleted) | `hushh_mcp/one_voice/tickets.py`, fail-closed |
| Typed server tool layer as the only path to state | partially existed (`one_adk/action_tools.py`, `location_command_execution.py`) | `hushh_mcp/one_voice/tools/*`, 57 tools bound to gateway ids |
| Account-level sharing on/off | missing | migration 221 `one_location_account_settings`; write paths enforce `off` |
| Approximate precision | missing (server preference; client-enforced) | same table; envelope `metadata.precision` tag; client coarsens before encryption |
| Ask-for-location, check-in, circles, links, map, settings | already existed | wrapped by tools |
| Save My Soul | existed as review-only voice action | tap-armed tool; "sent" only after server-verified envelopes |
| Ratings | existed (cohort-gated place ratings only) | read tool; unsupported outside the cohort; no person ratings |
| Display-name change | missing (Firebase-owned) | `ActorIdentityService.update_display_name` + `PATCH /api/account/identity/display-name` |
| Pending-action store | missing for this surface | migration 222 `one_voice_pending_actions` (tier, hashed receipt, one open per conversation) |
| Location setup progress | existed for the legacy workflow (migration 210) | new minimal table 223 for the voice-first flow, by product instruction; the 210 runtime retires with the legacy hub |

## Governance reconciliation

- **AGENTS.md "no second decision-maker":** every tool the Live model can call is a generated gateway action id; the relay never picks actions, never rewrites arguments, never classifies transcripts. The host validates ids, schemas and authority and returns typed refusals the model must read back.
- **AGENTS.md "host code must not decide/discard/skip on a successful model call":** two authority guards are declared. (1) The pending-confirmation gate: a mutation tool call does not execute until the person confirms. (2) The narration guard: a turn that attempted a mutation which was rejected or left pending and produced no successful result is *recorded* (`narration_without_receipt`); nothing is muted or rewritten, and no lexical rule runs at runtime.
- **one-voice-governance §9 (new microphone inputs):** One Live Voice is an approved input adapter over the existing gateway path. It adds no parallel action catalog. The derived projection `contracts/kai/one-voice-live-tools.v1.json` is generated from the tool registry and checked in CI.
- **Aliases:** gateway `aliases` are retrieval hints for typed search, never ids. The Live tool projection omits them; the registry's Live model entry has none; no manifest names the Live model (it is read once from `VERTEX_LIVE_MODEL_ID`).
- **Confirmation policy:** the product spec uses spoken confirmation ("Is that who you mean?" → "Yes"). Voice-tier confirmations are accepted only for reversible actions and only after the card was shown; tap receipts are mandatory for destructive or sensitive actions (turning sharing off, stopping shares, deleting or leaving circles, revoking links, Save My Soul, removing contacts/connections, changing the display name, discoverability, setup consent).
- **Non-negotiables:** the backend stays ciphertext-only (precision is a preference; the relay never receives coordinates); capability tokens and PCHP apply (vault-owner token on the socket, Firebase proof for people/profile tools); components never call `fetch()` (the socket lives in `lib/one-voice`); credentials are memory-only; secrets are env/ADC only.

## One flag

`ONE_VOICE_LIVE_ENABLED` is read at request time. Off means: readiness reports `disabled`, session minting returns 404, the socket closes before any provider client is constructed, and the app keeps the bounded command runtime. It is the kill switch.

## Honest limits the app says out loud

- "I can only invite people who already use Hussh. There's no text-message invite."
- "I've opened Save My Soul. Tap Confirm on the card to send." — and after a verified publish, "Sent to <names>; <names> couldn't be reached."
- "I've set your sharing to approximate on this device."
- "Ratings here are only for places, and they're anonymous. I can't rate a person."
- "Your Hussh name is now X."
- "Sharing is off. I stopped your active shares and links."
- "Voice is unavailable right now. You can keep typing to One."

## Follow-up deletion (after the flag is on everywhere)

`components/agent/location-command-provider.tsx`, `command-agent-bar.tsx`, `lib/agent/location-command-runtime.ts`, `lib/voice/command-capture.ts` and its worklet, `POST /api/one/transcriptions` and `LocationCommandBrain.transcribe`, `components/one-location/redesign/*` and the legacy hub page, the migration-210 onboarding runtime, the `gemini-live-client.ts` stub and its test, `OneVoicePrivacyContract.v1.json`, and the old-owner assertions in the single-owner contract test. The `/api/one/adk/*` retirement responders stay one more app version.

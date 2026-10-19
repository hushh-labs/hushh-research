# People calling

Status: disabled mentor-review implementation on the private-pod development line.
This does not complete the agreed E2EE messages/native calling release.

## Visual Map

```mermaid
flowchart LR
    UI[Messages phone control] --> Device[Existing trusted-device signing authority]
    Device --> API[Participant call commands]
    API --> DB[Durable busy slots and answer CAS]
    UI --> Verify[Compare endpoint security codes]
    Verify --> RTC[Fresh WebRTC DTLS-SRTP connection]
    RTC --> TURN[Environment-specific encrypted media relay]
    RTC --> Peer[Verified peer device]
```

## Implemented boundary

The `/one/messages` phone control attaches to `DirectCallSession`, the existing
platform-aware API transport and the hub `one/calls.py` router. Web uses the
existing `/api/one/[...path]` proxy. No second signaling service, account registry
or agent router is introduced. No audio or plaintext SDP reaches the backend.

Preparation reserves durable account slots before microphone permission. Only a
complete encrypted offer rings the recipient. A revision compare-and-set selects
one answering device; losing devices cannot receive later signals or credentials.
Both endpoints must report transport connection before the backend marks a call
active. The browser displays Connected from its actual peer connection.

Each command binds owner, operation, device, nonce, expiration and the SHA-256 of
canonical payload bytes through registered-device ECDSA. Proofs expire within
120 seconds; consumed nonces cannot replay. Active relationship, both-direction
block and device-revocation checks gate signaling and credentials. End remains
available after a block/disconnect. Canonical graph locks precede call/device
locks; busy admission, state, signals and proof consumption share transactions.

The existing rate limiter permits 180 commands/minute. Without a shared limiter
URI, this remains process-local; it is not distributed quota or capacity proof.

## Encryption and verification

Purpose-separated, nonextractable P-256 encryption handles live beside the
existing installation signing key. They are not shared Circle keys or vault keys.
Public enrollment bindings are signed by the canonical device identity. A
mismatched existing key cannot silently be replaced and strand ciphertext.

SDP uses RFC 9180 HPKE through pinned `@hpke/core` 1.9.0: DHKEM(P-256,
HKDF-SHA256), HKDF-SHA256 and AES-256-GCM. Every envelope uses a fresh single-shot
sender context. This version is beyond the affected range in
[CVE-2025-64767](https://github.com/dajiaji/hpke-js/security/advisories/GHSA-73g8-5h73-26h4).
No custom ratchet is introduced.

Signatures cover exact ciphertext and recipient key IDs. Authenticated encryption
binds call, conversation, both devices, description kind and sequence. Each party
anchors its actual local encryption/signing tuple, then compares the two winning
endpoints' security code over a trusted independent channel. A directory-only
fingerprint would not protect against directory substitution. Verification is
remembered only for that endpoint pair in the current browser UI session. iOS
stores bounded public verified-pair fingerprints in its owner-bound calling
Keychain record so a previously verified pair can answer while locked.

Media uses a new peer connection per call and standard DTLS-SRTP. Only relay ICE
candidates are accepted. Signed/encrypted SDP fingerprints are verified before
remote descriptions are used. TURN forwards ciphertext; it never terminates media
or performs inference. See [WebRTC security architecture](https://www.rfc-editor.org/rfc/rfc8827.html).

## Lifetime and maintenance

Browser calls acquire the existing exclusive foreground voice lease. Late permission,
playback and HTTP results cannot restart or overwrite superseded calls.
Microphone loss, lease revocation, backgrounding, page exit, hangup and owner
teardown stop tracks/audio locally without waiting for HTTP cleanup. One modal
owns call/verification state. Verification is the top Back layer; failures are
visible and announced.

## iOS native calling

`CallingCoordinator` owns call lifetime from application launch, independently of
React. The Capacitor adapter exposes intents and public state only. Swift-native
signing/agreement keys enroll as a purpose-separated iOS installation through the
existing trusted-device authority; browser IndexedDB private keys are never
exported or silently replaced. Physical devices use Secure Enclave P-256 keys;
the simulator uses synthetic/software P-256 keys. The dedicated calling Keychain
record is environment/owner bound and uses `AfterFirstUnlockThisDeviceOnly`.
Before the first unlock after reboot, calling fails closed. Vault and PKM key
accessibility is unchanged.

Native CryptoKit uses the same HPKE suite, canonical command proofs, DER SPKI and
DER signatures as web. CI compiles the actual native wire source and exchanges
synthetic encrypted offers and signatures in both directions with browser code.
The app pins WebRTC 149.0.0 at `ff4647dc67f00d037c199c69e1a1ee8ceda88236`;
the binary checksum is
`79c5a3e49a68de30a99baabaf5b4c0067dd7a0b66fdd4b8afb8ec337e746abba`.
Its exact BSD license is bundled with the app.

PushKit and CallKit are initialized outside the WebView. Incoming pushes report
promptly to CallKit, then fetch authenticated canonical state before answering.
Only opaque call/device/key identifiers and the deadline travel in the push.
First/new-key calls require foreground security-code comparison; a push never
grants trust. Native WebRTC permits relay candidates only, waits for the actual
DTLS peer connection, and keeps audio disabled until peer verification and
CallKit audio activation. Native calls and One Voice share microphone ownership.
Native UI intents and comparison results bind the exact call identifier; delayed
actions cannot affect a replacement call. App and system mute actions share the
CallKit transaction and its UUID-fenced callback. First-conversation changes
refresh Messages through its existing owner-scoped domain event.
Navigation/backgrounding preserves native calls; terminal state, owner changes,
revocation, negotiation timeout and prolonged disconnect stop local media.
Cold recovery ends an orphaned call only when this installation was its selected
endpoint; ephemeral DTLS media is never silently resumed or assigned to another
device. This releases abandoned busy admission before a person starts a new call.

PushKit tokens are distinct from ordinary FCM tokens. Signed registration binds
an active iOS trusted device and communication key. The server selects the APNs
topic/environment; a mismatched Debug sandbox/Release production build is
rejected. Token reuse transfers ownership to one installation. Token invalidation
removes registration; normal native sign-out stops media/PushKit immediately and
attempts authenticated unregister for at most two seconds before Firebase
sign-out. Offline cleanup can fail; revocation and local owner checks still fence
audio, and invalid-token provider responses remove stale registrations.

The offer-to-ringing transaction also creates a durable push outbox. Dispatch
rechecks relationship, blocks, caller and exact target device, token generation,
deadline and ringing state under the existing lock order. APNs provider authorization tokens are reused
for 40 minutes, delivery retries are bounded, and no update/cancellation-only
VoIP pushes are sent. Telemetry suppresses HTTP instrumentation and redacts APNs
device paths. Aggregate provider acceptance is not device-delivery proof.

APNs provider configuration is server-only: `DIRECT_CALLS_APNS_TEAM_ID`,
`DIRECT_CALLS_APNS_KEY_ID`, `DIRECT_CALLS_APNS_PRIVATE_KEY`,
`DIRECT_CALLS_APNS_BUNDLE_ID`, and `DIRECT_CALLS_APNS_ENVIRONMENT`
(`sandbox` or `production`). iOS capability additionally requires
`DIRECT_CALLS_VOIP_WORKER_QUALIFIED=1` and valid provider configuration. No keys,
provisioning profiles, secrets or deployment flags are installed by this PR.
Supervise the retry worker in the same environment/backend authority:

```bash
cd consent-protocol
python -m hushh_mcp.services.direct_call_voip --watch
```

Post-offer delivery retries are also triggered in the backend threadpool; the
supervised worker recovers the commit-to-background-task crash window. Qualify
its restart behavior and APNs receipt before enabling the native capability.
Physical two-account iPhone foreground/background/locked/cold answer,
interruption, logout, changed keys, revocation and relay failure remain required;
an Xcode/simulator pass cannot establish those outcomes.

Preparation/ringing expires after 45 seconds. Calls and opaque relay credentials
have an absolute one-hour maximum from creation. Credentials remain memory-only;
the deployment TURN secret never reaches clients. Real allocation expiry and
long-call behavior require independent relay qualification.

Terminal actions erase offers/proofs/signals and release slots. The bounded
maintenance entrypoint expires abandoned calls, clears their ciphertext and
compacts terminal metadata after 24 hours:

```bash
cd consent-protocol
python -m hushh_mcp.services.direct_call_retention --limit 100
```

Only aggregate counts are printed. Governed scheduler installation and live
erasure verification are rollout prerequisites; this change installs no cloud
job. Expiry is admission closure, not evidence that unscheduled maintenance ran.
Existing account-erasure guards and actor/device/conversation FK cascades apply.

## Release gates and remaining agreed scope

Capability admission requires `DIRECT_CALLS_ENABLED`,
`DIRECT_MESSAGES_E2EE_QUALIFIED`, and `DIRECT_CALLS_NATIVE_QUALIFIED` all equal `1`,
plus a valid environment `DIRECT_CALLS_TURN_HOST` and server-only
`DIRECT_CALLS_TURN_SECRET`. Defaults remain unavailable. These are admission
controls, not qualification evidence. Deployment workflows do not set them here.

Remaining release blockers:

- Implement/verify People text and attachment E2EE, historical migration and
  recovery, client-produced previews and navigation-key compatibility. Existing
  messages remain server-readable and their history is unchanged.
- Qualify the implemented iOS media/signaling, CallKit/PushKit and native auth
  recovery on physical devices. Implement Android Telecom plus foreground-service
  integration. Android remains unavailable; no WebView fallback claims native
  locked-screen support.
- Prove trusted relay TLS/renewal, invalid/expired allocations, independent-network
  media, physical-device background/locked answer, interruption/revocation,
  capacity/cost, telemetry privacy and scheduled retention.
- Optional named private-agent participation requires both people's exact
  scope/provider approvals and qualified owner-pod inference. It is currently
  false. No recording, transcription, PKM ingestion or Live Memory source is added.

## Schema and integration

Migration 407 owns public device-key bindings, calls, busy slots, replay nonces
encrypted signals, purpose-bound PushKit registrations and the delivery outbox.
Its manifest, rollback and environment schema contracts
are aligned. Migration 315 is preserved. Rollback refuses live calls and never
touches message/attachment tables.

Review against `claude/hushh-infrastructure-analysis-7o991c`. Qualify on Dev before
reviewed main-compatible promotion; do not import the whole pod delta as a calling
shortcut. UAT/production use separately authorized exact green main commits and
isolated relays/credentials. The old `prod` branch is not deployment authority.
Source and CI results are not deployment receipts.

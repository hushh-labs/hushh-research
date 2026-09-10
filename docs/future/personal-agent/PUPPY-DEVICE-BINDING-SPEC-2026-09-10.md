# Puppy One device binding and direct relay: the device-side contract (2026-09-10)

Status: SPECIFICATION for the Hermes fork (`hussh-one-hermes-agent`). Nothing in this
document is implemented on the device yet; a follow-up lane implements it. The pod side
it describes IS implemented on branch `claude/hushh-infrastructure-analysis-7o991c`
(commits after `ccd89733b`) and is the source of truth where this text and the code
disagree: `consent-protocol/hushh_mcp/services/pod_session_authority.py`,
`consent-protocol/hushh_mcp/consent/puppy_envelope.py`,
`consent-protocol/api/routes/one/pod_puppy_relay.py`,
`consent-protocol/hushh_mcp/services/puppy_broker.py`,
`consent-protocol/hushh_mcp/services/pod_binding_service.py`.

Style: the private agent is One; the device is Puppy One (Hermes on the owner's Mac).
Code identifiers are verbatim. Every byte layout below is pinned by a pod-side test.

## 1. What changes for the device

Today Puppy One opens `WS /api/one/puppy/relay` on the **hub** with a bearer minted by
`POST /api/account/trusted-devices/{id}/puppy-inference-grant` and declares its role in
the hello. After this specification Puppy One dials the **owner's pod** directly, with a
**pod session** it obtained by proving possession of its enrolment key against a
**hub-signed binding**, and every frame after the hello is **sealed**. The hub stays in
the path only for enrolment, the binding, and endpoint discovery. Revocation is
authoritative at the pod.

The device never requests inference. It answers `inference.request` frames the pod
sends and honours `inference.cancel`. A device that sends `inference.request` is
disconnected (1008).

## 2. Files and keys on the device

| Item | Location | Notes |
|---|---|---|
| Enrolment key | Keychain, existing trusted-device P-256 key (`hermes_cli/hussh_one_pkm/client.py`, `sign()`) | Reused. The binding names its public key (DER SubjectPublicKeyInfo, base64). |
| Binding file | `state_dir/pod-binding.json`, mode 0600, written with `_atomic_json` | Holds the latest signed binding envelope and the pinned endpoint. Replaces the env tokens. |
| Ephemeral X25519 key | In memory, one per relay connection | Never written. A reconnect generates a new one. |
| Profile config | `config.yaml`, key `hussh_one.puppy_relay.enabled: true` | Default false. Enables the supervisor job. |

The old process-env bearer (`PUPPY_INFERENCE_*` values read by
`gateway/puppy_inference_relay.py`) is no longer the credential on the direct path.

## 3. Enrolment and the binding (hub calls)

The device is already a trusted device (`tdv_...`, platform `macos`). Its role is
derived from the platform by the hub and by the pod: `macos` is `device`; `web`, `ios`,
`android` are `app`. Nothing the device says changes its role.

### 3.1 Fetch the binding

`GET /api/account/trusted-devices/{device_id}/pod-binding` with the owner's Firebase
bearer returns the latest issued binding, or `404 {"code": "POD_BINDING_NOT_ISSUED"}`.
The owner issues or re-issues one from the app with
`POST /api/account/trusted-devices/{device_id}/pod-binding` body
`{"puppyInference": true}`. A device binding carries scope `puppy.inference` **only**
when the owner turned it on; enrolment alone never does. Turning it on or off issues a
new binding with a higher `version`.

Response shape (fields under `binding` are exactly these, in this canonical order when
sorted):

```json
{
  "binding": {
    "kind": "pod_binding_v1",
    "hushh_id": "<owner HusshID>",
    "user_id": "<owner Firebase uid>",
    "environment": "dev",
    "pod_key_id": "podk_...",
    "pod_public_key": "<base64 raw 32-byte X25519 public key>",
    "url": "https://one-pod-...a.run.app",
    "subject_id": "tdv_...",
    "subject_kind": "device",
    "subject_public_key": "<base64 DER P-256 public key>",
    "platform": "macos",
    "role": "device",
    "scopes": ["puppy.inference"],
    "version": 3,
    "issued_at_ms": 1757500000000,
    "expires_at_ms": 1760092000000
  },
  "signature": "ed25519.<kid>.<base64url signature>",
  "version": 3,
  "role": "device",
  "scopes": ["puppy.inference"]
}
```

### 3.2 Verify the binding on the device (recommended, not required by the pod)

The signature is Ed25519 over the canonical JSON of `binding`:
`json.dumps(binding, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` encoded
UTF-8. Public keys are the map the hub publishes as `CONSENT_ED25519_PUBLIC_KEYS`
(`{kid: base64 raw 32 bytes}`); the `kid` is the middle segment of the signature. A
device that cannot verify should still store the binding; the pod verifies it on
admission and refuses a bad one with an exact code.

### 3.3 Pin the endpoint

`GET /api/one/personal-agent/endpoint` (owner Firebase bearer) returns

```json
{
  "kind": "pod_endpoint_v1",
  "hushhId": "<owner HusshID>",
  "url": "https://one-pod-...a.run.app",
  "podKeyId": "podk_...",
  "environment": "dev",
  "endpointVersion": 1,
  "signature": "ed25519.<kid>.<base64url>"
}
```

The signature covers the canonical JSON of every field except `signature`. Rules:
refuse an `endpointVersion` lower than the pinned one; refuse a `podKeyId` change
without a higher `endpointVersion`; on acceptance, replace `url`, `podKeyId`,
`endpointVersion` in `pod-binding.json`. The binding's own `url` and `pod_key_id` must
match the pinned endpoint or the device must refresh the binding before dialling.

## 4. Admission at the pod: challenge and proof

All pod calls below go to the pinned `url`. No hub token is sent. These routes are on
the pod's app surface and need no Google identity.

### 4.1 Challenge

`POST {url}/api/one/pod/session/challenge` body `{"subjectId": "<tdv_...>"}` returns

```json
{
  "challengeId": "psc_...",
  "nonce": "<urlsafe base64 nonce>",
  "epoch": 7,
  "podKeyId": "podk_...",
  "expiresAt": 1757500120000,
  "signingPayload": "{\"challenge_id\":\"psc_...\",\"epoch\":7,\"hushh_id\":\"...\",\"nonce\":\"...\",\"pod_key_id\":\"podk_...\",\"purpose\":\"pod-session-admission\",\"subject_id\":\"tdv_...\"}"
}
```

Challenges live 120 s, are single-use, and belong to one incarnation (`epoch`).

### 4.2 Proof (byte-exact)

Sign `signingPayload` **as returned**, UTF-8, with the enrolment P-256 key, ECDSA with
SHA-256, DER-encoded signature, base64. The payload is the canonical JSON of exactly
these seven keys, sorted: `challenge_id`, `epoch` (integer), `hushh_id`, `nonce`,
`pod_key_id`, `purpose` (always `"pod-session-admission"`), `subject_id`. Compact
separators, no trailing newline. Pod test:
`tests/test_pod_session_authority.py::test_the_challenge_payload_is_byte_exact_and_carries_pod_and_epoch`.

### 4.3 Admit

`POST {url}/api/one/pod/session/admit` body

```json
{
  "binding": { ...the binding object... },
  "signature": "ed25519.<kid>.<sig>",
  "challengeId": "psc_...",
  "nonce": "<the nonce>",
  "proof": "<base64 ECDSA signature>",
  "epoch": 7
}
```

Success (200):

```json
{
  "session": "pst1.<base64url claims>.<base64url mac>",
  "sid": "pss_...",
  "role": "device",
  "scopes": ["puppy.inference"],
  "epoch": 7,
  "expiresAt": 1757543200000,
  "version": 3
}
```

Refusals are `403` (or `401` for proof problems, `503` when the pod holds no authority
or is fenced) with `{"detail": {"code": ..., "message": ...}}`. Codes the device must
handle:

| code | meaning | device action |
|---|---|---|
| `stale_version` | a newer binding is already recorded | fetch the binding again, retry |
| `revoked` | the owner revoked this device at or above this version | stop; show revoked; do not retry until a new binding arrives |
| `expired` | binding expired | fetch a new binding |
| `replayed_proof` | challenge unknown, used or expired | take a fresh challenge |
| `foreign_incarnation` | `epoch` does not match the pod's current incarnation | take a fresh challenge (the pod restarted) |
| `foreign_deployment` | binding names another pod key or key id | refresh the endpoint, then the binding |
| `fenced`, `uncertain` (503) | this incarnation is being replaced | back off and retry |
| `not_local_authority` (401) | a hub token was presented as the bearer | never send an HCT to the pod |
| anything else | configuration fault | stop and surface it |

Sessions last 12 hours. `POST {url}/api/one/pod/session/renew` with the session as
bearer returns the same shape with a new `session`. Renew at 11 hours; on `revoked`
stop; on `expired` re-admit.

## 5. The relay: `WS {url}/api/one/puppy/relay`

Headers: `Authorization: Bearer <session>`. No role header, no environment header;
the role is the binding's.

### 5.1 Hello (plain JSON, the only unsealed frame the device sends)

```json
{
  "type": "relay.hello",
  "role": "device",
  "deviceId": "<tdv_... equal to the session subject>",
  "deviceEphemeralPublicKey": "<base64 raw 32-byte X25519 public key, fresh per connection>",
  "model": "<resident model id, at most 128 chars, no whitespace, no '://'>",
  "capabilities": ["tool_calling", "json_schema", "streaming", "probe_mode"]
}
```

`capabilities` entries match `^[a-z0-9_.-]+$`, at most 32 entries of at most 64 chars,
using the `hussh_one_routing/profile.py` vocabulary. An unparseable `model` is recorded
as unknown, not refused.

### 5.2 Ready (plain JSON from the pod)

```json
{"type": "relay.ready", "role": "device", "epoch": 7, "podKeyId": "podk_...", "sessionExpiresAt": 1757543200000, "sealed": true}
```

Refuse to proceed if `epoch` is lower than the last epoch this device saw for this pod
(epoch regression). A higher epoch is a pod restart and is fine.

### 5.3 Frame key

```
shared = X25519(device_ephemeral_private, pod_public_key from the binding)
key    = HKDF-SHA256(ikm=shared, salt=None, info=b"hussh/puppy-envelope/aes256gcm/v1", length=32)
```

Pod test: `tests/test_puppy_envelope.py::test_both_sides_derive_the_same_key_and_it_is_not_the_shared_secret`.

### 5.4 Sealed frame (every frame after the hello, both directions)

```json
{"type": "sealed", "v": 1, "dir": "d2p", "seq": 1, "innerType": "inference.delta", "ciphertext": "<base64 AES-256-GCM ciphertext||tag>"}
```

* `dir`: `p2d` for pod to device, `d2p` for device to pod.
* `seq`: per direction, starts at 1, strictly increasing by 1. The receiver refuses a
  frame whose `seq` is not exactly the next expected value (replay and reorder both
  fail).
* Nonce (12 bytes): `dir_byte || 0x00 0x00 0x00 || seq as 8-byte big-endian`, where
  `dir_byte` is `0x00` for `p2d` and `0x01` for `d2p`.
* AAD: canonical JSON (sorted keys, compact separators, `ensure_ascii=False`, UTF-8) of
  exactly eight keys:
  `{"deviceId", "dir", "epoch", "hushhId", "innerType", "seq", "sessionId", "v"}`, with
  `v = 1`, `sessionId` = the `sid` from admission, `epoch` = the ready frame's epoch.
  Example bytes:
  `{"deviceId":"tdv_mac_1","dir":"p2d","epoch":3,"hushhId":"ha1_owner","innerType":"inference.delta","seq":7,"sessionId":"pss_abc","v":1}`
* Plaintext: the inner frame as compact JSON (`separators=(",", ":")`), whose `type`
  must equal `innerType`.
* Limits: inner frame at most 1 MiB.

Pod tests: `tests/test_puppy_envelope.py` (round trip, AAD binding, replay, reorder,
reflection, nonce layout, byte-exact AAD).

### 5.5 Inner frames the device receives

`inference.request` (the same neutral request the hub relay carried):
`requestId`, `deviceId`, `model`, `messages[]` (`role`, `text`, `toolName`,
`toolCallId`, `toolArguments`, `toolResult`), `systemInstruction`, `temperature`,
`maxOutputTokens`, `tools[]` (`name`, `description`, `parameters`). Lane B may add
`responseFormat`, `toolChoice`, `allowedFunctionNames`, `topP`, `stopSequences`,
`seed`, `thinking`; refuse a request needing a capability the profile lacks with
`inference.error` `code: "UNSUPPORTED_CAPABILITY"` before calling the local model.

`inference.cancel`: `{"type": "inference.cancel", "requestId": "..."}`. Abort the
local model stream for that request immediately (close the `httpx` stream); send
nothing further for that `requestId`.

### 5.6 Inner frames the device sends

`inference.delta` (`requestId`, `text`, optional `functionCalls[]`),
`inference.result` (`requestId`, `text`, optional `functionCalls[]`, `model`),
`inference.done` (`requestId`, optional `text`, `model`),
`inference.error` (`requestId`, `code`), `relay.heartbeat` and `relay.status`
(`status` in `ready`, `busy`, `offline`). Carry `model` (the resident model id) on
`inference.result` and `inference.done` so One can report `modelReported: true`.

Never send `inference.request`.

### 5.7 Session re-verification

The pod re-verifies the session on every inbound frame. A revocation at the pod closes
the socket (1008) at the next device frame; a `relay.heartbeat` every 20 to 30 s keeps
that bound tight. Reconnect after 1008 only if a **new** binding version is available;
otherwise show revoked.

Other close codes: 1012 `replaced` (a newer connection from this device took over:
stop this one, do not reconnect from it), 1011 (pod fault: back off and retry).

## 6. Timeouts (device rungs of the ladder)

| Rung | Value |
|---|---|
| Local model client | `httpx.Timeout(connect=10, read=60, write=10, pool=10)` |
| Per-request total on the device | `asyncio.timeout(110)`; on expiry send `inference.error` `code: "PUPPY_TIMEOUT"` |
| Pod broker inter-frame bound | 65 s (above the 60 s read timeout) |
| Pod broker request deadline | 120 s, then the pod sends `inference.cancel` |

Send at least one `inference.delta` or a `relay.heartbeat` inside every 60 s window
while a request is running. Reconnect with 2 s backoff doubling to 30 s with jitter, as
today. The pod-side order is pinned by `tests/test_timeout_ladder.py`.

## 7. Supervisor and configuration

* Profile key: `hussh_one.puppy_relay.enabled: true` in the profile `config.yaml`.
  Default false. When false the job is not installed and an existing job is unloaded.
* Launcher: `scripts/hussh-one-puppy-inference-relay.py --profile <profile_id>`; reads
  `state_dir/pod-binding.json`, refreshes the binding and endpoint from the hub when the
  session is refused with `stale_version`, `expired` or `foreign_deployment`, admits at
  the pod, opens the relay, renews the session at 11 hours.
* launchd job: `ai.hussh-one.puppy-relay.<profile_id>`, shaped like the existing jobs in
  `scripts/hussh-one-supervisor.sh` (lines 585 to 620 at `6d5b3204af`): `RunAtLoad`,
  `KeepAlive`, `ThrottleInterval` 10, stdout and stderr under the profile's log
  directory, `ProgramArguments` naming the venv python, the launcher and the profile.
* Wire logging: pass a disabled logger to `websockets.connect(..., logger=<disabled>)`;
  frame contents never reach a log. Log codes and counts only.
* Nothing in the profile or the plist holds a bearer. The binding file holds a signed
  public record; the session lives in process memory; the Keychain holds the key.

## 8. What the device must refuse

* A pod whose `relay.ready` `podKeyId` differs from the pinned `podKeyId`.
* An epoch lower than the last one seen for this pod.
* A sealed frame whose `seq` is not the next expected, whose `dir` is not `p2d`, or
  that fails authentication (close the socket, reconnect fresh).
* Any request to send a hub consent token (`HCT:...`) to the pod.
* Any unsealed frame after the hello other than `relay.ready`.

## 9. Pod-side references

* Admission and codes: `consent-protocol/hushh_mcp/services/pod_session_authority.py`,
  `consent-protocol/api/routes/one/pod_session.py`,
  `consent-protocol/tests/test_pod_session_authority.py`,
  `consent-protocol/tests/test_pod_session_routes.py`.
* Relay: `consent-protocol/api/routes/one/pod_puppy_relay.py`,
  `consent-protocol/tests/test_pod_puppy_relay_route.py`.
* Envelope: `consent-protocol/hushh_mcp/consent/puppy_envelope.py`,
  `consent-protocol/tests/test_puppy_envelope.py`.
* Broker semantics (busy, cancel, deadlines): `consent-protocol/hushh_mcp/services/puppy_broker.py`,
  `consent-protocol/tests/test_puppy_broker.py`.
* Hub issuance: `consent-protocol/hushh_mcp/services/pod_binding_service.py`,
  `consent-protocol/tests/test_pod_binding_service.py`.

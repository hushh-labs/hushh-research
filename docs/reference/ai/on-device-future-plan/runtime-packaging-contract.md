# Runtime Packaging Contract

> Superseded for the command experience by the [Location command runtime](../../one/one-voice-runtime-architecture.md). Live conversation and local model-pack requirements below are historical context, not active release gates.


## Visual Context

Canonical visual owner: [Cloud + On-Device AI Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Status

`Implemented contract / deployment-gated model activation`. The base app
contains the contracts, verified pack store, capability endpoint, and the
pinned sherpa-onnx browser runtime glue/WASM code. Model weights remain
deployment-owned and are never committed to the application bundle.

## Purpose

Define the stable contract for downloadable on-device model packs without changing cloud API behavior.

## Processing Mode Contract

Allowed values:

1. `cloud`
2. `hybrid`
3. `on_device`

Behavior contract:

1. `cloud` is the server capability fallback when no local pack is active.
2. `hybrid` allows local task execution with cloud fallback.
3. `on_device` requires cached context and installed packs.

## Model Pack Manifest Contract

```ts
export interface ModelPackManifest {
  pack_id: string;
  version: string;
  size_bytes: number;
  checksum: string;
  min_ram_gb: number;
  min_storage_mb: number;
  languages: string[];
  tasks: Array<"ocr" | "stt" | "tts" | "slm" | "intent">;
  runtime: "sherpa_onnx_web" | "onnxruntime_web" | "onnxruntime_mobile" | "fluid_audio";
  artifact_url: string;
  preprocessing_version: string;
  entrypoint: string;
  source_sha: string;
  catalog_version: string;
  license_notice_id: string;
  license_approved: boolean;
}
```

## Local Runtime Capability Contract

```ts
export interface LocalRuntimeCapability {
  processing_mode_contract: Array<"cloud" | "hybrid" | "on_device">;
  offline_ready: boolean;
  installed_packs: ModelPackManifest[];
  available_packs: ModelPackManifest[];
  supported_tasks: Array<"ocr" | "stt" | "tts" | "slm" | "intent">;
  fallback_mode: "cloud" | "hybrid";
}
```

## Capability Endpoint Contract

The endpoint is implemented as metadata-only capability discovery:

1. Method: `GET`
2. Path: `/api/kai/local-runtime/capability`
3. Response: `LocalRuntimeCapability`
4. Data class: metadata-only, no sensitive user payload.

It fails closed to `cloud`/`hybrid` with no advertised packs when deployment
configuration is absent or invalid. The browser reports local readiness only
after its own compatibility, size, and SHA-256 checks.

`artifact_url` is required to be an HTTPS bearer URL with both a provider
signature and an expiry query parameter (for example CloudFront `Signature` +
`Expires`, or the equivalent S3/GCS parameters). The API rejects unsigned
URLs; the client never logs or persists the URL outside the active download
path. It is an ephemeral response field, not a deployment setting.

## Hosted registry and fresh-URL boundary

UAT and production use separate approved model buckets:

| Environment | Bucket |
| --- | --- |
| UAT | `hushh-pda-uat-one-voice-model-packs` |
| Production | `hushh-pda-one-voice-model-packs` |

The Secret Manager value named by
`HUSHH_LOCAL_RUNTIME_PACK_REGISTRY_SECRET` contains the protocol version,
active immutable object references, SHA-256 values, source/catalog provenance,
and a prior valid pack set for rollback. It must never contain a signed URL,
audio, transcript, contact, vault material, or a provider credential.

Cloud Run reads that registry through a bounded adapter, validates every record,
and uses workload-identity ADC plus IAM `signBlob` to mint a fresh URL for each
capability response. The signer identity is configured by
`HUSHH_LOCAL_RUNTIME_PACK_SIGNER_SERVICE_ACCOUNT`; no service-account key is
stored in GitHub Actions or Cloud Run. An invalid registry, signer, or object
fails closed to the existing cloud/hybrid capability.

For the pinned browser ASR entrypoint
`sherpa_onnx_browser_streaming_v1`, the artifact is the matching Emscripten
preloaded `.data` file from the reviewed sherpa-onnx release. The worker
supplies that verified byte buffer to the pinned runtime; it does not evaluate
JavaScript from the model URL. See
`public/vendor/sherpa-onnx/v1.13.7/README.md` for the runtime hashes.

## Pack Lifecycle Contract

1. Download must be resumable.
2. Checksum validation is mandatory before activation.
3. Failed validation triggers safe delete and cloud fallback.
4. Pack activation is atomic.
5. Rollback path must support previous known-good pack version.

The browser stores immutable verified bytes in Cache Storage and active/previous
version pointers in IndexedDB. Activation changes only the pointer after
verification; rollback selects the previous verified pack or safely no-ops.

On iOS, the optional FluidAudio provider stores only verified model assets and
non-sensitive pack provenance in Application Support. Its temporary GCS URL is
used for one transfer and is never persisted. The native store accepts only
the reviewed pack identity, an allowed environment bucket, a signed-and-expiring
URL shape, the model notice, checksum, normalized `160ms` model layout and
provenance manifest, sufficient RAM/storage/battery/network state, and atomic
activation/rollback records. It is not a second transcript store or action
authority.

The FluidAudio model pack is not eligible for release merely because the SDK is
linked. The exact NVIDIA-licensed model notice must record legal approval, the
native feature and benchmark switches must be enabled, and physical-device
evidence must qualify the same release source before it can be selected.
The publication workflow accepts an upstream source ZIP only from an explicit
environment bucket path, repackages only the required `160ms` files, and emits
an immutable pack with no signed URL or user information.

The native `Info.plist` receives its single allowed bucket through the
`ONE_VOICE_MODEL_PACK_BUCKET` archive build setting. The committed default is
the UAT bucket for normal TestFlight builds. A future production-native archive
must supply the production bucket explicitly; a binary must never accept both
buckets.

## Install Policy Defaults

1. Download on Wi-Fi + charging by default.
2. Surface low-storage warnings before download starts.
3. Enforce per-tier install gating by RAM/storage.
4. Keep base app binary free of model weights.

## Observability Event Contract

New metadata-only events expected in implementation phase:

1. `model_pack_download_started`
2. `model_pack_download_completed`
3. `model_pack_download_failed`
4. `local_inference_started`
5. `local_inference_completed`
6. `local_inference_failed`
7. `cloud_fallback_triggered`

No raw user identifiers, freeform text, or sensitive financial payloads are
allowed in these events. The runtime observer accepts only pack/provider
metadata, outcome/reason, elapsed milliseconds, and byte count.

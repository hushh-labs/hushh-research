# Runtime Packaging Contract


## Visual Context

Canonical visual owner: [Cloud + On-Device AI Reference](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

## Status

`Future Plan` contract draft. Interfaces here are target contracts and should be finalized only during implementation.

## Purpose

Define the stable contract for downloadable on-device model packs without changing cloud API behavior.

## Processing Mode Contract

Allowed values:

1. `cloud`
2. `hybrid`
3. `on_device`

Behavior contract:

1. `cloud` is default.
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
  tasks: Array<"ocr" | "stt" | "tts" | "slm">;
}
```

## Local Runtime Capability Contract

```ts
export interface LocalRuntimeCapability {
  processing_mode_contract: Array<"cloud" | "hybrid" | "on_device">;
  offline_ready: boolean;
  installed_packs: ModelPackManifest[];
  supported_tasks: Array<"ocr" | "stt" | "tts" | "slm">;
  fallback_mode: "cloud" | "hybrid";
}
```

## Capability Endpoint Contract (Target)

Endpoint contract to add during implementation phase:

1. Method: `GET`
2. Path: `/api/kai/local-runtime/capability`
3. Response: `LocalRuntimeCapability`
4. Data class: metadata-only, no sensitive user payload.

## Pack Lifecycle Contract

1. Download must be resumable.
2. Checksum validation is mandatory before activation.
3. Failed validation triggers safe delete and cloud fallback.
4. Pack activation is atomic.
5. Rollback path must support previous known-good pack version.

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

No raw user identifiers, freeform text, or sensitive financial payloads are allowed in these events.

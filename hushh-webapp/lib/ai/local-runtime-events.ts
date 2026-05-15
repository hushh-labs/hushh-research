"use client";

import { trackEvent } from "@/lib/observability/client";

type LocalRuntimeTask = "ocr" | "stt" | "tts" | "slm";
type LocalRuntimeMode = "cloud" | "hybrid" | "on_device";
type LocalRuntimeResult = "success" | "expected_error" | "error";
type LocalRuntimeReason =
  | "checksum_mismatch"
  | "download_error"
  | "low_storage"
  | "network_policy"
  | "battery_policy"
  | "local_exception"
  | "locale_mismatch"
  | "pack_missing"
  | "unsupported_task"
  | "unknown";

type SafeLocalRuntimeMetadata = {
  task?: LocalRuntimeTask;
  processing_mode?: LocalRuntimeMode;
  fallback_mode?: "cloud" | "hybrid";
  result?: LocalRuntimeResult;
  reason_code?: LocalRuntimeReason;
  pack_id?: "hussh-b-pack-v1";
  pack_version?: string;
  size_bytes?: number;
  offset_bytes?: number;
  progress_pct?: number;
  min_ram_gb?: number;
  detected_ram_gb?: number;
  min_storage_mb?: number;
  available_storage_mb?: number;
  battery_level_pct?: number;
  is_charging?: boolean;
  network_type?: "wifi" | "cellular" | "none" | "unknown";
  offline_ready?: boolean;
  local_success?: boolean;
};

export type LocalRuntimeEventName =
  | "model_pack_download_started"
  | "model_pack_download_completed"
  | "model_pack_download_failed"
  | "local_inference_started"
  | "local_inference_completed"
  | "local_inference_failed"
  | "cloud_fallback_triggered";

export type LocalRuntimeEventMetadata = Readonly<SafeLocalRuntimeMetadata>;

export function emitLocalRuntimeEvent(
  name: LocalRuntimeEventName,
  metadata: LocalRuntimeEventMetadata
): void {
  trackEvent(name, metadata);
}

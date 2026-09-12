/**
 * Metadata-only local runtime telemetry.
 *
 * This seam intentionally accepts no utterance, transcript, audio, entity,
 * credential, or vault fields. Product analytics can subscribe to it without
 * creating a second privacy boundary for voice input.
 */

export type LocalRuntimeEventName =
  | "model_pack_download_started"
  | "model_pack_download_completed"
  | "model_pack_download_failed"
  | "model_pack_activation_completed"
  | "model_pack_rollback_completed"
  | "local_inference_started"
  | "local_inference_completed"
  | "local_inference_failed"
  | "cloud_fallback_triggered";

export type LocalRuntimeEvent = {
  event: LocalRuntimeEventName;
  packId?: string;
  packVersion?: string;
  provider?: string;
  outcome?: string;
  reason?: string;
  elapsedMs?: number;
  byteCount?: number;
};

export type LocalRuntimeObserver = (event: LocalRuntimeEvent) => void;

let observer: LocalRuntimeObserver | null = null;

export function setLocalRuntimeObserver(
  next: LocalRuntimeObserver | null,
): () => void {
  observer = next;
  return () => {
    if (observer === next) observer = null;
  };
}

export function emitLocalRuntimeEvent(event: LocalRuntimeEvent): void {
  const safe: LocalRuntimeEvent = {
    event: event.event,
    ...(event.packId ? { packId: event.packId.slice(0, 120) } : {}),
    ...(event.packVersion ? { packVersion: event.packVersion.slice(0, 80) } : {}),
    ...(event.provider ? { provider: event.provider.slice(0, 80) } : {}),
    ...(event.outcome ? { outcome: event.outcome.slice(0, 80) } : {}),
    ...(event.reason ? { reason: event.reason.slice(0, 120) } : {}),
    ...(typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs)
      ? { elapsedMs: Math.max(0, Math.round(event.elapsedMs)) }
      : {}),
    ...(typeof event.byteCount === "number" && Number.isFinite(event.byteCount)
      ? { byteCount: Math.max(0, Math.round(event.byteCount)) }
      : {}),
  };
  observer?.(safe);
}

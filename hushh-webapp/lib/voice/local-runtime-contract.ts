/**
 * Shared contracts for optional local voice runtime packs.
 *
 * Model weights are never part of the application source or a voice request.
 * The backend publishes metadata and a short-lived artifact URL; the client
 * verifies the artifact before activation and keeps the active pack local.
 */

export type VoiceRuntimeMode = "cloud" | "hybrid" | "on_device";

export type VoiceSpeechProvider =
  | "sherpa_onnx_web"
  | "apple_speech"
  | "fluid_audio"
  | "browser_speech";

export type VoiceModelPackRuntime =
  | "sherpa_onnx_web"
  | "onnxruntime_web"
  | "onnxruntime_mobile"
  | "fluid_audio";

export type VoiceModelPackTask = "ocr" | "stt" | "tts" | "slm" | "intent";

export type VoiceModelPackManifest = {
  pack_id: string;
  version: string;
  size_bytes: number;
  checksum: string;
  min_ram_gb: number;
  min_storage_mb: number;
  languages: string[];
  tasks: VoiceModelPackTask[];
  runtime: VoiceModelPackRuntime;
  artifact_url: string;
  preprocessing_version: string;
  entrypoint: string;
  /** Public release provenance; never a bucket/object reference. */
  source_sha: string;
  catalog_version: string;
  license_notice_id: string;
  license_approved: boolean;
};

export type LocalRuntimeCapability = {
  processing_mode_contract: Array<VoiceRuntimeMode>;
  offline_ready: boolean;
  installed_packs: VoiceModelPackManifest[];
  available_packs: VoiceModelPackManifest[];
  supported_tasks: VoiceModelPackTask[];
  fallback_mode: "cloud" | "hybrid";
};

export type LocalRuntimeFailure =
  | "unsupported_browser"
  | "unsupported_device"
  | "insufficient_memory"
  | "insufficient_storage"
  | "network_required"
  | "download_failed"
  | "checksum_mismatch"
  | "pack_not_installed"
  | "pack_not_compatible"
  | "inference_failed";

export type LocalRuntimeStatus =
  | { state: "unavailable"; reason: LocalRuntimeFailure }
  | { state: "available"; pack: VoiceModelPackManifest }
  | { state: "loading"; pack: VoiceModelPackManifest }
  | { state: "ready"; pack: VoiceModelPackManifest };

/**
 * Model artifacts are bearer resources. Require both a provider signature and
 * an expiry query parameter before a deployment can advertise one. The
 * checksum still authenticates the bytes after download; this check limits
 * who can fetch them and for how long.
 */
export function isSignedModelPackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const keys = new Set(Array.from(url.searchParams.keys()).map((key) => key.toLowerCase()));
    const hasSignature = [
      "signature",
      "x-amz-signature",
      "x-goog-signature",
      "sig",
    ].some((key) => keys.has(key));
    const hasExpiry = [
      "expires",
      "x-amz-expires",
      "x-goog-expires",
      "se",
    ].some((key) => keys.has(key));
    return hasSignature && hasExpiry;
  } catch {
    return false;
  }
}

export function isVoiceModelPackManifest(
  value: unknown,
): value is VoiceModelPackManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const sizeBytes = candidate.size_bytes;
  const checksum =
    typeof candidate.checksum === "string" ? candidate.checksum.trim() : "";
  const runtime = candidate.runtime;
  const languages = candidate.languages;
  const tasks = candidate.tasks;
  return (
    typeof candidate.pack_id === "string" &&
    candidate.pack_id.trim().length > 0 &&
    typeof candidate.version === "string" &&
    candidate.version.trim().length > 0 &&
    Number.isSafeInteger(sizeBytes) &&
    (sizeBytes as number) > 0 &&
    (/^[0-9a-f]{64}$/i.test(checksum) || /^[A-Za-z0-9+/]{43}=$/.test(checksum)) &&
    typeof candidate.min_ram_gb === "number" &&
    Number.isFinite(candidate.min_ram_gb) &&
    candidate.min_ram_gb >= 0 &&
    typeof candidate.min_storage_mb === "number" &&
    Number.isFinite(candidate.min_storage_mb) &&
    candidate.min_storage_mb >= 0 &&
    Array.isArray(languages) &&
    languages.length > 0 &&
    languages.every((entry) => typeof entry === "string" && entry.trim().length > 0) &&
    Array.isArray(tasks) &&
    tasks.length > 0 &&
    tasks.every(
      (entry) =>
        entry === "ocr" ||
        entry === "stt" ||
        entry === "tts" ||
        entry === "slm" ||
        entry === "intent",
    ) &&
    (runtime === "sherpa_onnx_web" ||
      runtime === "onnxruntime_web" ||
      runtime === "onnxruntime_mobile" ||
      runtime === "fluid_audio") &&
    typeof candidate.artifact_url === "string" &&
    isSignedModelPackUrl(candidate.artifact_url) &&
    typeof candidate.preprocessing_version === "string" &&
    typeof candidate.entrypoint === "string" &&
    typeof candidate.source_sha === "string" &&
    /^[0-9a-f]{7,64}$/i.test(candidate.source_sha.trim()) &&
    typeof candidate.catalog_version === "string" &&
    candidate.catalog_version.trim().length > 0 &&
    typeof candidate.license_notice_id === "string" &&
    candidate.license_notice_id.trim().length > 0 &&
    typeof candidate.license_approved === "boolean"
  );
}

export function isLocalRuntimeCapability(
  value: unknown,
): value is LocalRuntimeCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.processing_mode_contract) &&
    candidate.processing_mode_contract.every(
      (entry) => entry === "cloud" || entry === "hybrid" || entry === "on_device",
    ) &&
    typeof candidate.offline_ready === "boolean" &&
    Array.isArray(candidate.installed_packs) &&
    candidate.installed_packs.every(isVoiceModelPackManifest) &&
    Array.isArray(candidate.available_packs) &&
    candidate.available_packs.every(isVoiceModelPackManifest) &&
    Array.isArray(candidate.supported_tasks) &&
    candidate.supported_tasks.every(
      (entry) =>
        entry === "ocr" ||
        entry === "stt" ||
        entry === "tts" ||
        entry === "slm" ||
        entry === "intent",
    ) &&
    (candidate.fallback_mode === "cloud" || candidate.fallback_mode === "hybrid")
  );
}

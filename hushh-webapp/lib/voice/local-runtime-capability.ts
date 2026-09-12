import {
  isLocalRuntimeCapability,
  type LocalRuntimeCapability,
  type VoiceModelPackManifest,
  type LocalRuntimeFailure,
} from "./local-runtime-contract";
import { LocalModelPackStore } from "./local-runtime-model-store";

const CAPABILITY_PATH = "/api/kai/local-runtime/capability";

export async function fetchLocalRuntimeCapability(
  fetchImpl: typeof fetch = fetch,
): Promise<LocalRuntimeCapability> {
  const response = await fetchImpl(CAPABILITY_PATH, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("local_runtime_capability_unavailable");
  const payload: unknown = await response.json();
  if (!isLocalRuntimeCapability(payload)) {
    throw new Error("local_runtime_capability_invalid");
  }
  return payload;
}

export function canUseWebAssemblySpeech(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof AudioWorkletNode !== "undefined"
  );
}

export async function localPackCompatibilityFailure(
  pack: VoiceModelPackManifest,
): Promise<LocalRuntimeFailure | null> {
  if (!canUseWebAssemblySpeech()) return "unsupported_browser";
  const deviceMemoryValue =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      : undefined;
  const deviceMemory =
    typeof deviceMemoryValue === "number" ? deviceMemoryValue : null;
  if (deviceMemory !== null && deviceMemory < pack.min_ram_gb) {
    return "insufficient_memory";
  }
  if (
    typeof navigator !== "undefined" &&
    "storage" in navigator &&
    typeof navigator.storage?.estimate === "function"
  ) {
    const estimate = await navigator.storage.estimate();
    const available = Math.max(
      0,
      (estimate.quota ?? 0) - (estimate.usage ?? 0),
    );
    if (available > 0 && available < pack.min_storage_mb * 1024 * 1024) {
      return "insufficient_storage";
    }
  }
  return null;
}

export function chooseLocalSpeechPack(
  capability: LocalRuntimeCapability,
): VoiceModelPackManifest | null {
  const installed = new Map(
    capability.installed_packs
      .filter(
        (pack) =>
          pack.runtime === "sherpa_onnx_web" &&
          pack.tasks.includes("stt") &&
          pack.languages.some((language) => language.toLowerCase() === "en"),
      )
      .map((pack) => [`${pack.pack_id}:${pack.version}`, pack]),
  );
  const candidates = capability.available_packs.filter(
    (pack) =>
      pack.runtime === "sherpa_onnx_web" &&
      pack.tasks.includes("stt") &&
      pack.languages.some((language) => language.toLowerCase() === "en") &&
      installed.has(`${pack.pack_id}:${pack.version}`),
  );
  return (
    candidates.sort((left, right) => right.version.localeCompare(left.version))[0] ??
    null
  );
}

export function chooseLocalIntentPack(
  capability: LocalRuntimeCapability,
): VoiceModelPackManifest | null {
  return (
    capability.available_packs
      .filter(
        (pack) =>
          pack.runtime === "onnxruntime_web" &&
          pack.tasks.includes("intent") &&
          pack.languages.some((language) => language.toLowerCase() === "en") &&
          pack.preprocessing_version === "minilm-action-head-v1" &&
          pack.entrypoint === "one_voice_intent_ranker_v2",
      )
      .sort((left, right) => right.version.localeCompare(left.version))[0] ?? null
  );
}

/**
 * Select the single reviewed native streaming pack. This is an adapter
 * selection only: it neither downloads a pack nor authorizes an action.
 */
export function chooseNativeFluidAudioPack(
  capability: LocalRuntimeCapability,
): VoiceModelPackManifest | null {
  return (
    capability.available_packs
      .filter(
        (pack) =>
          pack.runtime === "fluid_audio" &&
          pack.pack_id === "fluid-audio-parakeet-eou-120m-coreml-v1" &&
          pack.tasks.includes("stt") &&
          pack.languages.some((language) => language.toLowerCase() === "en") &&
          pack.preprocessing_version === "pcm16k-v1" &&
          pack.entrypoint === "one_voice_fluid_audio_parakeet_eou_120m_v1" &&
          pack.license_notice_id ===
            "fluid-audio-parakeet-eou-120m-coreml-v1" &&
          pack.license_approved,
      )
      .sort((left, right) => right.version.localeCompare(left.version))[0] ?? null
  );
}

export async function ensureLocalSpeechPack(
  capability: LocalRuntimeCapability,
  options?: {
    store?: LocalModelPackStore;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<VoiceModelPackManifest | null> {
  if (!canUseWebAssemblySpeech()) return null;
  const pack = capability.available_packs.find(
    (candidate) =>
      candidate.runtime === "sherpa_onnx_web" &&
      candidate.tasks.includes("stt") &&
      candidate.languages.some((language) => language.toLowerCase() === "en"),
  );
  if (!pack) return null;

  const store = options?.store ?? new LocalModelPackStore();
  const compatibilityFailure = await localPackCompatibilityFailure(pack);
  if (compatibilityFailure) throw new Error(`local_runtime_${compatibilityFailure}`);
  if (!(await store.hasInstalled(pack))) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error("local_runtime_network_required");
    }
    await store.install(pack, {
      fetchImpl: options?.fetchImpl,
      signal: options?.signal,
    });
  }
  await store.activate(pack);
  return pack;
}

export async function ensureLocalIntentPack(
  capability: LocalRuntimeCapability,
  options?: {
    store?: LocalModelPackStore;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<VoiceModelPackManifest | null> {
  if (!canUseWebAssemblySpeech()) return null;
  const pack = chooseLocalIntentPack(capability);
  if (!pack) return null;

  const store = options?.store ?? new LocalModelPackStore();
  const compatibilityFailure = await localPackCompatibilityFailure(pack);
  if (compatibilityFailure) throw new Error(`local_runtime_${compatibilityFailure}`);
  if (!(await store.hasInstalled(pack))) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      throw new Error("local_runtime_network_required");
    }
    await store.install(pack, {
      fetchImpl: options?.fetchImpl,
      signal: options?.signal,
    });
  }
  await store.activate(pack);
  return pack;
}

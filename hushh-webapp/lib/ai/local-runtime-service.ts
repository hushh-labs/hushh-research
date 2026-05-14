"use client";

import { Device } from "@capacitor/device";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Preferences } from "@capacitor/preferences";

import { HushhKeychain } from "@/lib/capacitor";
import { emitLocalRuntimeEvent } from "@/lib/ai/local-runtime-events";

export type ProcessingMode = "cloud" | "hybrid" | "on_device";
export type LocalRuntimeTask = "ocr" | "stt" | "tts" | "slm";

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

export interface LocalRuntimeCapability {
  processing_mode_contract: Array<"cloud" | "hybrid" | "on_device">;
  offline_ready: boolean;
  installed_packs: ModelPackManifest[];
  supported_tasks: Array<"ocr" | "stt" | "tts" | "slm">;
  fallback_mode: "cloud" | "hybrid";
}

export type LocalRuntimeReadiness = {
  detectedRamGb: number | null;
  availableStorageMb: number | null;
  locale: string;
  meetsRam: boolean;
  meetsStorage: boolean;
  lowStorage: boolean;
  localeSupported: boolean;
};

const PROCESSING_MODE_KEY = "kai_local_runtime_processing_mode";
const INSTALLED_PACK_KEY = "kai_local_runtime_installed_pack_manifest";
const FALLBACK_MODE_KEY = "kai_local_runtime_fallback_mode";
const MODEL_PACK_DIR = "model-packs";
const STORAGE_BUFFER_MB = 200;

function isProcessingMode(value: string | null | undefined): value is ProcessingMode {
  return value === "cloud" || value === "hybrid" || value === "on_device";
}

function uniqueTasks(packs: ModelPackManifest[]): LocalRuntimeTask[] {
  const tasks = new Set<LocalRuntimeTask>();
  packs.forEach((pack) => pack.tasks.forEach((task) => tasks.add(task)));
  return Array.from(tasks);
}

function safeParseManifest(value: string | null): ModelPackManifest | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ModelPackManifest;
    if (!parsed.pack_id || !Array.isArray(parsed.tasks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function bytesToMb(bytes: number | null | undefined): number | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  return bytes / 1024 / 1024;
}

function estimateRamGbFromModel(model: string): number | null {
  const normalized = model.toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("pixel 8") || normalized.includes("pixel 9")) return 8;
  if (normalized.includes("pixel 7")) return 8;
  if (normalized.includes("sm-s92") || normalized.includes("s23") || normalized.includes("s24")) return 8;
  if (normalized.includes("sm-s90") || normalized.includes("s22")) return 8;
  if (/iphone1[4-7],/.test(normalized)) return 6;
  return null;
}

async function readSecureValue(key: string): Promise<string | null> {
  try {
    const result = await HushhKeychain.get({ key });
    return result.value;
  } catch {
    return null;
  }
}

async function writeSecureValue(key: string, value: string): Promise<void> {
  try {
    await HushhKeychain.set({ key, value });
  } catch {
    await Preferences.set({ key, value });
  }
}

export class LocalRuntimeService {
  private cachedCapability: LocalRuntimeCapability | null = null;

  async getCapability(): Promise<LocalRuntimeCapability> {
    const installedPacks = await this.getInstalledPacks();
    const supportedTasks = uniqueTasks(installedPacks);
    const locale = await this.getLanguageCode();
    const localeSupported =
      installedPacks.length === 0 ||
      installedPacks.some((pack) => pack.languages.includes(locale));

    const capability: LocalRuntimeCapability = {
      processing_mode_contract: ["cloud", "hybrid", "on_device"],
      offline_ready: installedPacks.length > 0,
      installed_packs: installedPacks,
      supported_tasks: localeSupported ? supportedTasks : supportedTasks.filter((task) => task === "ocr" || task === "slm"),
      fallback_mode: localeSupported ? "hybrid" : "cloud",
    };
    this.cachedCapability = capability;
    if (!localeSupported) {
      console.warn("[LocalRuntimeService] Locale mismatch; forcing STT/TTS fallback to cloud.");
    }
    return capability;
  }

  async getProcessingMode(): Promise<ProcessingMode> {
    const capability = await this.getCapability();
    if (capability.installed_packs.length === 0) return "cloud";

    const readiness = await this.getDeviceReadiness(capability.installed_packs[0]);
    if (!readiness.meetsRam) return "cloud";

    const securePreference = await readSecureValue(PROCESSING_MODE_KEY);
    const fallbackPreference = await Preferences.get({ key: PROCESSING_MODE_KEY }).then((result) => result.value);
    const preferred = isProcessingMode(securePreference)
      ? securePreference
      : isProcessingMode(fallbackPreference)
        ? fallbackPreference
        : "hybrid";

    if (preferred === "cloud") return "cloud";
    if (preferred === "on_device" && capability.offline_ready) return "on_device";
    return "hybrid";
  }

  async setProcessingMode(mode: ProcessingMode): Promise<ProcessingMode> {
    await writeSecureValue(PROCESSING_MODE_KEY, mode);
    await Preferences.set({ key: PROCESSING_MODE_KEY, value: mode });
    return this.getProcessingMode();
  }

  canRunLocally(task: LocalRuntimeTask): boolean {
    return Boolean(this.cachedCapability?.supported_tasks.includes(task));
  }

  async canRunLocallyAsync(task: LocalRuntimeTask): Promise<boolean> {
    const capability = await this.getCapability();
    return capability.supported_tasks.includes(task);
  }

  async getInstalledPacks(): Promise<ModelPackManifest[]> {
    const { value } = await Preferences.get({ key: INSTALLED_PACK_KEY });
    const manifest = safeParseManifest(value);
    if (!manifest) return [];
    try {
      const stat = await Filesystem.stat({
        path: `${MODEL_PACK_DIR}/${manifest.pack_id}.pack`,
        directory: Directory.Data,
      });
      if (stat.size > 0) return [manifest];
    } catch {
      await Preferences.remove({ key: INSTALLED_PACK_KEY });
    }
    return [];
  }

  async markPackInstalled(manifest: ModelPackManifest): Promise<void> {
    await Preferences.set({
      key: INSTALLED_PACK_KEY,
      value: JSON.stringify(manifest),
    });
    this.cachedCapability = null;
  }

  async clearInstalledPack(): Promise<void> {
    await Preferences.remove({ key: INSTALLED_PACK_KEY });
    this.cachedCapability = null;
  }

  async getDeviceReadiness(manifest?: ModelPackManifest): Promise<LocalRuntimeReadiness> {
    const [info, locale] = await Promise.all([
      Device.getInfo().catch(() => null),
      this.getLanguageCode(),
    ]);
    await Filesystem.mkdir({
      path: MODEL_PACK_DIR,
      directory: Directory.Data,
      recursive: true,
    }).catch(() => undefined);

    const ramFromEnv = Number(process.env.NEXT_PUBLIC_LOCAL_AI_DEVICE_RAM_GB || "");
    const detectedRamGb =
      Number.isFinite(ramFromEnv) && ramFromEnv > 0
        ? ramFromEnv
        : estimateRamGbFromModel(info?.model || "");
    const storageBytes = bytesToMb(
      (info as { realDiskFree?: number; diskFree?: number } | null)?.realDiskFree ??
        (info as { diskFree?: number } | null)?.diskFree
    );
    const requiredStorage = manifest ? manifest.min_storage_mb + STORAGE_BUFFER_MB : 0;
    const availableStorageMb = storageBytes;
    const localeSupported = manifest ? manifest.languages.includes(locale) : true;

    return {
      detectedRamGb,
      availableStorageMb,
      locale,
      meetsRam: !manifest || detectedRamGb === null || detectedRamGb >= manifest.min_ram_gb,
      meetsStorage: !manifest || availableStorageMb === null || availableStorageMb >= manifest.min_storage_mb,
      lowStorage: Boolean(manifest && availableStorageMb !== null && availableStorageMb < requiredStorage),
      localeSupported,
    };
  }

  triggerFallback(reason: string): void {
    const reasonCode = reason === "locale_mismatch" ? "locale_mismatch" : "local_exception";
    // PERF_BUDGET Cloud fallback trigger >= 99% success rate on all devices.
    emitLocalRuntimeEvent("cloud_fallback_triggered", {
      processing_mode: "cloud",
      fallback_mode: "cloud",
      reason_code: reasonCode,
      local_success: false,
    });
    void Preferences.set({ key: FALLBACK_MODE_KEY, value: "cloud" }).catch(() => undefined);
    void this.setProcessingMode("cloud").catch(() => undefined);
  }

  private async getLanguageCode(): Promise<string> {
    const result = await Device.getLanguageCode().catch(() => ({ value: "en" }));
    return String(result.value || "en").split("-", 1)[0]?.toLowerCase() || "en";
  }
}

export const localRuntimeService = new LocalRuntimeService();
export { MODEL_PACK_DIR, STORAGE_BUFFER_MB };

"use client";

import { Device } from "@capacitor/device";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Network } from "@capacitor/network";
import { Preferences } from "@capacitor/preferences";

import { emitLocalRuntimeEvent } from "@/lib/ai/local-runtime-events";
import {
  localRuntimeService,
  MODEL_PACK_DIR,
  STORAGE_BUFFER_MB,
  type LocalRuntimeCapability,
  type ModelPackManifest,
} from "@/lib/ai/local-runtime-service";
import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";

export type PackInstallStatus =
  | { state: "not_installed"; progressPct: 0 }
  | { state: "downloading"; progressPct: number }
  | { state: "installed"; progressPct: 100 };

type DownloadPolicy = {
  allowed: boolean;
  reason?: "network_policy" | "battery_policy" | "low_storage";
  warning?: string;
  availableStorageMb: number | null;
  networkType: "wifi" | "cellular" | "none" | "unknown";
  batteryLevelPct: number | null;
  isCharging: boolean | null;
};

const CHUNK_SIZE = 4 * 1024 * 1024;
const OFFSET_KEY_PREFIX = "kai_local_runtime_pack_offset:";
const STATUS_KEY = "kai_local_runtime_pack_status";

function offsetKey(packId: string): string {
  return `${OFFSET_KEY_PREFIX}${packId}`;
}

function partialPath(packId: string): string {
  return `${MODEL_PACK_DIR}/${packId}.partial`;
}

function activePath(packId: string): string {
  return `${MODEL_PACK_DIR}/${packId}.pack`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function fileDataToBytes(data: string | Blob): Promise<Uint8Array> {
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stableBytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeProgress(offsetBytes: number, sizeBytes: number): number {
  if (sizeBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((offsetBytes / sizeBytes) * 100)));
}

export class PackDownloadManager {
  private readonly downloadBasePath: string;

  constructor(input: { downloadBasePath?: string } = {}) {
    this.downloadBasePath = input.downloadBasePath || "/api/kai/local-runtime/packs";
  }

  async fetchCapability(): Promise<LocalRuntimeCapability> {
    const idToken = await AuthService.getIdToken();
    const response = await ApiService.apiFetch("/api/kai/local-runtime/capability", {
      method: "GET",
      headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
    });
    if (!response.ok) {
      throw new Error(`LOCAL_RUNTIME_CAPABILITY_HTTP_${response.status}`);
    }
    return (await response.json()) as LocalRuntimeCapability;
  }

  async getInstallStatus(): Promise<PackInstallStatus> {
    const installed = await localRuntimeService.getInstalledPacks();
    if (installed.length > 0) return { state: "installed", progressPct: 100 };
    const { value } = await Preferences.get({ key: STATUS_KEY });
    if (value === "downloading") {
      return { state: "downloading", progressPct: 0 };
    }
    return { state: "not_installed", progressPct: 0 };
  }

  async getInstallPolicy(manifest: ModelPackManifest): Promise<DownloadPolicy> {
    const [network, battery, readiness] = await Promise.all([
      Network.getStatus().catch(() => ({ connected: false, connectionType: "unknown" as const })),
      Device.getBatteryInfo().catch(() => ({ batteryLevel: undefined, isCharging: undefined })),
      localRuntimeService.getDeviceReadiness(manifest),
    ]);
    const networkType = network.connectionType;
    const batteryLevelPct =
      typeof battery.batteryLevel === "number"
        ? Math.round(battery.batteryLevel * 100)
        : null;
    const isCharging =
      typeof battery.isCharging === "boolean" ? battery.isCharging : null;

    if (!network.connected || networkType !== "wifi") {
      return {
        allowed: false,
        reason: "network_policy",
        availableStorageMb: readiness.availableStorageMb,
        networkType,
        batteryLevelPct,
        isCharging,
      };
    }
    if (isCharging === false) {
      return {
        allowed: false,
        reason: batteryLevelPct !== null && batteryLevelPct < 20 ? "battery_policy" : "battery_policy",
        availableStorageMb: readiness.availableStorageMb,
        networkType,
        batteryLevelPct,
        isCharging,
      };
    }
    if (readiness.lowStorage) {
      return {
        allowed: false,
        reason: "low_storage",
        warning: `AI pack needs ${manifest.min_storage_mb + STORAGE_BUFFER_MB} MB available.`,
        availableStorageMb: readiness.availableStorageMb,
        networkType,
        batteryLevelPct,
        isCharging,
      };
    }
    return {
      allowed: true,
      warning: readiness.meetsStorage ? undefined : "Storage could not be verified before download.",
      availableStorageMb: readiness.availableStorageMb,
      networkType,
      batteryLevelPct,
      isCharging,
    };
  }

  async downloadBalancedPack(
    onProgress?: (progressPct: number) => void
  ): Promise<ModelPackManifest> {
    const capability = await this.fetchCapability();
    const manifest = capability.installed_packs[0];
    if (!manifest) {
      throw new Error("LOCAL_RUNTIME_PACK_MANIFEST_MISSING");
    }
    return this.downloadPack(manifest, onProgress);
  }

  async downloadPack(
    manifest: ModelPackManifest,
    onProgress?: (progressPct: number) => void
  ): Promise<ModelPackManifest> {
    await Filesystem.mkdir({
      path: MODEL_PACK_DIR,
      directory: Directory.Data,
      recursive: true,
    }).catch(() => undefined);

    const policy = await this.getInstallPolicy(manifest);
    if (!policy.allowed) {
      emitLocalRuntimeEvent("model_pack_download_failed", {
        result: "expected_error",
        reason_code: policy.reason || "unknown",
        pack_id: "hussh-b-pack-v1",
        pack_version: manifest.version,
      });
      throw new Error(policy.warning || `LOCAL_RUNTIME_INSTALL_${policy.reason || "BLOCKED"}`);
    }

    let offset = Number((await Preferences.get({ key: offsetKey(manifest.pack_id) })).value || "0");
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    await Preferences.set({ key: STATUS_KEY, value: "downloading" });
    emitLocalRuntimeEvent("model_pack_download_started", {
      result: "success",
      pack_id: "hussh-b-pack-v1",
      pack_version: manifest.version,
      size_bytes: manifest.size_bytes,
      offset_bytes: offset,
      min_ram_gb: manifest.min_ram_gb,
      min_storage_mb: manifest.min_storage_mb,
      available_storage_mb: policy.availableStorageMb ?? undefined,
      battery_level_pct: policy.batteryLevelPct ?? undefined,
      is_charging: policy.isCharging ?? undefined,
      network_type: policy.networkType,
    });

    let failureEmitted = false;
    try {
      const idToken = await AuthService.getIdToken();
      while (offset < manifest.size_bytes) {
        const end = Math.min(offset + CHUNK_SIZE - 1, manifest.size_bytes - 1);
        const response = await ApiService.apiFetch(`${this.downloadBasePath}/${encodeURIComponent(manifest.pack_id)}`, {
          headers: {
            Range: `bytes=${offset}-${end}`,
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
        });
        if (!response.ok && response.status !== 206) {
          throw new Error(`LOCAL_RUNTIME_PACK_DOWNLOAD_HTTP_${response.status}`);
        }
        const chunk = await response.arrayBuffer();
        if (chunk.byteLength === 0) {
          throw new Error("LOCAL_RUNTIME_PACK_EMPTY_CHUNK");
        }
        await Filesystem.appendFile({
          path: partialPath(manifest.pack_id),
          directory: Directory.Data,
          data: arrayBufferToBase64(chunk),
        });
        offset += chunk.byteLength;
        await Preferences.set({ key: offsetKey(manifest.pack_id), value: String(offset) });
        const progressPct = normalizeProgress(offset, manifest.size_bytes);
        onProgress?.(progressPct);
      }

      const file = await Filesystem.readFile({
        path: partialPath(manifest.pack_id),
        directory: Directory.Data,
      });
      const checksum = await sha256Hex(await fileDataToBytes(file.data));
      if (checksum.toLowerCase() !== manifest.checksum.toLowerCase()) {
        await this.safeDeletePartial(manifest.pack_id);
        await localRuntimeService.clearInstalledPack();
        await Preferences.remove({ key: offsetKey(manifest.pack_id) });
        await Preferences.remove({ key: STATUS_KEY });
        emitLocalRuntimeEvent("model_pack_download_failed", {
          result: "error",
          reason_code: "checksum_mismatch",
          pack_id: "hussh-b-pack-v1",
          pack_version: manifest.version,
          offset_bytes: offset,
        });
        failureEmitted = true;
        throw new Error("LOCAL_RUNTIME_PACK_CHECKSUM_MISMATCH");
      }

      await Filesystem.rename({
        from: partialPath(manifest.pack_id),
        to: activePath(manifest.pack_id),
        directory: Directory.Data,
      });
      await localRuntimeService.markPackInstalled(manifest);
      await Preferences.remove({ key: offsetKey(manifest.pack_id) });
      await Preferences.remove({ key: STATUS_KEY });
      emitLocalRuntimeEvent("model_pack_download_completed", {
        result: "success",
        pack_id: "hussh-b-pack-v1",
        pack_version: manifest.version,
        size_bytes: manifest.size_bytes,
      });
      return manifest;
    } catch (error) {
      await Preferences.remove({ key: STATUS_KEY });
      if (!failureEmitted) {
        emitLocalRuntimeEvent("model_pack_download_failed", {
          result: "error",
          reason_code: "download_error",
          pack_id: "hussh-b-pack-v1",
          pack_version: manifest.version,
          offset_bytes: offset,
        });
      }
      throw error;
    }
  }

  private async safeDeletePartial(packId: string): Promise<void> {
    await Filesystem.deleteFile({
      path: partialPath(packId),
      directory: Directory.Data,
    }).catch(() => undefined);
  }
}

export const packDownloadManager = new PackDownloadManager();

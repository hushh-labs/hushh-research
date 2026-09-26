"use client";

import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import {
  CacheService,
  CACHE_KEYS,
  CACHE_TTL,
} from "@/lib/services/cache-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";

export interface TrustedDevice {
  device_id: string;
  device_name: string;
  platform: string;
  status: "active" | "revoked";
  created_at: number;
  last_used_at: number | null;
  // Added by migration 176; optional so an older payload still type-checks and
  // falls through to the honest "unavailable" / "not yet synced" states.
  revoked_at?: number | null;
  last_synced_at?: number | null;
  sealed_at?: number | null;
  // Added by migration 189; a fresh value is the only evidence the agent is
  // actually running, which last_synced_at can never establish.
  last_heartbeat_at?: number | null;
  heartbeat?: { current_model?: string; busy?: boolean } | null;
}

/** Metadata stays in owner-scoped memory; no device credentials are cached. */
export class TrustedDevicesResourceService {
  private static mutationRevision = 0;

  static async load(userId: string): Promise<TrustedDevice[]> {
    const owner = AuthService.getCurrentUser();
    const epoch = snapshotVaultSessionEpoch();
    const revision = this.mutationRevision;
    if (!owner || owner.uid !== userId)
      throw new Error("Sign in to view devices.");
    const response = await ApiService.listTrustedDevices();
    const payload = await response.json();
    if (!response.ok) throw new Error("Devices unavailable.");
    if (
      AuthService.getCurrentUser() !== owner ||
      !isVaultSessionEpochCurrent(epoch) ||
      revision !== this.mutationRevision
    ) {
      throw new Error("Device status changed. Refresh to try again.");
    }
    if (!Array.isArray(payload.devices))
      throw new Error("Devices unavailable.");
    const devices: TrustedDevice[] = payload.devices;
    CacheService.getInstance().set(
      CACHE_KEYS.TRUSTED_DEVICES(userId),
      devices,
      CACHE_TTL.SHORT,
    );
    return devices;
  }

  static async revoke(userId: string, deviceId: string): Promise<Response> {
    if (AuthService.getCurrentUser()?.uid !== userId)
      throw new Error("Sign in to manage devices.");
    const response = await ApiService.revokeTrustedDevice(deviceId);
    if (response.ok) {
      this.mutationRevision += 1;
      CacheSyncService.onTrustedDevicesMutated(userId);
    }
    return response;
  }
}

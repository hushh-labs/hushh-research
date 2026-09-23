import { ApiService } from "@/lib/services/api-service";
import {
  CacheService,
  CACHE_KEYS,
  CACHE_TTL,
} from "@/lib/services/cache-service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { googleConnectionEpoch } from "@/lib/cache/google-connection-epoch";
import {
  snapshotValidatedAuthSessionOwner,
  isValidatedAuthSessionOwnerCurrent,
  type AuthSessionOwnerSnapshot,
} from "@/lib/auth/session-owner";
import {
  snapshotVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";
import type { GoogleConnectionStatus } from "@/lib/services/google-connection-service";

export type DriveConnectionContext = {
  owner: AuthSessionOwnerSnapshot;
  vaultEpoch: number;
  getIdToken: () => Promise<string>;
  isEffectCurrent: () => boolean;
};
export type DriveNativeStart = {
  server_client_id: string;
  state: string;
  service: "drive";
  access_level: "read";
};
export type DriveWebStart = {
  authorize_url: string;
  expires_at: string;
  redirect_uri: string;
};

export function captureDriveConnectionContext(
  user: { uid: string; getIdToken: () => Promise<string> },
  isEffectCurrent: () => boolean,
): DriveConnectionContext {
  const owner = snapshotValidatedAuthSessionOwner();
  if (!owner || owner.userId !== user.uid)
    throw new DOMException("Connection session changed.", "AbortError");
  return {
    owner,
    vaultEpoch: snapshotVaultSessionEpoch(),
    getIdToken: () => user.getIdToken(),
    isEffectCurrent,
  };
}
export function isDriveConnectionCurrent(
  context: DriveConnectionContext,
): boolean {
  return (
    isValidatedAuthSessionOwnerCurrent(context.owner) &&
    isVaultSessionEpochCurrent(context.vaultEpoch) &&
    context.isEffectCurrent()
  );
}
function assertCurrent(context: DriveConnectionContext) {
  if (!isDriveConnectionCurrent(context))
    throw new DOMException("Connection session changed.", "AbortError");
}
function statusResult(value: unknown): GoogleConnectionStatus {
  const result = value as GoogleConnectionStatus | null;
  if (
    !result ||
    typeof result.connected !== "boolean" ||
    typeof result.configured !== "boolean" ||
    !["connected", "disconnected", "needs_reauth"].includes(result.status) ||
    (result.connected &&
      (result.status !== "connected" || result.access_level !== "read"))
  ) {
    throw new Error("Drive connection could not be verified.");
  }
  return {
    configured: result.configured,
    connected: result.connected,
    status: result.status,
    access_level: result.access_level === "read" ? "read" : null,
    google_email:
      typeof result.google_email === "string" ? result.google_email : null,
    scope_csv: typeof result.scope_csv === "string" ? result.scope_csv : "",
  };
}

/** Existing Google credential owner; no files, tokens or state enter persistence. */
export class GoogleDriveService {
  static cacheKey(context: DriveConnectionContext): string {
    return CACHE_KEYS.GOOGLE_CONNECTION(
      context.owner.userId,
      "drive",
      context.owner.generation,
      context.vaultEpoch,
      googleConnectionEpoch(context.owner.userId),
    );
  }
  private static async request(
    context: DriveConnectionContext,
    path: string,
    body?: Record<string, unknown>,
    current?: () => boolean,
  ): Promise<unknown> {
    assertCurrent(context);
    const token = await context.getIdToken();
    const isEffectCurrent = () =>
      isDriveConnectionCurrent(context) && (!current || current());
    if (!isEffectCurrent())
      throw new DOMException("Connection session changed.", "AbortError");
    const response = await ApiService.apiFetch(`/api/one/drive/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      isEffectCurrent,
    });
    if (!response.ok)
      throw new Error(
        "Drive connection could not be updated. Please try again.",
      );
    const value: unknown = await response.json();
    if (!isEffectCurrent())
      throw new DOMException("Connection session changed.", "AbortError");
    return value;
  }
  static async status(
    context: DriveConnectionContext,
    force = false,
  ): Promise<GoogleConnectionStatus> {
    assertCurrent(context);
    const cache = CacheService.getInstance();
    const key = this.cacheKey(context);
    const cached = cache.get<GoogleConnectionStatus>(key);
    if (cached && !force) return cached;
    const revision = googleConnectionEpoch(context.owner.userId);
    const result = statusResult(
      await this.request(
        context,
        `status/${encodeURIComponent(context.owner.userId)}`,
        undefined,
        () => googleConnectionEpoch(context.owner.userId) === revision,
      ),
    );
    cache.set(key, result, CACHE_TTL.SHORT);
    return result;
  }
  static invalidate(context: DriveConnectionContext): void {
    assertCurrent(context);
    CacheSyncService.onGoogleConnectionMutated(context.owner.userId);
  }
  static async startWeb(
    context: DriveConnectionContext,
  ): Promise<DriveWebStart> {
    this.invalidate(context);
    const result = (await this.request(context, "connect/start", {
      user_id: context.owner.userId,
      access_level: "read",
    })) as DriveWebStart;
    let url: URL;
    try {
      url = new URL(result?.authorize_url);
    } catch {
      throw new Error("Drive connection could not be prepared.");
    }
    if (
      url.origin !== "https://accounts.google.com" ||
      Boolean(url.username || url.password) ||
      url.pathname !== "/o/oauth2/v2/auth"
    )
      throw new Error("Drive connection could not be prepared.");
    return result;
  }
  static async startNative(
    context: DriveConnectionContext,
  ): Promise<DriveNativeStart> {
    this.invalidate(context);
    const result = (await this.request(context, "connect/native/start", {
      access_level: "read",
    })) as DriveNativeStart;
    if (
      result?.service !== "drive" ||
      result.access_level !== "read" ||
      typeof result.state !== "string" ||
      !result.state.trim() ||
      typeof result.server_client_id !== "string" ||
      !result.server_client_id.trim()
    )
      throw new Error("Drive connection could not be prepared.");
    return result;
  }
  static async completeNative(
    context: DriveConnectionContext,
    state: string,
    serverAuthCode: string,
  ): Promise<GoogleConnectionStatus> {
    assertCurrent(context);
    if (!state.trim() || !serverAuthCode.trim())
      throw new Error("Restart the Drive connection.");
    const result = statusResult(
      await this.request(context, "connect/native/complete", {
        user_id: context.owner.userId,
        state,
        server_auth_code: serverAuthCode,
        access_level: "read",
      }),
    );
    this.invalidate(context);
    CacheService.getInstance().set(
      this.cacheKey(context),
      result,
      CACHE_TTL.SHORT,
    );
    return result;
  }
  static async disconnect(
    context: DriveConnectionContext,
  ): Promise<GoogleConnectionStatus> {
    this.invalidate(context);
    const result = statusResult(
      await this.request(context, "disconnect", {
        user_id: context.owner.userId,
      }),
    );
    this.invalidate(context);
    CacheService.getInstance().set(
      this.cacheKey(context),
      result,
      CACHE_TTL.SHORT,
    );
    return result;
  }
}

"use client";

/**
 * Owner-level Location sharing posture (migration 221), as the client sees it.
 *
 * `GET/PATCH /api/one/location/account-settings` is the ONE contract shared by
 * the tap UI and the One Live Voice tools (`turn_sharing_on`,
 * `turn_sharing_off`, `set_precision`). The server's persisted `sharing_state`
 * is the only thing that may ever be rendered as "sharing is on"; the OS
 * permission is a separate fact and is composed with it in
 * `lib/location/sharing-state.ts`.
 *
 * The in-memory resource below lets every screen and the app-level publisher
 * bridge read one value and react to one change, without any of them keeping
 * a private copy. Nothing here is persisted: the vault owner token is passed
 * in by the caller and never stored.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { useAuth } from "@/hooks/use-auth";
import { ApiError, apiJson } from "@/lib/services/api-client";
import { ApiService } from "@/lib/services/api-service";
import { useVault } from "@/lib/vault/vault-context";

export type LocationSharingState = "unset" | "on" | "off";
export type LocationPrecision = "precise" | "approximate";
export type LocationOsPermissionReported =
  "unknown" | "prompt" | "granted" | "denied";

/**
 * `AccountSettings.as_payload()` on the backend, normalized.
 *
 * The wire fields are snake_case; the camelCase members are aliases of the
 * same values so screens can read either. Both are always populated.
 */
export type LocationAccountSettings = {
  user_id?: string;
  sharing_state: LocationSharingState;
  sharing_enabled: boolean;
  precision: LocationPrecision;
  sharing_consent_version: string | null;
  sharing_consent_accepted_at: string | null;
  sharing_enabled_at: string | null;
  sharing_disabled_at: string | null;
  os_permission_reported: LocationOsPermissionReported;
  os_permission_reported_at: string | null;
  /** Alias of `sharing_state`. */
  sharingState: LocationSharingState;
  /** Alias of `sharing_enabled` (`sharing_state === "on"`). */
  sharingEnabled: boolean;
  /** Alias of `sharing_consent_version`. */
  sharingConsentVersion: string | null;
  /** Alias of `sharing_consent_accepted_at`. */
  sharingConsentAcceptedAt: string | null;
  /** Alias of `os_permission_reported`. */
  osPermissionReported: LocationOsPermissionReported;
};

/** `SharingTransition.as_payload()`; present only when `sharingState` changed. */
export type LocationSharingTransition = {
  settings: LocationAccountSettings;
  changed: boolean;
  revoked_grant_ids: string[];
  revoked_link_ids: string[];
  notified_recipients: number;
};

export type LocationAccountSettingsPatch = {
  sharingState?: "on" | "off";
  precision?: LocationPrecision;
  includeSos?: boolean;
  consentVersion?: string;
  osPermissionReported?: LocationOsPermissionReported;
};

export type LocationAccountSettingsUpdate = {
  settings: LocationAccountSettings;
  transition?: LocationSharingTransition;
};

/** Error codes the settings routes answer with (`detail.code`). */
export type LocationAccountSettingsErrorCode =
  | "LOCATION_SHARING_CONSENT_REQUIRED"
  | "LOCATION_SOS_ACTIVE"
  | "LOCATION_SHARING_OFF"
  | "LOCATION_PRECISION_MISMATCH"
  | "LOCATION_SETUP_CONSENT_REQUIRED"
  | "LOCATION_SETUP_STEP_ORDER"
  | "LOCATION_RECIPIENT_KEY_MISSING";

const ACCOUNT_SETTINGS_PATH = "/api/one/location/account-settings";

function jsonHeaders(vaultOwnerToken: string): HeadersInit {
  return {
    ...ApiService.getAuthHeaders(vaultOwnerToken),
    "Content-Type": "application/json",
  };
}

function normalizeSharingState(value: unknown): LocationSharingState {
  return value === "on" || value === "off" ? value : "unset";
}

function normalizePrecision(value: unknown): LocationPrecision {
  return value === "approximate" ? "approximate" : "precise";
}

function normalizeOsPermission(value: unknown): LocationOsPermissionReported {
  return value === "prompt" || value === "granted" || value === "denied"
    ? value
    : "unknown";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Read a settings payload defensively. The server owns the shape, but a
 * missing row is legitimately `unset`, and an unexpected string must never
 * be rendered as "on".
 */
export function normalizeLocationAccountSettings(
  raw: unknown,
): LocationAccountSettings {
  const row =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  // Accept either spelling on input so a merge of an already-normalized
  // value (or a tool result) reads the same as a wire payload.
  const sharingState = normalizeSharingState(
    row.sharing_state ?? row.sharingState,
  );
  const consentVersion = nullableString(
    row.sharing_consent_version ?? row.sharingConsentVersion,
  );
  const consentAcceptedAt = nullableString(
    row.sharing_consent_accepted_at ?? row.sharingConsentAcceptedAt,
  );
  const osPermission = normalizeOsPermission(
    row.os_permission_reported ?? row.osPermissionReported,
  );
  return {
    user_id: nullableString(row.user_id) ?? undefined,
    sharing_state: sharingState,
    sharing_enabled: sharingState === "on",
    precision: normalizePrecision(row.precision),
    sharing_consent_version: consentVersion,
    sharing_consent_accepted_at: consentAcceptedAt,
    sharing_enabled_at: nullableString(row.sharing_enabled_at),
    sharing_disabled_at: nullableString(row.sharing_disabled_at),
    os_permission_reported: osPermission,
    os_permission_reported_at: nullableString(row.os_permission_reported_at),
    sharingState,
    sharingEnabled: sharingState === "on",
    sharingConsentVersion: consentVersion,
    sharingConsentAcceptedAt: consentAcceptedAt,
    osPermissionReported: osPermission,
  };
}

function normalizeTransition(
  raw: unknown,
): LocationSharingTransition | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  return {
    settings: normalizeLocationAccountSettings(row.settings),
    changed: row.changed === true,
    revoked_grant_ids: Array.isArray(row.revoked_grant_ids)
      ? row.revoked_grant_ids.map(String)
      : [],
    revoked_link_ids: Array.isArray(row.revoked_link_ids)
      ? row.revoked_link_ids.map(String)
      : [],
    notified_recipients: Number(row.notified_recipients) || 0,
  };
}

/** GET the persisted posture. Vault-owner bearer only. */
export async function getLocationAccountSettings(
  vaultOwnerToken: string,
): Promise<LocationAccountSettings> {
  const response = await apiJson<{ settings?: unknown }>(
    ACCOUNT_SETTINGS_PATH,
    { headers: ApiService.getAuthHeaders(vaultOwnerToken) },
  );
  return normalizeLocationAccountSettings(response?.settings);
}

/**
 * PATCH one or more posture changes.
 *
 * `sharingState: "off"` revokes every active share and link in the same
 * transaction on the server; the returned `transition` says what stopped.
 */
export async function updateLocationAccountSettings(
  vaultOwnerToken: string,
  patch: LocationAccountSettingsPatch,
): Promise<LocationAccountSettingsUpdate> {
  const body: Record<string, unknown> = {};
  if (patch.sharingState !== undefined) body.sharingState = patch.sharingState;
  if (patch.precision !== undefined) body.precision = patch.precision;
  if (patch.includeSos !== undefined) body.includeSos = patch.includeSos;
  if (patch.consentVersion !== undefined)
    body.consentVersion = patch.consentVersion;
  if (patch.osPermissionReported !== undefined)
    body.osPermissionReported = patch.osPermissionReported;
  const response = await apiJson<{ settings?: unknown; transition?: unknown }>(
    ACCOUNT_SETTINGS_PATH,
    {
      method: "PATCH",
      headers: jsonHeaders(vaultOwnerToken),
      body: JSON.stringify(body),
    },
  );
  return {
    settings: normalizeLocationAccountSettings(response?.settings),
    transition: normalizeTransition(response?.transition),
  };
}

/** The stable `detail.code` behind a settings/setup failure, if any. */
export function locationSettingsErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const payload = error.payload;
  if (!payload || typeof payload !== "object") return null;
  const detail = (payload as { detail?: unknown }).detail;
  if (detail && typeof detail === "object") {
    const code = (detail as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" && code ? code : null;
}

// ---------------------------------------------------------------------------
// In-memory resource (one value per signed-in user, shared by every screen)
// ---------------------------------------------------------------------------

export type LocationAccountSettingsResourceStatus =
  "idle" | "loading" | "ready" | "error";

export type LocationAccountSettingsSnapshot = {
  status: LocationAccountSettingsResourceStatus;
  settings: LocationAccountSettings | null;
  error: string | null;
};

const IDLE_SNAPSHOT: LocationAccountSettingsSnapshot = {
  status: "idle",
  settings: null,
  error: null,
};

const snapshotsByUser = new Map<string, LocationAccountSettingsSnapshot>();
const listenersByUser = new Map<
  string,
  Set<(snapshot: LocationAccountSettingsSnapshot) => void>
>();
const inFlightByUser = new Map<string, Promise<LocationAccountSettings>>();

function emit(userId: string, next: LocationAccountSettingsSnapshot): void {
  snapshotsByUser.set(userId, next);
  for (const listener of listenersByUser.get(userId) ?? []) listener(next);
}

export const LocationAccountSettingsResource = {
  peek(userId: string | null | undefined): LocationAccountSettingsSnapshot {
    if (!userId) return IDLE_SNAPSHOT;
    return snapshotsByUser.get(userId) ?? IDLE_SNAPSHOT;
  },

  subscribe(
    userId: string,
    listener: (snapshot: LocationAccountSettingsSnapshot) => void,
  ): () => void {
    const listeners =
      listenersByUser.get(userId) ??
      new Set<(snapshot: LocationAccountSettingsSnapshot) => void>();
    listeners.add(listener);
    listenersByUser.set(userId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByUser.delete(userId);
    };
  },

  /**
   * Fetch (coalesced) and publish. `force` re-reads even when a value is held;
   * without it a ready snapshot is returned as-is.
   */
  load(
    userId: string,
    vaultOwnerToken: string,
    options?: { force?: boolean },
  ): Promise<LocationAccountSettings> {
    const current = this.peek(userId);
    if (!options?.force && current.status === "ready" && current.settings) {
      return Promise.resolve(current.settings);
    }
    const existing = inFlightByUser.get(userId);
    if (existing) return existing;
    emit(userId, {
      status: "loading",
      settings: current.settings,
      error: null,
    });
    const request = getLocationAccountSettings(vaultOwnerToken)
      .then((settings) => {
        emit(userId, { status: "ready", settings, error: null });
        return settings;
      })
      .catch((error: unknown) => {
        emit(userId, {
          status: "error",
          settings: this.peek(userId).settings,
          error:
            error instanceof Error
              ? error.message
              : "Could not read Location settings.",
        });
        throw error;
      })
      .finally(() => {
        if (inFlightByUser.get(userId) === request) {
          inFlightByUser.delete(userId);
        }
      });
    inFlightByUser.set(userId, request);
    return request;
  },

  /** Publish an authoritative value (a PATCH response, a tool result). */
  write(userId: string, settings: LocationAccountSettings): void {
    inFlightByUser.delete(userId);
    emit(userId, { status: "ready", settings, error: null });
  },

  /**
   * Apply a partial, server-originated fact (e.g. `sharing_state: "off"` from
   * a `turn_sharing_off` tool result) on top of the held value. Never used
   * for anything a client merely believes.
   */
  merge(userId: string, patch: Partial<LocationAccountSettings>): void {
    const current = this.peek(userId).settings;
    if (!current) return;
    // A patch may use either spelling; fold the aliases onto the wire keys
    // so they win over the held value rather than being shadowed by it.
    const wire: Record<string, unknown> = { ...patch };
    if (patch.sharingState !== undefined)
      wire.sharing_state = patch.sharingState;
    if (patch.sharingConsentVersion !== undefined)
      wire.sharing_consent_version = patch.sharingConsentVersion;
    if (patch.sharingConsentAcceptedAt !== undefined)
      wire.sharing_consent_accepted_at = patch.sharingConsentAcceptedAt;
    if (patch.osPermissionReported !== undefined)
      wire.os_permission_reported = patch.osPermissionReported;
    const next = normalizeLocationAccountSettings({ ...current, ...wire });
    emit(userId, { status: "ready", settings: next, error: null });
  },

  /** Drop the held value so the next `load` re-reads. */
  invalidate(userId: string): void {
    inFlightByUser.delete(userId);
    const current = this.peek(userId);
    emit(userId, { ...current, status: "idle" });
  },

  /** Cross a privacy boundary (sign-out, vault lock). */
  discard(userId: string): void {
    inFlightByUser.delete(userId);
    snapshotsByUser.delete(userId);
    for (const listener of listenersByUser.get(userId) ?? []) {
      listener(IDLE_SNAPSHOT);
    }
  },

  /** Test seam. */
  __resetForTests(): void {
    snapshotsByUser.clear();
    listenersByUser.clear();
    inFlightByUser.clear();
  },
};

export type UseLocationAccountSettings = LocationAccountSettingsSnapshot & {
  /** Re-read from the server. */
  refresh: () => Promise<LocationAccountSettings | null>;
  /** PATCH and publish the authoritative response. */
  update: (
    patch: LocationAccountSettingsPatch,
  ) => Promise<LocationAccountSettingsUpdate>;
};

/**
 * Read (and change) the signed-in user's sharing posture.
 *
 * Loads once per user while the vault is unlocked; every mounted consumer
 * shares the same snapshot. `update` PATCHes and publishes the response so
 * the change reaches every screen at once.
 */
export function useLocationAccountSettings(): UseLocationAccountSettings {
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const uid = userId ?? null;

  const snapshot = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        uid
          ? LocationAccountSettingsResource.subscribe(uid, onChange)
          : () => undefined,
      [uid],
    ),
    () => LocationAccountSettingsResource.peek(uid),
    () => IDLE_SNAPSHOT,
  );

  useEffect(() => {
    if (!uid || !vaultOwnerToken) return;
    const current = LocationAccountSettingsResource.peek(uid);
    if (current.status !== "idle") return;
    void LocationAccountSettingsResource.load(uid, vaultOwnerToken).catch(
      () => undefined,
    );
  }, [uid, vaultOwnerToken, snapshot.status]);

  const refresh = useCallback(async () => {
    if (!uid || !vaultOwnerToken) return null;
    try {
      return await LocationAccountSettingsResource.load(uid, vaultOwnerToken, {
        force: true,
      });
    } catch {
      return null;
    }
  }, [uid, vaultOwnerToken]);

  const update = useCallback(
    async (patch: LocationAccountSettingsPatch) => {
      if (!uid || !vaultOwnerToken) {
        throw new Error("Unlock your vault to change Location settings.");
      }
      const result = await updateLocationAccountSettings(
        vaultOwnerToken,
        patch,
      );
      LocationAccountSettingsResource.write(uid, result.settings);
      return result;
    },
    [uid, vaultOwnerToken],
  );

  return useMemo(
    () => ({ ...snapshot, refresh, update }),
    [snapshot, refresh, update],
  );
}

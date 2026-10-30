"use client";

/**
 * The one honest answer to "is my location being shared?"
 *
 * Four independent authorities are composed here and NEVER collapsed into a
 * single boolean on screen:
 *  - the OS permission (device), read through `LocationBus.syncPermission`;
 *  - the persisted app posture (`sharing_state`) from account settings;
 *  - the device pause preference (`location-control-state`);
 *  - the active owner grants from the shared state resource.
 *
 * `effective` is derived and is the only field a "sharing" word may come
 * from: it is `"sharing"` if and only if the server says `sharing_state ===
 * "on"` AND the OS permission is granted AND the device is not paused.
 * Screens still show device permission, app sharing, and precision as three
 * distinct rows — this hook gives them the three facts, not a summary.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  useLocationAccountSettings,
  type LocationAccountSettings,
  type LocationPrecision,
  type LocationSharingState,
} from "@/lib/location/account-settings";
import {
  LocationBus,
  type LocationPermission,
} from "@/lib/one-location/location-bus";
import {
  readOneLocationControlState,
  subscribeOneLocationControlState,
} from "@/lib/one-location/location-control-state";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationGrant,
  OneLocationState,
} from "@/lib/one-location/types";
import { CACHE_KEYS, CacheService } from "@/lib/services/cache-service";
import { useVault } from "@/lib/vault/vault-context";

export type LocationOsPermission =
  "granted" | "denied" | "prompt" | "restricted" | "unavailable" | "unknown";

export type LocationEffectiveSharing =
  "sharing" | "off" | "blocked_by_os" | "paused" | "unset";

export type LocationSharingStateView = {
  /** Device permission, as the OS last reported it. */
  os: LocationOsPermission;
  /** Alias of `os` for screens that read the longer name. */
  osPermission: LocationOsPermission;
  /** iOS precise-location switch; null where the platform does not say. */
  osPrecise: boolean | null;
  /** `settings.sharing_state === "on"` — the persisted app posture, nothing else. */
  appSharing: boolean;
  sharingState: LocationSharingState;
  precision: LocationPrecision;
  paused: boolean;
  effective: LocationEffectiveSharing;
  activeShareCount: number;
  /** True until both the OS and the server have answered once. */
  resolving: boolean;
};

export const OS_PERMISSION_UNKNOWN: LocationOsPermission = "unknown";

/** Pure: the effective posture from the three facts. */
export function deriveEffectiveSharing(params: {
  os: LocationOsPermission;
  sharingState: LocationSharingState;
  paused: boolean;
}): LocationEffectiveSharing {
  if (params.sharingState === "unset") return "unset";
  if (params.sharingState === "off") return "off";
  if (params.os !== "granted") return "blocked_by_os";
  if (params.paused) return "paused";
  return "sharing";
}

/** Active owner grants: status active and not past their expiry. */
export function countActiveOwnerGrants(
  state: Pick<OneLocationState, "ownerGrants"> | null | undefined,
  now: number = Date.now(),
): number {
  return activeOwnerGrants(state, now).length;
}

export function activeOwnerGrants(
  state: Pick<OneLocationState, "ownerGrants"> | null | undefined,
  now: number = Date.now(),
): OneLocationGrant[] {
  if (!state?.ownerGrants) return [];
  return state.ownerGrants.filter((grant) => {
    if (grant.status !== "active") return false;
    if (!grant.expiresAt) return true;
    const expires = Date.parse(grant.expiresAt);
    return !Number.isFinite(expires) || expires > now;
  });
}

/** Pure composition; the hook below feeds it live values. */
export function composeLocationSharingState(input: {
  os: LocationOsPermission;
  osPrecise: boolean | null;
  settings: LocationAccountSettings | null;
  paused: boolean;
  activeShareCount: number;
  resolving?: boolean;
}): LocationSharingStateView {
  const sharingState: LocationSharingState =
    input.settings?.sharing_state ?? "unset";
  const precision: LocationPrecision = input.settings?.precision ?? "precise";
  const effective = deriveEffectiveSharing({
    os: input.os,
    sharingState,
    paused: input.paused,
  });
  return {
    os: input.os,
    osPermission: input.os,
    osPrecise: input.osPrecise,
    appSharing: sharingState === "on",
    sharingState,
    precision,
    paused: input.paused,
    effective,
    activeShareCount: input.activeShareCount,
    resolving: input.resolving ?? false,
  };
}

function toOsPermission(
  permission: LocationPermission | null | undefined,
): LocationOsPermission {
  switch (permission) {
    case "granted":
    case "denied":
    case "prompt":
    case "restricted":
    case "unavailable":
      return permission;
    default:
      return "unknown";
  }
}

/** Window event the service dispatches after every permission prompt. */
const PERMISSION_OBSERVED_EVENT = "hushh:location-permission-observed";

/**
 * The OS permission and precise flag, kept current without ever prompting.
 * Re-reads when the tab regains focus (the person may have changed Settings)
 * and whenever any surface observes a prompt result.
 */
export function useOsLocationPermission(): {
  os: LocationOsPermission;
  osPrecise: boolean | null;
  resolved: boolean;
  resync: () => Promise<void>;
} {
  const bus = useSyncExternalStore(
    LocationBus.subscribe,
    LocationBus.getState,
    LocationBus.getState,
  );
  const [precise, setPrecise] = useState<boolean | null>(null);
  const [resolved, setResolved] = useState(false);

  const resync = useCallback(async () => {
    try {
      // The bus write keeps every other consumer in step; the direct read is
      // the only place the `precise` flag is exposed.
      const [, full] = await Promise.all([
        LocationBus.syncPermission(),
        OneLocationService.getPermissionState().catch(() => null),
      ]);
      setPrecise(typeof full?.precise === "boolean" ? full.precise : null);
    } finally {
      setResolved(true);
    }
  }, []);

  useEffect(() => {
    void resync();
    if (typeof window === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void resync();
    };
    const onObserved = () => void resync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onObserved);
    window.addEventListener(PERMISSION_OBSERVED_EVENT, onObserved);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onObserved);
      window.removeEventListener(PERMISSION_OBSERVED_EVENT, onObserved);
    };
  }, [resync]);

  return {
    os: toOsPermission(bus.permission),
    osPrecise: precise,
    resolved,
    resync,
  };
}

/** The device pause preference for the signed-in user. */
export function useLocationPaused(userId: string | null): boolean {
  return useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        userId
          ? subscribeOneLocationControlState(userId, onChange)
          : () => undefined,
      [userId],
    ),
    () => readOneLocationControlState(userId).paused,
    () => false,
  );
}

/**
 * The shared Location state (owner grants, recipients) for the signed-in
 * user, from the memory-only presentation resource. Loads once per user
 * when a vault-owner token is available and re-reads on invalidation.
 */
export function useOneLocationStateSnapshot(): OneLocationState | null {
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const uid = userId ?? null;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!uid) return;
    const key = CACHE_KEYS.ONE_LOCATION_STATE(uid);
    return CacheService.getInstance().subscribe((event) => {
      if (event.type === "clear") setTick((value) => value + 1);
      else if (event.type === "set" && event.key === key)
        setTick((value) => value + 1);
      else if (
        (event.type === "invalidate" || event.type === "invalidate_user") &&
        event.keys.includes(key)
      )
        setTick((value) => value + 1);
    });
  }, [uid]);

  const snapshot = useMemo(
    () => (uid ? OneLocationStateResource.readPresentation(uid) : null),
    // `tick` is the subscription signal; the resource itself is not reactive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uid, tick],
  );

  useEffect(() => {
    if (!uid || !vaultOwnerToken) return;
    if (OneLocationStateResource.peek(uid)?.data) return;
    void OneLocationStateResource.load(uid, () =>
      OneLocationService.getState(vaultOwnerToken),
    ).catch(() => undefined);
  }, [uid, vaultOwnerToken, tick]);

  return snapshot;
}

export type LocationSharingStatus = "loading" | "ready" | "error";

export type UseLocationSharingState = LocationSharingStateView & {
  /** `loading` until the OS and the server have both answered once. */
  status: LocationSharingStatus;
  /** Re-read the server posture and the OS permission. */
  refresh: () => Promise<void>;
};

/**
 * Compose the four authorities into one view. See the module comment for
 * the invariant: `effective === "sharing"` requires the server's persisted
 * `sharing_state === "on"` AND an OS grant AND no pause.
 */
export function useLocationSharingState(): UseLocationSharingState {
  const { userId } = useAuth();
  const uid = userId ?? null;
  const settings = useLocationAccountSettings();
  const permission = useOsLocationPermission();
  const paused = useLocationPaused(uid);
  const state = useOneLocationStateSnapshot();
  const activeShareCount = useMemo(
    () => countActiveOwnerGrants(state),
    [state],
  );

  const resolving =
    !permission.resolved ||
    settings.status === "idle" ||
    settings.status === "loading";
  const status: LocationSharingStatus = resolving
    ? "loading"
    : settings.status === "error" && !settings.settings
      ? "error"
      : "ready";

  const settingsRefresh = settings.refresh;
  const permissionResync = permission.resync;
  const refresh = useCallback(async () => {
    await Promise.all([settingsRefresh(), permissionResync()]);
  }, [settingsRefresh, permissionResync]);

  return useMemo(
    () => ({
      ...composeLocationSharingState({
        os: permission.os,
        osPrecise: permission.osPrecise,
        settings: settings.settings,
        paused,
        activeShareCount,
        resolving,
      }),
      status,
      refresh,
    }),
    [
      permission.os,
      permission.osPrecise,
      settings.settings,
      paused,
      activeShareCount,
      resolving,
      status,
      refresh,
    ],
  );
}

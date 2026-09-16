"use client";

/**
 * Voice-first Location setup progress (migration 223), client side.
 *
 * The server is the only source of truth for where a person is in setup:
 * `intro -> consent -> os_permission -> precision -> recipient_key -> done`.
 * Nothing is kept in sessionStorage, so a reload, a second device, or the
 * voice tools (`start_location_setup`, `accept_location_setup_consent`,
 * `advance_location_setup`) all resume from the same persisted step. Every
 * tap CTA in the setup flow calls the same PATCH the voice tool calls.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { useAuth } from "@/hooks/use-auth";
import type {
  LocationOsPermissionReported,
  LocationPrecision,
} from "@/lib/location/account-settings";
import { apiJson } from "@/lib/services/api-client";
import { ApiService } from "@/lib/services/api-service";
import { useVault } from "@/lib/vault/vault-context";

export type LocationSetupStep =
  | "intro"
  | "consent"
  | "os_permission"
  | "precision"
  | "recipient_key"
  | "done";

/** Server order; mirrored so the client can compare positions. */
export const LOCATION_SETUP_STEPS: readonly LocationSetupStep[] = [
  "intro",
  "consent",
  "os_permission",
  "precision",
  "recipient_key",
  "done",
];

/**
 * The Location sharing consent shown in the setup flow. Sent verbatim with
 * `accept_consent` and, by the voice owner, with
 * `accept_location_setup_consent(consent_version)`. Bump it when the copy in
 * `components/location/setup/steps/consent-step.tsx` changes meaning.
 */
export const LOCATION_SHARING_CONSENT_VERSION = "one-location-sharing-v1";

/** `SetupProgress.as_payload()` on the backend. */
export type LocationSetupProgress = {
  user_id?: string;
  step: LocationSetupStep;
  next_step: LocationSetupStep | null;
  started: boolean;
  completed: boolean;
  consent_version: string | null;
  consent_accepted_at: string | null;
  os_permission_state: LocationOsPermissionReported;
  precision: LocationPrecision | null;
  recipient_key_registered_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: LocationSetupStep[];
};

export type LocationSetupAdvance =
  | { action: "start" }
  | { action: "accept_consent"; consentVersion: string }
  | {
      action: "record_os_permission";
      osPermissionState: LocationOsPermissionReported;
    }
  | { action: "set_precision"; precision: LocationPrecision }
  | { action: "confirm_recipient_key" }
  | { action: "complete" };

const SETUP_PROGRESS_PATH = "/api/one/location/setup-progress";

function isStep(value: unknown): value is LocationSetupStep {
  return (
    typeof value === "string" &&
    (LOCATION_SETUP_STEPS as readonly string[]).includes(value)
  );
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** The progress that "not started" looks like; also the fail-closed shape. */
export const NOT_STARTED_PROGRESS: LocationSetupProgress = {
  step: "intro",
  next_step: "consent",
  started: false,
  completed: false,
  consent_version: null,
  consent_accepted_at: null,
  os_permission_state: "unknown",
  precision: null,
  recipient_key_registered_at: null,
  started_at: null,
  completed_at: null,
  steps: [...LOCATION_SETUP_STEPS],
};

export function normalizeLocationSetupProgress(
  raw: unknown,
): LocationSetupProgress {
  const row =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const step = isStep(row.step) ? row.step : "intro";
  const index = LOCATION_SETUP_STEPS.indexOf(step);
  const derivedNext =
    index + 1 < LOCATION_SETUP_STEPS.length
      ? LOCATION_SETUP_STEPS[index + 1]!
      : null;
  const startedAt = nullableString(row.started_at);
  const completedAt = nullableString(row.completed_at);
  const osPermission = row.os_permission_state;
  const precision = row.precision;
  return {
    user_id: nullableString(row.user_id) ?? undefined,
    step,
    next_step: isStep(row.next_step)
      ? row.next_step
      : row.next_step === null
        ? null
        : derivedNext,
    started:
      typeof row.started === "boolean" ? row.started : startedAt !== null,
    completed:
      typeof row.completed === "boolean"
        ? row.completed
        : step === "done" && completedAt !== null,
    consent_version: nullableString(row.consent_version),
    consent_accepted_at: nullableString(row.consent_accepted_at),
    os_permission_state:
      osPermission === "prompt" ||
      osPermission === "granted" ||
      osPermission === "denied"
        ? osPermission
        : "unknown",
    precision:
      precision === "precise" || precision === "approximate" ? precision : null,
    recipient_key_registered_at: nullableString(
      row.recipient_key_registered_at,
    ),
    started_at: startedAt,
    completed_at: completedAt,
    steps: Array.isArray(row.steps)
      ? row.steps.filter(isStep)
      : [...LOCATION_SETUP_STEPS],
  };
}

/**
 * Which screen the flow shows for a persisted progress row.
 *
 * `progress.step` is the last step the server recorded; the screen to show is
 * the one after it. A run that never started shows the intro; a completed
 * run shows done. Pure so it can be pinned by tests.
 */
export function currentLocationSetupStep(
  progress: LocationSetupProgress | null | undefined,
): LocationSetupStep {
  if (!progress || !progress.started) return "intro";
  if (progress.completed || progress.step === "done") return "done";
  return progress.next_step ?? "done";
}

/** True once the server recorded consent (the OS prompt may be requested). */
export function hasAcceptedLocationConsent(
  progress: LocationSetupProgress | null | undefined,
): boolean {
  return Boolean(progress?.consent_accepted_at);
}

export async function getSetupProgress(
  vaultOwnerToken: string,
): Promise<LocationSetupProgress> {
  const response = await apiJson<{ progress?: unknown }>(SETUP_PROGRESS_PATH, {
    headers: ApiService.getAuthHeaders(vaultOwnerToken),
  });
  return normalizeLocationSetupProgress(response?.progress);
}

/** One transition per call; the server enforces the order. */
export async function advanceSetupProgress(
  vaultOwnerToken: string,
  advance: LocationSetupAdvance,
): Promise<LocationSetupProgress> {
  const body: Record<string, unknown> = { action: advance.action };
  if (advance.action === "accept_consent")
    body.consentVersion = advance.consentVersion;
  if (advance.action === "record_os_permission")
    body.osPermissionState = advance.osPermissionState;
  if (advance.action === "set_precision") body.precision = advance.precision;
  const response = await apiJson<{ progress?: unknown }>(SETUP_PROGRESS_PATH, {
    method: "PATCH",
    headers: {
      ...ApiService.getAuthHeaders(vaultOwnerToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return normalizeLocationSetupProgress(response?.progress);
}

// ---------------------------------------------------------------------------
// In-memory resource shared by the flow and the publisher bridge
// ---------------------------------------------------------------------------

export type LocationSetupProgressStatus =
  "idle" | "loading" | "ready" | "error";

export type LocationSetupProgressSnapshot = {
  status: LocationSetupProgressStatus;
  progress: LocationSetupProgress | null;
  error: string | null;
};

const IDLE_SNAPSHOT: LocationSetupProgressSnapshot = {
  status: "idle",
  progress: null,
  error: null,
};

const snapshotsByUser = new Map<string, LocationSetupProgressSnapshot>();
const listenersByUser = new Map<
  string,
  Set<(snapshot: LocationSetupProgressSnapshot) => void>
>();
const inFlightByUser = new Map<string, Promise<LocationSetupProgress>>();

function emit(userId: string, next: LocationSetupProgressSnapshot): void {
  snapshotsByUser.set(userId, next);
  for (const listener of listenersByUser.get(userId) ?? []) listener(next);
}

export const LocationSetupProgressResource = {
  peek(userId: string | null | undefined): LocationSetupProgressSnapshot {
    if (!userId) return IDLE_SNAPSHOT;
    return snapshotsByUser.get(userId) ?? IDLE_SNAPSHOT;
  },

  subscribe(
    userId: string,
    listener: (snapshot: LocationSetupProgressSnapshot) => void,
  ): () => void {
    const listeners =
      listenersByUser.get(userId) ??
      new Set<(snapshot: LocationSetupProgressSnapshot) => void>();
    listeners.add(listener);
    listenersByUser.set(userId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByUser.delete(userId);
    };
  },

  load(
    userId: string,
    vaultOwnerToken: string,
    options?: { force?: boolean },
  ): Promise<LocationSetupProgress> {
    const current = this.peek(userId);
    if (!options?.force && current.status === "ready" && current.progress) {
      return Promise.resolve(current.progress);
    }
    const existing = inFlightByUser.get(userId);
    if (existing) return existing;
    emit(userId, {
      status: "loading",
      progress: current.progress,
      error: null,
    });
    const request = getSetupProgress(vaultOwnerToken)
      .then((progress) => {
        emit(userId, { status: "ready", progress, error: null });
        return progress;
      })
      .catch((error: unknown) => {
        emit(userId, {
          status: "error",
          progress: this.peek(userId).progress,
          error:
            error instanceof Error
              ? error.message
              : "Could not read Location setup.",
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

  write(userId: string, progress: LocationSetupProgress): void {
    inFlightByUser.delete(userId);
    emit(userId, { status: "ready", progress, error: null });
  },

  invalidate(userId: string): void {
    inFlightByUser.delete(userId);
    emit(userId, { ...this.peek(userId), status: "idle" });
  },

  discard(userId: string): void {
    inFlightByUser.delete(userId);
    snapshotsByUser.delete(userId);
    for (const listener of listenersByUser.get(userId) ?? []) {
      listener(IDLE_SNAPSHOT);
    }
  },

  __resetForTests(): void {
    snapshotsByUser.clear();
    listenersByUser.clear();
    inFlightByUser.clear();
  },
};

export type UseSetupProgress = LocationSetupProgressSnapshot & {
  /** The screen to show, derived from the persisted row. */
  currentStep: LocationSetupStep;
  /** Re-read from the server (the voice owner calls this after a tool result). */
  refresh: () => Promise<LocationSetupProgress | null>;
  /** PATCH one transition and publish the authoritative response. */
  advance: (advance: LocationSetupAdvance) => Promise<LocationSetupProgress>;
};

export function useSetupProgress(): UseSetupProgress {
  const { userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const uid = userId ?? null;

  const snapshot = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        uid
          ? LocationSetupProgressResource.subscribe(uid, onChange)
          : () => undefined,
      [uid],
    ),
    () => LocationSetupProgressResource.peek(uid),
    () => IDLE_SNAPSHOT,
  );

  useEffect(() => {
    if (!uid || !vaultOwnerToken) return;
    if (LocationSetupProgressResource.peek(uid).status !== "idle") return;
    void LocationSetupProgressResource.load(uid, vaultOwnerToken).catch(
      () => undefined,
    );
  }, [uid, vaultOwnerToken, snapshot.status]);

  const refresh = useCallback(async () => {
    if (!uid || !vaultOwnerToken) return null;
    try {
      return await LocationSetupProgressResource.load(uid, vaultOwnerToken, {
        force: true,
      });
    } catch {
      return null;
    }
  }, [uid, vaultOwnerToken]);

  const advance = useCallback(
    async (input: LocationSetupAdvance) => {
      if (!uid || !vaultOwnerToken) {
        throw new Error("Unlock your vault to continue Location setup.");
      }
      const progress = await advanceSetupProgress(vaultOwnerToken, input);
      LocationSetupProgressResource.write(uid, progress);
      return progress;
    },
    [uid, vaultOwnerToken],
  );

  return useMemo(
    () => ({
      ...snapshot,
      currentStep: currentLocationSetupStep(snapshot.progress),
      refresh,
      advance,
    }),
    [snapshot, refresh, advance],
  );
}

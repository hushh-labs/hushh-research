"use client";

/**
 * Select the microphone owner from provider readiness and verified hosting.
 *
 * Read from `GET /api/one/voice/readiness` (never a NEXT_PUBLIC build flag), so
 * turning Live on or off is a backend env change. Fails closed. Cached per
 * signed-in user in sessionStorage for a few minutes so reloads resolve
 * quickly. Cached provider health never substitutes for fresh owner placement.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { useAuth } from "@/hooks/use-auth";
import { FEED_STATE_CHANGED_EVENT, feedStateChangeReason } from "@/lib/feed/feed-events";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";

export type OneVoiceReadinessStatus =
  "ready" | "disabled" | "not_configured" | "provider_unavailable";

export type OneVoiceReadiness = {
  microphoneOwner?: "shared_live" | "pod_commands" | "none";
} & (
  | {
      status: "unknown";
      liveEnabled: false;
      model: null;
      location: null;
      wsPath: null;
    }
  | {
      status: "resolved";
      liveEnabled: boolean;
      serverStatus: OneVoiceReadinessStatus;
      model: string | null;
      location: string | null;
      wsPath: string;
    });

const UNKNOWN: OneVoiceReadiness = {
  status: "unknown",
  liveEnabled: false,
  model: null,
  location: null,
  wsPath: null,
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_PREFIX = "one_voice_readiness_v1:";

type CacheRecord = {
  at: number;
  value: Extract<OneVoiceReadiness, { status: "resolved" }>;
};

function readCache(uid: string): OneVoiceReadiness | null {
  try {
    const raw = window.sessionStorage.getItem(`${CACHE_PREFIX}${uid}`);
    if (!raw) return null;
    const record = JSON.parse(raw) as CacheRecord;
    if (
      !record ||
      typeof record.at !== "number" ||
      Date.now() - record.at > CACHE_TTL_MS
    )
      return null;
    return record.value;
  } catch {
    return null;
  }
}

function writeCache(
  uid: string,
  value: Extract<OneVoiceReadiness, { status: "resolved" }>,
) {
  try {
    const record: CacheRecord = { at: Date.now(), value };
    window.sessionStorage.setItem(
      `${CACHE_PREFIX}${uid}`,
      JSON.stringify(record),
    );
  } catch {
    // sessionStorage is a convenience only.
  }
}

export function clearOneVoiceReadinessCache(uid: string) {
  try {
    window.sessionStorage.removeItem(`${CACHE_PREFIX}${uid}`);
  } catch {
    // ignore
  }
}

const OneVoiceReadinessContext = createContext<OneVoiceReadiness>(UNKNOWN);

export function OneVoiceReadinessProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuth();
  const uid = user?.uid || null;
  const owner = snapshotValidatedAuthSessionOwner();
  const generation = owner?.generation;
  const [observation, setObservation] = useState<{
    uid: string; generation: number; value: OneVoiceReadiness;
  } | null>(null);

  useEffect(() => {
    const captured = snapshotValidatedAuthSessionOwner();
    if (!uid || !captured || captured.userId !== uid) return;
    let cancelled = false;
    let request = 0;
    const refresh = async () => {
      const revision = ++request;
      const current = () => !cancelled && revision === request &&
        isValidatedAuthSessionOwnerCurrent(captured);
      try {
        const { ApiService } = await import("@/lib/services/api-service");
        if (!current()) return;
        const cached = readCache(uid);
        const hosting = await ApiService.getPersonalAgentStatus();
        if (!current()) return;
        const provider = cached?.status === "resolved" ? cached
          : hosting.hostingMode === "shared" ? await ApiService.getOneVoiceReadiness().then((value) => ({
            status: "resolved" as const, liveEnabled: value.enabled,
            serverStatus: value.status, model: value.model, location: value.location,
            wsPath: value.wsPath,
          })) : {
            status: "resolved" as const, liveEnabled: false, serverStatus: "disabled" as const,
            model: null, location: null, wsPath: "/api/one/voice/live",
          };
        if (!current()) return;
        if (!cached && hosting.hostingMode === "shared") writeCache(uid, provider);
        const microphoneOwner = hosting.hostingMode === "byoc" ? "pod_commands"
          : hosting.hostingMode === "shared" && provider.liveEnabled && provider.serverStatus === "ready"
            ? "shared_live" : "none";
        setObservation({ uid, generation: captured.generation, value: {
          ...provider, microphoneOwner, liveEnabled: microphoneOwner === "shared_live",
        } });
      } catch {
        if (current()) setObservation({ uid, generation: captured.generation, value: { ...UNKNOWN, microphoneOwner: "none" } });
      }
    };
    void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const onHostingChange = (event: Event) => { if (feedStateChangeReason(event) !== "read") void refresh(); };
    window.addEventListener(FEED_STATE_CHANGED_EVENT, onHostingChange);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener(FEED_STATE_CHANGED_EVENT, onHostingChange);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [uid, generation]);

  const value = owner && observation?.uid === uid && observation.generation === generation &&
    isValidatedAuthSessionOwnerCurrent(owner) ? observation.value : UNKNOWN;
  return (
    <OneVoiceReadinessContext.Provider value={value}>
      {children}
    </OneVoiceReadinessContext.Provider>
  );
}

export function useOneVoiceReadiness(): OneVoiceReadiness {
  return useContext(OneVoiceReadinessContext);
}

/** True only once the server has said Live is on. */
export function useOneVoiceLiveEnabled(): boolean {
  const readiness = useOneVoiceReadiness();
  return readiness.status === "resolved" && readiness.liveEnabled;
}

/** Private commands require an explicitly resolved BYOC placement. */
export function useOneVoiceCommandsEnabled(): boolean {
  return useOneVoiceReadiness().microphoneOwner === "pod_commands";
}

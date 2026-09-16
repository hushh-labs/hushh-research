"use client";

/**
 * The single server-owned flag that decides which voice owner mounts.
 *
 * Read from `GET /api/one/voice/readiness` (never a NEXT_PUBLIC build flag), so
 * turning Live on or off is a backend env change. Fails closed. Cached per
 * signed-in user in sessionStorage for a few minutes so reloads resolve
 * synchronously and the page never flips owners mid-session.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useAuth } from "@/hooks/use-auth";

export type OneVoiceReadinessStatus =
  "ready" | "disabled" | "not_configured" | "provider_unavailable";

export type OneVoiceReadiness =
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
    };

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
  const [state, setState] = useState<OneVoiceReadiness>(UNKNOWN);

  useEffect(() => {
    if (!uid) {
      setState(UNKNOWN);
      return;
    }
    const cached = readCache(uid);
    if (cached) {
      setState(cached);
      return;
    }
    let cancelled = false;
    // Lazy import keeps the launcher's module graph light (the service pulls
    // in the native plugin registry, which unit tests of the shell mock away).
    void import("@/lib/services/api-service")
      .then(({ ApiService }) => ApiService.getOneVoiceReadiness())
      .then((value) => {
        if (cancelled) return;
        const resolved: Extract<OneVoiceReadiness, { status: "resolved" }> = {
          status: "resolved",
          liveEnabled: value.enabled,
          serverStatus: value.status,
          model: value.model,
          location: value.location,
          wsPath: value.wsPath,
        };
        writeCache(uid, resolved);
        setState(resolved);
      });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  const value = useMemo(() => state, [state]);
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

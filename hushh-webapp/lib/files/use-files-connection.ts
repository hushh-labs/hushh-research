"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bindFilesConnection } from "@/lib/files/connection";
import {
  clearFilesHostingCache,
  hydrateFilesCacheFromEncryptedCache,
  peekFilesHostingCache,
  setFilesHostingCache,
} from "@/lib/files/files-cache";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { ApiService } from "@/lib/services/api-service";

/** Bind ciphertext/pod transport to the exact current unlocked owner visit. */
export function useFilesConnection(
  userId: string | undefined,
  vaultKey: string | null,
  vaultOwnerToken: string | null,
) {
  const currentAccess = useRef({
    userId: userId,
    vaultKey,
    vaultOwnerToken,
  });
  useLayoutEffect(() => {
    currentAccess.current = { userId, vaultKey, vaultOwnerToken };
  }, [userId, vaultKey, vaultOwnerToken]);
  const [hosting, setHosting] = useState<"shared" | "pod" | null>(() =>
    userId && vaultKey && vaultOwnerToken
      ? peekFilesHostingCache(userId, vaultKey)
      : null,
  );
  const [hydratingCache, setHydratingCache] = useState<boolean>(() =>
    Boolean(userId && vaultKey && vaultOwnerToken && !peekFilesHostingCache(userId, vaultKey)),
  );
  const [connectionError, setConnectionError] = useState("");
  const boundOwner = useRef<string | null>(null);
  const activeRelease = useRef<(() => void) | undefined>(undefined);

  useLayoutEffect(() => {
    if (!userId || !vaultKey || !vaultOwnerToken) {
      activeRelease.current?.();
      activeRelease.current = undefined;
      return;
    }
    const warmHosting = peekFilesHostingCache(userId, vaultKey);
    if (!warmHosting) return;
    const identity = snapshotValidatedAuthSessionOwner();
    const vaultEpoch = snapshotVaultSessionEpoch();
    const check = () => {
      const current = currentAccess.current;
      if (
        current.userId !== userId ||
        current.vaultKey !== vaultKey ||
        current.vaultOwnerToken !== vaultOwnerToken ||
        !isVaultSessionEpochCurrent(vaultEpoch) ||
        !identity ||
        identity.userId !== userId ||
        !isValidatedAuthSessionOwnerCurrent(identity)
      ) {
        throw new DOMException("Files access changed", "AbortError");
      }
    };
    activeRelease.current?.();
    activeRelease.current = bindFilesConnection(
      { owner: userId, vaultKey, ownerToken: vaultOwnerToken, check },
      warmHosting === "shared",
    );
    return () => {
      activeRelease.current?.();
      activeRelease.current = undefined;
    };
  }, [userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    if (!userId || !vaultKey || !vaultOwnerToken) {
      setHosting(null);
      setHydratingCache(false);
      return;
    }
    const identity = snapshotValidatedAuthSessionOwner();
    const vaultEpoch = snapshotVaultSessionEpoch();
    const controller = new AbortController();
    const check = () => {
      controller.signal.throwIfAborted();
      const current = currentAccess.current;
      if (
        current.userId !== userId ||
        current.vaultKey !== vaultKey ||
        current.vaultOwnerToken !== vaultOwnerToken ||
        !isVaultSessionEpochCurrent(vaultEpoch) ||
        !identity ||
        identity.userId !== userId ||
        !isValidatedAuthSessionOwnerCurrent(identity)
      )
        throw new DOMException("Files access changed", "AbortError");
    };
    // Token renewal fences requests without replacing the last verified canvas.
    const nextOwner = `${userId}:${vaultKey}`;
    const warmHosting = peekFilesHostingCache(userId, vaultKey);
    if (boundOwner.current !== nextOwner) {
      setHosting(warmHosting);
    } else if (warmHosting) {
      setHosting(warmHosting);
    }
    boundOwner.current = nextOwner;
    setConnectionError("");
    let statusSettled = false;
    let authoritativeUnplaced = false;
    let cachedHosting: "shared" | "pod" | null = warmHosting;
    let hydrationPromise: Promise<void> | null = null;
    if (!warmHosting && typeof hydrateFilesCacheFromEncryptedCache === "function") {
      setHydratingCache(true);
      hydrationPromise = hydrateFilesCacheFromEncryptedCache(userId, vaultKey)
        .then((hydrated) => {
          if (statusSettled || authoritativeUnplaced || !hydrated.hosting) return;
          check();
          cachedHosting = hydrated.hosting;
          activeRelease.current?.();
          activeRelease.current = bindFilesConnection(
            { owner: userId, vaultKey, ownerToken: vaultOwnerToken, check },
            hydrated.hosting === "shared",
          );
          setHosting(hydrated.hosting);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) {
            setHydratingCache(false);
          }
        });
    } else {
      setHydratingCache(false);
    }
    const readStatus =
      ApiService.getPersonalAgentStatusForRouting ??
      ApiService.getPersonalAgentStatus;
    void Promise.resolve()
      .then(() => {
        check();
        return readStatus.call(ApiService);
      })
      .then((status) => {
        check();
        statusSettled = true;
        if (status.hostingMode === "unplaced" || status.hostingMode === "pending") {
          authoritativeUnplaced = true;
          cachedHosting = null;
          clearFilesHostingCache(userId, { includeDevice: true });
          activeRelease.current?.();
          activeRelease.current = undefined;
          setHosting(null);
          throw new Error("FILES_HOSTING_REQUIRED");
        }
        if (
          status.hostingMode !== "shared" &&
          status.hostingMode !== "byoc" &&
          status.hostingMode !== "hussh_pods"
        ) {
          throw new Error("FILES_HOSTING_TRANSIENT");
        }
        const resolvedHosting =
          status.hostingMode === "shared" ? "shared" : "pod";
        cachedHosting = resolvedHosting;
        activeRelease.current?.();
        activeRelease.current = bindFilesConnection(
          { owner: userId, vaultKey, ownerToken: vaultOwnerToken, check },
          resolvedHosting === "shared",
        );
        setFilesHostingCache(userId, vaultKey, resolvedHosting);
        setHosting(resolvedHosting);
      })
      .catch(async () => {
        if (hydrationPromise && !authoritativeUnplaced) {
          await hydrationPromise.catch(() => undefined);
        }
        if (!controller.signal.aborted && (!cachedHosting || authoritativeUnplaced)) {
          activeRelease.current?.();
          activeRelease.current = undefined;
          setHosting(null);
          setConnectionError(
            "Your hosting could not be verified. Try again from Hosting settings.",
          );
        }
      });
    return () => {
      controller.abort();
      activeRelease.current?.();
      activeRelease.current = undefined;
    };
  }, [userId, vaultKey, vaultOwnerToken]);
  return { hosting, connectionError, hydratingCache };
}

/**
 * Bind an unlocked Files session on demand for one bounded operation (such as
 * onboarding archive upload + Personal Wiki import outside `FilesWorkspace`)
 * and release it cleanly in `finally`.
 */
export async function withUnlockedFilesConnection<T>(
  params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    signal: AbortSignal;
  },
  run: (hosting: "shared" | "pod") => Promise<T>,
): Promise<T> {
  const identity = snapshotValidatedAuthSessionOwner();
  const vaultEpoch = snapshotVaultSessionEpoch();
  const check = () => {
    params.signal.throwIfAborted();
    if (
      !isVaultSessionEpochCurrent(vaultEpoch) ||
      !identity ||
      identity.userId !== params.userId ||
      !isValidatedAuthSessionOwnerCurrent(identity)
    ) {
      throw new DOMException("Files access changed", "AbortError");
    }
  };
  check();
  const status = await ApiService.getPersonalAgentStatus({
    signal: params.signal,
  });
  check();
  if (
    status.hostingMode !== "shared" &&
    status.hostingMode !== "byoc" &&
    status.hostingMode !== "hussh_pods"
  ) {
    throw new Error("FILES_HOSTING_REQUIRED");
  }
  const release = bindFilesConnection(
    {
      owner: params.userId,
      vaultKey: params.vaultKey,
      ownerToken: params.vaultOwnerToken,
      check,
    },
    status.hostingMode === "shared",
  );
  try {
    return await run(status.hostingMode === "shared" ? "shared" : "pod");
  } finally {
    release();
  }
}

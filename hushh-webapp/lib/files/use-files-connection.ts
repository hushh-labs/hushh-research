"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bindFilesConnection } from "@/lib/files/connection";
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
  const [hosting, setHosting] = useState<"shared" | "pod" | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const boundOwner = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || !vaultKey || !vaultOwnerToken) {
      setHosting(null);
      return;
    }
    const identity = snapshotValidatedAuthSessionOwner();
    const vaultEpoch = snapshotVaultSessionEpoch();
    const controller = new AbortController();
    let release: (() => void) | undefined;
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
    if (boundOwner.current !== nextOwner) setHosting(null);
    boundOwner.current = nextOwner;
    setConnectionError("");
    void Promise.resolve().then(() => {
      check();
      return ApiService.getPersonalAgentStatus({ signal: controller.signal });
    })
      .then((status) => {
        check();
        if (
          status.hostingMode !== "shared" &&
          status.hostingMode !== "byoc" &&
          status.hostingMode !== "hussh_pods"
        )
          throw new Error("FILES_HOSTING_REQUIRED");
        release = bindFilesConnection(
          { owner: userId, vaultKey, ownerToken: vaultOwnerToken, check },
          status.hostingMode === "shared",
        );
        setHosting(status.hostingMode === "shared" ? "shared" : "pod");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHosting(null);
          setConnectionError(
            "Your hosting could not be verified. Try again from Hosting settings.",
          );
        }
      });
    return () => {
      controller.abort();
      release?.();
    };
  }, [userId, vaultKey, vaultOwnerToken]);
  return { hosting, connectionError };
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

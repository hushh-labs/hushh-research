"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { listenForAzureCleanupReturn } from "@/lib/one/azure-cleanup-return";
import { cloudCleanupErrorMessage, cloudCleanupNotStarted, readCloudCleanup, type CloudCleanupPurpose, type CloudCleanupView } from "@/lib/services/account-cloud-cleanup";
import { morphyToast } from "@/lib/morphy-ux/morphy";

type Owner = { userId: string; token: string | null; purpose?: CloudCleanupPurpose };
type Current = () => boolean;
type Follow = { operationId: string; deadline: number; isCurrent: Current };
export const CLEANUP_FOLLOW_CEILING_MS = 120_000;
export const CLEANUP_RECHECK_MS = 3_000;

/** Credential-generation fencing is separate from the persisted cleanup operation. */
export function captureCleanupOwner(ownerRef: RefObject<Owner>, mounted: RefObject<boolean>): Current {
  const scope = ownerRef.current;
  const owner = snapshotValidatedAuthSessionOwner();
  const vaultEpoch = snapshotVaultSessionEpoch();
  return () => mounted.current && !!owner && owner.userId === scope.userId &&
    ownerRef.current.userId === scope.userId && ownerRef.current.token === scope.token && ownerRef.current.purpose === scope.purpose &&
    isValidatedAuthSessionOwnerCurrent(owner) && isVaultSessionEpochCurrent(vaultEpoch);
}

/** Sequential, visible-only reads. Closing or hiding the view cancels its pending read. */
function followCleanup(
  follow: Follow,
  load: (operationId?: string) => Promise<CloudCleanupView | null>,
  cancelRead: () => void,
  onSettled: () => void,
): () => void {
  let closed = false;
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const close = (notify: boolean) => {
    if (closed) return;
    closed = true; sequence++;
    clearTimeout(timer); clearTimeout(deadlineTimer);
    cancelRead();
    document.removeEventListener("visibilitychange", visibility);
    if (notify) onSettled();
  };
  const read = async () => {
    if (closed) return;
    if (!follow.isCurrent() || Date.now() >= follow.deadline) { close(true); return; }
    if (document.visibilityState === "hidden") return;
    const request = ++sequence;
    const observed = await load(follow.operationId);
    if (closed || request !== sequence) return;
    if (!follow.isCurrent() || !observed || observed.canFinalize || observed.approvalRequired || observed.needsAttention || Date.now() >= follow.deadline) {
      close(true); return;
    }
    timer = setTimeout(() => void read(), CLEANUP_RECHECK_MS);
  };
  const visibility = () => {
    if (closed) return;
    sequence++; clearTimeout(timer); cancelRead();
    if (document.visibilityState !== "hidden") void read();
  };
  document.addEventListener("visibilitychange", visibility);
  deadlineTimer = setTimeout(() => close(true), Math.max(0, follow.deadline - Date.now()));
  void read();
  return () => close(false);
}

export function useCloudCleanupObservation({ owner, mounted, busy, onView }: {
  owner: Owner;
  mounted: RefObject<boolean>;
  busy: boolean;
  onView: (view: CloudCleanupView, isCurrent: Current) => void;
}) {
  const latest = useRef(owner); latest.current = owner;
  const accept = useRef(onView); accept.current = onView;
  const pending = useRef<{ abort?: AbortController; request: number; close?: () => void }>({ request: 0 });
  const [follow, setFollow] = useState<Follow | null>(null);
  const capture = useCallback(() => captureCleanupOwner(latest, mounted), [mounted]);
  const cancelRead = useCallback(() => { pending.current.request++; pending.current.abort?.abort(); }, []);
  const pause = useCallback(() => {
    cancelRead();
    if (mounted.current) setFollow(null);
  }, [cancelRead, mounted]);
  const stop = useCallback(() => { pause(); pending.current.close?.(); pending.current.close = undefined; }, [pause]);
  const load = useCallback(async (operationId?: string) => {
    const isCurrent = capture(); const token = latest.current.token;
    if (!token || !isCurrent()) return null;
    cancelRead();
    const request = pending.current.request;
    const controller = new AbortController(); pending.current.abort = controller;
    try {
      const view = await readCloudCleanup(token, controller.signal, latest.current.purpose);
      if (controller.signal.aborted || request !== pending.current.request || !isCurrent()) return null;
      if (operationId && view.operationId !== operationId) throw new Error("CLOUD_CLEANUP_OPERATION_CHANGED");
      accept.current(view, isCurrent);
      return view;
    } catch (error) {
      if (!controller.signal.aborted && request === pending.current.request && isCurrent() && !cloudCleanupNotStarted(error))
        morphyToast.error(cloudCleanupErrorMessage(error));
      return null;
    }
  }, [capture, cancelRead]);
  const startFollow = useCallback((operationId: string, isCurrent: Current) => {
    if (isCurrent()) setFollow({ operationId, isCurrent, deadline: Date.now() + CLEANUP_FOLLOW_CEILING_MS });
  }, []);
  const watchReturn = (operationId: string, phase: "inspect" | "execute", isCurrent: Current) => {
    pending.current.close?.();
    pending.current.close = listenForAzureCleanupReturn(
      { ownerId: latest.current.userId, operationId, phase }, isCurrent,
      () => startFollow(operationId, isCurrent),
    );
  };
  useEffect(() => {
    const isCurrent = capture();
    if (owner.token) void load().then((view) => { if (view?.inProgress) startFollow(view.operationId, isCurrent); });
    return stop;
  }, [owner.userId, owner.token, owner.purpose, load, stop, startFollow, capture]);
  useEffect(() => subscribeVaultSessionEpoch(stop), [stop]);
  useEffect(() => {
    if (follow && !busy) return followCleanup(follow, load, cancelRead, () => setFollow((current) => current === follow ? null : current));
    return undefined;
  }, [follow, busy, load, cancelRead]);
  return { capture, pause, watchReturn, startFollow };
}

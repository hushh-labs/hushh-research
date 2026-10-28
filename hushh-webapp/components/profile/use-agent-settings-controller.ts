"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useBrowserActivationModel } from "@/components/computer-use/browser-activation-panel";
import { useAzureHostingNoticeModel } from "./azure-hosting-notice";
import { NO_UPDATE, useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { canInstallUpdate, updateCheckMessage, releaseLabel, updateActivityLabel } from "@/lib/feed/agent-update-status";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { profileHostingSetupHref } from "@/lib/navigation/profile-routes";
import { agentUpdateApprovalToast } from "@/lib/one/agent-update-approval";
import { AZURE_UPDATE_AWAITING_LABEL, useAzureUpdateAwaitingSignIn } from "@/lib/one/azure-update-sign-in";
import { useAzureUpdateProgress } from "@/lib/one/use-azure-update-progress";
import { isOwnerCloudTarget, ownerCloudProvider } from "@/lib/one/owner-cloud";
import { ApiService } from "@/lib/services/api-service";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";

export const HOST_LABELS = {
  shared: "Hussh Shared",
  byoc: "Your cloud",
  hussh_pods: "Hussh Pods",
  pending: "Setup in progress",
  unplaced: "Not chosen yet",
  unknown: "Hosting unavailable",
} as const;

type HostingMode = keyof typeof HOST_LABELS;

export function agentSettingsSummary(model: Pick<AgentSettingsController, "status" | "mode" | "update" | "awaitingMicrosoft" | "isPod">) {
  const { status, mode, update, awaitingMicrosoft, isPod } = model;
  const activity = awaitingMicrosoft ? AZURE_UPDATE_AWAITING_LABEL : updateActivityLabel(update);
  const stateLabel = !status ? "Checking update status…" : mode === "shared" ? "Updated automatically by Hussh" :
    mode === "pending" || mode === "unplaced" ? "Available after setup finishes" : mode === "unknown" ? "Hosting status unavailable" :
    activity ?? (update.presentationState === "deferred" && !canInstallUpdate(status) ? "Update reminder saved" :
      update.available === true && canInstallUpdate(status) ? "Update ready for your approval" :
      update.available === true ? updateCheckMessage(status) : status.installedReleaseVerified === true && update.available === false ? "Up to date" : "Running version not verified");
  const release = isPod ? status?.availableRelease : null;
  const version = status?.installedRelease?.version;
  const releasedAt = version && version === release?.version ? release.releasedAt : null;
  const versionLabel = mode === "shared" ? version?.replace(/^Managed service /, "Managed build ") : version ? releaseLabel(version, releasedAt) : null;
  return { stateLabel, release, versionLabel };
}

function isHostingMode(value: unknown): value is HostingMode {
  return typeof value === "string" && value in HOST_LABELS;
}

export function useAgentSettingsController({
  kind,
  userId,
  enabled = true,
}: {
  kind: "hosting" | "software-updates";
  userId: string | null;
  enabled?: boolean;
}) {
  const router = useRouter();
  const follow = useAgentDeploymentFollow({ userId, enabled: enabled && !!userId });
  const auth = snapshotValidatedAuthSessionOwner();
  const authUserId = auth?.userId, authGeneration = auth?.generation;
  const scope = useMemo(() => ({ userId, kind, enabled,
    auth: authUserId && authGeneration !== undefined ? { userId: authUserId, generation: authGeneration } : null,
  }), [userId, kind, enabled, authUserId, authGeneration]);
  const liveScope = useRef<typeof scope | null>(scope);
  const displayedOwner = useRef(userId);
  // The follower resets its owner-scoped resource in its effect. Mask the
  // preceding owner's value synchronously until that reset has run.
  const status = enabled && displayedOwner.current === userId ? follow.status : null;
  const update = status ? follow.update : NO_UPDATE;
  const refresh = follow.refresh;
  const azureUpdate = useAzureUpdateProgress({ onSettled: refresh, enabled: enabled && kind === "software-updates", ownerKey: `${userId}:${scope.auth?.generation}` });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [observedInspection, setInspection] = useState<{ value: Awaited<ReturnType<typeof ApiService.inspectPersonalAgentHosting>>; current: () => boolean } | null>(null);
  const inspection = observedInspection?.current() ? observedInspection.value : null;
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    liveScope.current = scope;
    busyRef.current = false;
    setBusy(false);
    setNotice(null);
    return () => { if (liveScope.current === scope) liveScope.current = null; };
  }, [scope]);
  useEffect(() => { displayedOwner.current = userId; }, [userId]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const current = () => {
    const owner = snapshotValidatedAuthSessionOwner();
    return enabled && !!userId && mounted.current && liveScope.current === scope &&
      !!scope.auth && !!owner && scope.auth.generation === owner.generation && owner.userId === userId && isValidatedAuthSessionOwnerCurrent(scope.auth);
  };
  const mode: HostingMode = isHostingMode(status?.hostingMode)
    ? (status.hostingMode as HostingMode)
    : "unknown";
  const isPod = mode === "byoc" || mode === "hussh_pods";
  const needsLinkRecovery = mode === "byoc" && status?.state === "failed";
  // An approved Azure update starts only with the owner's Microsoft sign-in.
  const awaitingMicrosoft = useAzureUpdateAwaitingSignIn({
    deploymentTarget: kind === "software-updates" ? status?.deploymentTarget : null,
    update,
  });
  const working =
    !update.failed &&
    update.presentationState !== "blocked" &&
    (update.inProgress || ["scheduled", "updating"].includes(update.presentationState ?? ""));
  function notify<T>(request: Promise<T>, copy: { loading: string; success: string | ((value: T) => string | null); error: string | ((error: unknown) => string | null) }, admitted = current) {
    const success = (value: T) => admitted() ? typeof copy.success === "function" ? copy.success(value) : copy.success : null;
    const error = (cause: unknown) => admitted() ? typeof copy.error === "function" ? copy.error(cause) : copy.error : null;
    if (admitted()) setNotice(copy.loading);
    const observed = request.then(value => { if (admitted()) setNotice(success(value)); return value; }, cause => { if (admitted()) setNotice(error(cause)); throw cause; });
    return morphyToast.promise(observed, { ...copy, success, error });
  }
  const browser = useBrowserActivationModel({ userId: userId ?? "", disabled: busy || working,
    enabled: enabled && kind === "software-updates" && mode === "byoc" && isOwnerCloudTarget(status?.deploymentTarget) && !!status?.browserActivationAvailable,
    onScheduled: refresh });
  const azureHosting = useAzureHostingNoticeModel({ onRebuilt: refresh, ownerKey: userId,
    enabled: enabled && kind === "hosting" && mode === "byoc" && ownerCloudProvider(status?.deploymentTarget) === "azure" });

  async function checkStatus() {
    if (busyRef.current || !current()) return;
    busyRef.current = true;
    setBusy(true);
    const owner = snapshotValidatedAuthSessionOwner();
    const operationCurrent = () => current() && !!owner && isValidatedAuthSessionOwnerCurrent(owner);
    const request = ApiService.getPersonalAgentStatus().then(async (next) => {
      if (!isHostingMode(next.hostingMode) || next.hostingMode === "unknown") {
        throw new Error("Hosting status unavailable");
      }
      if (!operationCurrent()) throw new DOMException("Session changed", "AbortError");
      if (kind === "hosting" && isOwnerCloudTarget(next.deploymentTarget)) {
        const checked = await ApiService.inspectPersonalAgentHosting();
        if (!operationCurrent()) throw new DOMException("Session changed", "AbortError");
        setInspection({ value: checked, current: operationCurrent });
      }
      return next;
    });
    try {
      await notify(request, {
          loading:
            kind === "hosting" ? "Checking hosting…" : "Checking for updates…",
          success: (next) =>
            kind === "hosting"
              ? isOwnerCloudTarget(next.deploymentTarget) ? "Cloud resources checked." : `Hosting confirmed: ${HOST_LABELS[next.hostingMode as HostingMode]}.`
              : updateCheckMessage(next),
          error:
            kind === "hosting"
              ? "Couldn’t verify hosting. Try again."
              : "Couldn’t check for updates. Try again.",
        })
        .unwrap();
      if (operationCurrent()) { refresh(); dispatchFeedStateChanged(); }
    } catch {
      // The promise toast owns the transient error.
    } finally {
      if (current()) { busyRef.current = false; setBusy(false); }
    }
  }

  async function act(action: "approve" | "defer") {
    if (
      busyRef.current ||
      !current() ||
      !isPod ||
      !canInstallUpdate(status) ||
      !update.releaseId ||
      working
    )
      return;
    busyRef.current = true;
    setBusy(true);
    // An Azure approval is recorded, then Microsoft signs in beside this pane;
    // called inside the click, so the popup keeps the gesture blockers require.
    const request: Promise<void> =
      action === "approve"
        ? azureUpdate.approve({ agent: status, releaseId: update.releaseId, idempotencyKey: crypto.randomUUID() })
            .then(() => undefined)
        : ApiService.deferPersonalAgentUpdate({
            releaseId: update.releaseId,
          }).then(() => undefined);
    try {
      await notify(request, action === "approve" ? agentUpdateApprovalToast(status?.deploymentTarget) : {
          loading: "Saving your reminder…",
          success: "We’ll remind you later.",
          error: "We couldn’t complete that request. Try again.",
        })
        .unwrap();
      if (current()) { dispatchFeedStateChanged(); refresh(); }
    } catch {
      // The promise toast owns the transient error.
    } finally {
      if (current()) { busyRef.current = false; setBusy(false); }
    }
  }

  async function reconnectDirectPod() {
    if (busyRef.current || !current()) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await notify(ApiService.reconnectOwnerPod(), {
          loading: "Reconnecting your pod…",
          success: "Pod connection checked.",
          error:
            "Your pod could not be reached. Check its connection and try again.",
        })
        .unwrap();
      if (current()) { refresh(); dispatchFeedStateChanged(); }
    } catch {
      // The promise toast owns the transient error.
    } finally {
      if (current()) { busyRef.current = false; setBusy(false); }
    }
  }

  async function sendFailureReport() {
    if (busyRef.current || !current() || !update.failed || !update.operationId) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await notify(
        ApiService.reportPersonalAgentUpdateFailure({ operationId: update.operationId }),
        {
          loading: "Sending update report…",
          success: "Report sent. Private files and conversations were not included.",
          error: "The report could not be sent. Your pod is unchanged; try again later.",
        },
      ).unwrap();
    } catch {
      // A failed report never changes the update operation.
    } finally {
      if (current()) { busyRef.current = false; setBusy(false); }
    }
  }

  async function recoverExistingPod() {
    if (busyRef.current || !current() || !needsLinkRecovery) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const isEffectCurrent = () => Boolean(
      current() && owner?.userId === userId &&
      owner && isValidatedAuthSessionOwnerCurrent(owner),
    );
    if (!isEffectCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    let recoveryToast: ReturnType<typeof morphyToast.promise> | undefined;
    try {
      recoveryToast = notify(
        ApiService.adoptOrphanPod({ isEffectCurrent }).then((result) => {
          if (!isEffectCurrent()) throw new DOMException("Session changed", "AbortError");
          if (!result.adopted) throw new Error("POD_RECOVERY_UNAVAILABLE");
        }),
        {
          loading: "Finding your existing pod…",
          success: () => isEffectCurrent() ? "Existing pod linked. Checking its status…" : null,
          error: () => isEffectCurrent() ? "Your existing pod could not be linked. It needs attention before setup or updates can continue." : null,
        }, isEffectCurrent,
      );
      await recoveryToast.unwrap();
      if (isEffectCurrent()) {
        refresh();
        dispatchFeedStateChanged();
      }
    } catch {
      // Recovery refusal must never fall back to provisioning or reset.
    } finally {
      if (!isEffectCurrent()) {
        const toastId = recoveryToast?.valueOf();
        if (typeof toastId === "number" || typeof toastId === "string")
          morphyToast.dismiss(toastId);
      }
      if (current()) { busyRef.current = false; setBusy(false); }
    }
  }

  return { kind, userId: userId ?? "", status, update, refresh, azureUpdate, busy, browser, azureHosting, notice: current() ? notice : null,
    inspection, mode, isPod, needsLinkRecovery, awaitingMicrosoft, working,
    checkStatus, act, reconnectDirectPod, sendFailureReport, recoverExistingPod, current,
    chooseHosting: () => { if (current()) router.push(profileHostingSetupHref()); } };
}

export type AgentSettingsController = ReturnType<typeof useAgentSettingsController>;


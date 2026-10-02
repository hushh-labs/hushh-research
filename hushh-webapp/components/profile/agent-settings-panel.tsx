"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { AgentUpdateProgress } from "@/components/agent/agent-update-progress";
import { useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { readUpdateStatus, releaseLabel, updateActivityLabel } from "@/lib/feed/agent-update-status";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import { approveAgentUpdate } from "@/lib/one/agent-update-approval";
import { azureSignInErrorMessage } from "@/lib/one/azure-sign-in";
import { ownerCloudProvider } from "@/lib/one/owner-cloud";
import { ApiService } from "@/lib/services/api-service";
import {
  snapshotValidatedAuthSessionOwner,
  isValidatedAuthSessionOwnerCurrent,
} from "@/lib/auth/session-owner";

const HOST_LABELS = {
  shared: "Hussh Shared",
  byoc: "Your cloud",
  hussh_pods: "Hussh Pods",
  pending: "Setup in progress",
  unknown: "Hosting unavailable",
} as const;

type HostingMode = keyof typeof HOST_LABELS;

function isHostingMode(value: unknown): value is HostingMode {
  return typeof value === "string" && value in HOST_LABELS;
}

// Older hubs expose only offerability; an explicit refusal always wins.
function canInstallUpdate(
  status: Awaited<ReturnType<typeof ApiService.getPersonalAgentStatus>> | null,
) {
  return (status?.updateInstallable ?? status?.updateOfferable) === true;
}

function updateCheckMessage(
  status: Awaited<ReturnType<typeof ApiService.getPersonalAgentStatus>>,
) {
  if (status.hostingMode === "shared")
    return "Hussh Shared updates automatically.";
  if (status.hostingMode === "pending")
    return "Updates become available after setup finishes.";
  if (status.updateFailed)
    return "Update needs attention. Its outcome has not been verified.";
  const activity = updateActivityLabel(readUpdateStatus(status));
  if (activity) return `${activity}.`;
  if (canInstallUpdate(status) && status.availableRelease) {
    return `${releaseLabel(status.availableRelease.version, status.availableRelease.releasedAt)} is ready to install.`;
  }
  if (status.updateAvailable)
    return "An update is available, but this pod is not ready to install it.";
  if (status.installedReleaseVerified)
    return "Your private agent is up to date.";
  return "Update status checked. The running version is not yet verified.";
}

export function AgentSettingsPanel({
  kind,
  userId,
}: {
  kind: "hosting" | "software-updates";
  userId: string;
}) {
  const router = useRouter();
  const { status, update, refresh } = useAgentDeploymentFollow({ userId });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const mode: HostingMode = isHostingMode(status?.hostingMode)
    ? status.hostingMode
    : "unknown";
  const isPod = mode === "byoc" || mode === "hussh_pods";
  const needsLinkRecovery = mode === "byoc" && status?.state === "failed";
  const working =
    !update.failed &&
    update.presentationState !== "blocked" &&
    (update.inProgress || ["scheduled", "updating"].includes(update.presentationState ?? ""));

  async function checkStatus() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const request = ApiService.getPersonalAgentStatus().then((next) => {
      if (!isHostingMode(next.hostingMode) || next.hostingMode === "unknown") {
        throw new Error("Hosting status unavailable");
      }
      return next;
    });
    try {
      await morphyToast
        .promise(request, {
          loading:
            kind === "hosting" ? "Checking hosting…" : "Checking for updates…",
          success: (next) =>
            kind === "hosting"
              ? `Hosting confirmed: ${HOST_LABELS[next.hostingMode as HostingMode]}.`
              : updateCheckMessage(next),
          error:
            kind === "hosting"
              ? "Couldn’t verify hosting. Try again."
              : "Couldn’t check for updates. Try again.",
        })
        .unwrap();
      refresh();
      dispatchFeedStateChanged();
    } catch {
      // The promise toast owns the transient error.
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function act(action: "approve" | "defer") {
    if (
      busyRef.current ||
      !isPod ||
      !canInstallUpdate(status) ||
      !update.releaseId ||
      working
    )
      return;
    busyRef.current = true;
    setBusy(true);
    // An Azure agent's update is approved with the person's own Microsoft
    // sign-in; the browser leaves for Microsoft once it starts.
    const viaMicrosoft =
      action === "approve" && ownerCloudProvider(status?.deploymentTarget) === "azure";
    const request: Promise<void> =
      action === "approve"
        ? approveAgentUpdate({
            deploymentTarget: status?.deploymentTarget,
            releaseId: update.releaseId,
            idempotencyKey: crypto.randomUUID(),
          }).then(() => undefined)
        : ApiService.deferPersonalAgentUpdate({
            releaseId: update.releaseId,
          }).then(() => undefined);
    try {
      await morphyToast
        .promise(request, {
          loading: viaMicrosoft
            ? "Opening Microsoft sign-in…"
            : action === "approve"
              ? "Scheduling your update…"
              : "Saving your reminder…",
          success: viaMicrosoft
            ? "Continue in Microsoft sign-in."
            : action === "approve"
              ? "Update scheduled."
              : "We’ll remind you later.",
          error: viaMicrosoft
            ? (cause: unknown) => azureSignInErrorMessage(cause, "upgrade")
            : "We couldn’t complete that request. Try again.",
        })
        .unwrap();
      dispatchFeedStateChanged();
      refresh();
    } catch {
      // The promise toast owns the transient error.
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function reconnectDirectPod() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await morphyToast
        .promise(ApiService.reconnectOwnerPod(), {
          loading: "Reconnecting your pod…",
          success: "Pod connection checked.",
          error:
            "Your pod could not be reached. Check its connection and try again.",
        })
        .unwrap();
      refresh();
      dispatchFeedStateChanged();
    } catch {
      // The promise toast owns the transient error.
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function sendFailureReport() {
    if (busyRef.current || !update.failed || !update.operationId) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await morphyToast.promise(
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
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function recoverExistingPod() {
    if (busyRef.current || !needsLinkRecovery) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const isEffectCurrent = () => Boolean(
      mounted.current && owner?.userId === userId &&
      owner && isValidatedAuthSessionOwnerCurrent(owner),
    );
    if (!isEffectCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    let recoveryToast: ReturnType<typeof morphyToast.promise> | undefined;
    try {
      recoveryToast = morphyToast.promise(
        ApiService.adoptOrphanPod({ isEffectCurrent }).then((result) => {
          if (!isEffectCurrent()) throw new DOMException("Session changed", "AbortError");
          if (!result.adopted) throw new Error("POD_RECOVERY_UNAVAILABLE");
        }),
        {
          loading: "Finding your existing pod…",
          success: () => isEffectCurrent() ? "Existing pod linked. Checking its status…" : null,
          error: () => isEffectCurrent() ? "Your existing pod could not be linked. It needs attention before setup or updates can continue." : null,
        },
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
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (kind === "hosting") {
    const canManageCloud =
      mode === "shared" || mode === "pending" || mode === "byoc";
    return (
      <div className="space-y-5">
        <SettingsGroup density="compact">
          <SettingsRow
            title="Current hosting"
            description={status ? HOST_LABELS[mode] : "Checking hosting…"}
          />
          {mode === "byoc" ? (
            <SettingsRow
              title="Files and storage"
              description="Open your private cloud library and analysis preferences."
              onClick={() => router.push(ROUTES.ONE_FILES)}
            />
          ) : null}
          {mode === "byoc" && status?.cloudProject ? (
            <SettingsRow
              title="Your cloud project"
              description={[status.cloudProject, status.cloudRegion]
                .filter(Boolean)
                .join(" · ")}
            />
          ) : null}
        </SettingsGroup>

        <SettingsGroup
          title="Hosting choices"
          density="compact"
          headingClassName="!mt-5"
        >
          <SettingsRow
            title="Hussh Shared"
            description="Hussh runs and updates the shared service automatically."
            trailing={mode === "shared" ? "Current" : undefined}
          />
          <SettingsRow
            title="Bring your own cloud"
            description="Your private agent and device relay. You approve updates."
            trailing={
              mode === "byoc"
                ? "Current"
                : mode === "pending"
                  ? "Continue"
                  : undefined
            }
            onClick={
              canManageCloud
                ? () => router.push(ROUTES.ONE_SETUP_CLOUD)
                : undefined
            }
            chevron={canManageCloud}
          />
          <SettingsRow
            title="Hussh Pods"
            description={
              mode === "hussh_pods"
                ? "Your dedicated Hussh-hosted pod. You approve updates."
                : "Dedicated hosting is unavailable for new setups."
            }
            trailing={mode === "hussh_pods" ? "Current" : "Unavailable"}
          />
        </SettingsGroup>

        {mode === "unknown" && status ? (
          <p className="text-sm text-muted-foreground">
            We couldn’t verify your hosting. Your existing setup has not
            changed.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="muted"
            disabled={busy}
            onClick={() => void checkStatus()}
          >
            Check hosting
          </Button>
          {mode === "byoc" ? (
            <Button
              variant="muted"
              disabled={busy}
              onClick={() => void (needsLinkRecovery ? recoverExistingPod() : reconnectDirectPod())}
            >
              {needsLinkRecovery ? "Link existing pod" : "Reconnect your pod"}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const stateLabel = !status
    ? "Checking update status…"
    : mode === "shared"
      ? "Updated automatically by Hussh"
      : mode === "pending"
        ? "Available after setup finishes"
        : mode === "unknown"
          ? "Hosting status unavailable"
          : updateActivityLabel(update)
            ? updateActivityLabel(update)
            : update.presentationState === "deferred" && !canInstallUpdate(status)
              ? "Update reminder saved"
              : update.available === true && canInstallUpdate(status)
                ? "Update ready for your approval"
                : update.available === true
                  ? "New release not ready for this pod"
                  : status.installedReleaseVerified === true &&
                      update.available === false
                    ? "Up to date"
                    : "Running version not verified";
  const release = isPod ? status?.availableRelease : null;
  const installedVersion = status?.installedRelease?.version;
  const installedReleasedAt = installedVersion && installedVersion === release?.version
    ? release.releasedAt : null;
  const versionLabel =
    mode === "shared"
      ? installedVersion?.replace(/^Managed service /, "Managed build ")
      : installedVersion ? releaseLabel(installedVersion, installedReleasedAt) : null;
  return (
    <div className="space-y-5">
      <SettingsGroup density="compact">
        <SettingsRow title="Status" description={stateLabel} />
        {mode === "shared" || isPod ? (
          <SettingsRow
            title={
              isPod && !status?.installedReleaseVerified
                ? "Reported version"
                : "Current version"
            }
            description={versionLabel ?? "Not verified"}
          />
        ) : null}
        {release && update.available ? (
          <SettingsRow title="New version" description={releaseLabel(release.version, release.releasedAt)} />
        ) : null}
      </SettingsGroup>

      {isPod ? <AgentUpdateProgress update={update} /> : null}

      {release && update.available ? (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">
            What’s in this update
          </summary>
          <p className="mt-2 text-muted-foreground">{release.summary}</p>
          {Object.entries(release.notes)
            .filter(([, entries]) => entries.length > 0)
            .map(([heading, entries]) => (
              <div key={heading} className="mt-3">
                <h3 className="font-medium capitalize">{heading}</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                  {entries.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </div>
            ))}
        </details>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {needsLinkRecovery ? (
          <Button variant="muted" disabled={busy} onClick={() => void recoverExistingPod()}>
            Link existing pod
          </Button>
        ) : null}
        {isPod &&
        canInstallUpdate(status) &&
        update.releaseId &&
        !working ? (
          <>
            <Button disabled={busy} onClick={() => void act("approve")}>
              Update now
            </Button>
            <Button
              variant="muted"
              disabled={busy}
              onClick={() => void act("defer")}
            >
              Later
            </Button>
          </>
        ) : null}
        <Button
          variant="muted"
          disabled={busy}
          onClick={() => void checkStatus()}
        >
          Check for updates
        </Button>
        {isPod && update.failed && update.operationId ? (
          <Button variant="muted" disabled={busy} onClick={() => void sendFailureReport()}>
            Send failure report
          </Button>
        ) : null}
      </div>

      {isPod && update.failed && update.operationId ? (
        <p className="text-xs text-muted-foreground">
          This sends the update ID, release ID, and up to 12 lifecycle events when you choose to report it. It does not send pod logs or your files.
        </p>
      ) : null}

      {isPod &&
      (status?.releaseCheckedAt || status?.installedReleaseVerifiedAt) ? (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Verification details</summary>
          <div className="mt-2 space-y-1">
            {status.releaseCheckedAt ? (
              <p>
                Last checked:{" "}
                {new Date(status.releaseCheckedAt).toLocaleString()}
              </p>
            ) : null}
            {status.installedReleaseVerifiedAt ? (
              <p>
                Installation verified:{" "}
                {new Date(status.installedReleaseVerifiedAt).toLocaleString()}
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

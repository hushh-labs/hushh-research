"use client";

import { useState } from "react";
import { CloudHostingHealth } from "./cloud-hosting-health";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { AgentUpdateActivity } from "./agent-update-activity";
import { BrowserActivationPanel } from "@/components/computer-use/browser-activation-panel";
import { AzureHostingNotice } from "./azure-hosting-notice";
import { CloudRemovalControl } from "./cloud-removal-control";
import { canInstallUpdate, releaseLabel } from "@/lib/feed/agent-update-status";
import { Button } from "@/lib/morphy-ux/morphy";
import {
  HOSTED_POD_PROVIDER_LABELS,
  hostedPodDisplayLabel,
  hostedPodProvider,
  isHostedAzureMigrationAvailable,
  isHostedPodTierUnderMaintenance,
  isOwnerCloudTarget,
  isPooledSandboxSwitchAvailable,
  ownerCloudProvider,
  podCloudProvider,
} from "@/lib/one/owner-cloud";
import {
  HostedPodDualCloudMarks,
  HusshPodsActiveCard,
  HusshPodsMigrationCard,
  PodCloudBadge,
  PooledSandboxSwitchCard,
} from "@/components/connections/hussh-pods-cloud-card";
import { CircleAutoApprovePanel } from "@/components/connections/circle-auto-approve-panel";
import { PodSessionLockdownControl } from "@/components/connections/pod-session-lockdown-row";
import { ROUTES } from "@/lib/navigation/routes";
import {
  HOST_LABELS,
  agentSettingsSummary,
  useAgentSettingsController,
  type AgentSettingsController,
} from "./use-agent-settings-controller";
export {
  HOST_LABELS,
  agentSettingsSummary,
  useAgentSettingsController,
} from "./use-agent-settings-controller";
export type { AgentSettingsController } from "./use-agent-settings-controller";

export type AgentSettingsDetailView = "hosting-details" | "update-details" | null;

export function AgentSettingsPanel({
  kind,
  userId,
  controller,
  detail = null,
  onOpenDetail,
}: {
  kind: "hosting" | "software-updates";
  userId: string;
  controller?: AgentSettingsController;
  detail?: AgentSettingsDetailView;
  onOpenDetail?: (detail: Exclude<AgentSettingsDetailView, null>) => void;
}) {
  return controller ? (
    <AgentSettingsBody model={controller} detail={detail} onOpenDetail={onOpenDetail} />
  ) : (
    <OwnedAgentSettingsPanel
      kind={kind}
      userId={userId}
      detail={detail}
      onOpenDetail={onOpenDetail}
    />
  );
}

function OwnedAgentSettingsPanel({
  kind,
  userId,
  detail,
  onOpenDetail,
}: {
  kind: "hosting" | "software-updates";
  userId: string;
  detail?: AgentSettingsDetailView;
  onOpenDetail?: (detail: Exclude<AgentSettingsDetailView, null>) => void;
}) {
  return (
    <AgentSettingsBody
      model={useAgentSettingsController({ kind, userId })}
      detail={detail}
      onOpenDetail={onOpenDetail}
    />
  );
}

function AgentSettingsBody({
  model,
  detail: controlledDetail = null,
  onOpenDetail,
}: {
  model: AgentSettingsController;
  detail?: AgentSettingsDetailView;
  onOpenDetail?: (detail: Exclude<AgentSettingsDetailView, null>) => void;
}) {
  const [localDetail, setLocalDetail] = useState<AgentSettingsDetailView>(null);
  const activeDetail = onOpenDetail ? controlledDetail : localDetail;
  const openDetail = (next: Exclude<AgentSettingsDetailView, null>) => {
    if (onOpenDetail) {
      onOpenDetail(next);
      return;
    }
    setLocalDetail(next);
  };
  const closeLocalDetail = () => setLocalDetail(null);

  const {
    kind,
    userId,
    status,
    update,
    refresh,
    azureUpdate,
    busy,
    inspection,
    mode,
    isPod,
    needsLinkRecovery,
    awaitingMicrosoft,
    working,
    checkStatus,
    act,
    reconnectDirectPod,
    sendFailureReport,
    recoverExistingPod,
    chooseHosting,
    browser,
    azureHosting,
  } = model;

  if (kind === "hosting") {
    const canManageCloud =
      status?.featureEnabled === true &&
      (mode === "shared" || mode === "pending" || mode === "byoc" || mode === "unplaced");
    const hostedUnderMaintenance = isHostedPodTierUnderMaintenance();
    const canChooseHosted =
      !hostedUnderMaintenance &&
      status?.featureEnabled === true &&
      (mode === "shared" || mode === "pending" || mode === "unplaced");
    const activeHostedProvider = hostedPodProvider(status?.deploymentTarget);
    const activeCloudProvider = podCloudProvider(status?.deploymentTarget);
    const currentHostingDescription = !status
      ? "Checking hosting…"
      : mode === "hussh_pods"
        ? hostedPodDisplayLabel(status.deploymentTarget)
        : HOST_LABELS[mode];
    const pooledSwitchAvailable = isPooledSandboxSwitchAvailable();
    const showPooledSandboxSwitch =
      pooledSwitchAvailable &&
      (mode === "byoc" ||
        mode === "pending" ||
        (mode === "hussh_pods" && status?.deploymentTarget !== "ace"));
    const showHostedMigration =
      !pooledSwitchAvailable &&
      isHostedAzureMigrationAvailable() &&
      status?.state === "active" &&
      (mode === "byoc" || (mode === "hussh_pods" && activeHostedProvider === "gcp"));
    const hasHostingDetails =
      (mode === "hussh_pods" && !hostedUnderMaintenance) ||
      (mode === "byoc" && status?.state === "active");

    if (activeDetail === "hosting-details" && hasHostingDetails) {
      return (
        <div className="space-y-5" data-testid="hosting-details-view">
          {!onOpenDetail ? (
            <div>
              <Button type="button" variant="muted" size="sm" onClick={closeLocalDetail}>
                Back to Hosting
              </Button>
            </div>
          ) : null}

          {mode === "hussh_pods" && !hostedUnderMaintenance ? (
            <SettingsGroup title="Active runtime" density="compact" headingClassName="!mt-0">
              <HusshPodsActiveCard
                deploymentTarget={status?.deploymentTarget}
                embedded
                showRetiredHistory
              />
            </SettingsGroup>
          ) : null}

          {mode === "byoc" && status?.state === "active" ? (
            <>
              <SettingsGroup title="Cloud runtime" density="compact" headingClassName="!mt-0">
                <SettingsRow
                  title="Current hosting"
                  description={HOST_LABELS[mode]}
                  trailing={
                    activeCloudProvider ? (
                      <PodCloudBadge
                        provider={activeCloudProvider}
                        testId="hosting-details-cloud-badge"
                      />
                    ) : undefined
                  }
                />
                {status.cloudProject ? (
                  <SettingsRow
                    title="Your cloud project"
                    description={[status.cloudProject, status.cloudRegion]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                ) : null}
                <CloudHostingHealth inspection={inspection} />
              </SettingsGroup>
              <SettingsGroup title="Background activity" density="compact">
                <PodSessionLockdownControl
                  testId="byoc-session-only-lockdown"
                  asSettingsRow
                />
              </SettingsGroup>
              {ownerCloudProvider(status?.deploymentTarget) === "azure" ? (
                <AzureHostingNotice model={azureHosting} />
              ) : null}
              {isOwnerCloudTarget(status?.deploymentTarget) ? (
                <div className="flex flex-wrap gap-2">
                  <CloudRemovalControl
                    provider={
                      ownerCloudProvider(status?.deploymentTarget) === "azure"
                        ? "azure"
                        : "gcp"
                    }
                  />
                </div>
              ) : null}
            </>
          ) : null}

          {(mode === "hussh_pods" || mode === "byoc") && status?.state === "active" ? (
            <CircleAutoApprovePanel />
          ) : null}
        </div>
      );
    }

    const currentHostingTrailing = (
      <span className="inline-flex items-center gap-2">
        {mode === "hussh_pods" && status?.state === "active" ? (
          <span
            data-testid="current-hosting-status-signal"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-black/[0.03] px-2 py-0.5 text-[11px] font-semibold text-foreground dark:bg-white/[0.06]"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-[color:var(--app-accent)]"
            />
            Connected
          </span>
        ) : null}
        {activeCloudProvider ? (
          <PodCloudBadge
            provider={activeCloudProvider}
            label={
              mode === "hussh_pods" && activeHostedProvider
                ? HOSTED_POD_PROVIDER_LABELS[activeHostedProvider]
                : undefined
            }
            testId="current-hosting-cloud-badge"
          />
        ) : mode === "hussh_pods" && status?.deploymentTarget === "ace" ? (
          <HostedPodDualCloudMarks />
        ) : null}
      </span>
    );

    return (
      <div className="space-y-5">
        <SettingsGroup density="compact">
          <SettingsRow
            title="Current hosting"
            description={currentHostingDescription}
            textOverflow="truncate"
            trailing={
              activeCloudProvider ||
              (mode === "hussh_pods" && status?.deploymentTarget === "ace") ||
              (mode === "hussh_pods" && status?.state === "active")
                ? currentHostingTrailing
                : undefined
            }
            onClick={hasHostingDetails ? () => openDetail("hosting-details") : undefined}
            chevron={hasHostingDetails}
            testId="current-hosting-row"
          />
          {mode === "byoc" && status?.cloudProject ? (
            <SettingsRow
              title="Your cloud project"
              description={[status.cloudProject, status.cloudRegion]
                .filter(Boolean)
                .join(" · ")}
              textOverflow="truncate"
            />
          ) : null}
          <CloudHostingHealth inspection={inspection} />
        </SettingsGroup>

        {mode === "byoc" && ownerCloudProvider(status?.deploymentTarget) === "azure" ? (
          <AzureHostingNotice model={azureHosting} />
        ) : null}

        {showPooledSandboxSwitch ? (
          <SettingsGroup title="Personal Sandbox" density="compact" headingClassName="!mt-5">
            <PooledSandboxSwitchCard
              hasAssignedCloudPod={mode === "byoc" || mode === "hussh_pods"}
              isOwnerCloud={mode === "byoc"}
              sourceCloudLabel={
                mode === "byoc"
                  ? [status?.cloudProject, status?.cloudRegion].filter(Boolean).join(" · ") ||
                    (ownerCloudProvider(status?.deploymentTarget) === "azure"
                      ? "Microsoft Azure"
                      : ownerCloudProvider(status?.deploymentTarget) === "gcp"
                        ? "Google Cloud"
                        : null)
                  : mode === "hussh_pods" && activeHostedProvider
                    ? HOSTED_POD_PROVIDER_LABELS[activeHostedProvider]
                    : null
              }
              owningRoute={ROUTES.PROFILE_HOSTING}
              onSwitched={refresh}
              embedded
            />
          </SettingsGroup>
        ) : null}

        {showHostedMigration ? (
          <SettingsGroup title="Move to Hussh Pods" density="compact" headingClassName="!mt-5">
            <HusshPodsMigrationCard
              sourceMode={mode}
              sourceTarget={status?.deploymentTarget}
              sourceProject={
                mode === "byoc"
                  ? [status?.cloudProject, status?.cloudRegion].filter(Boolean).join(" · ") || null
                  : null
              }
              onMigrated={refresh}
              owningRoute={ROUTES.PROFILE_HOSTING}
              embedded
            />
          </SettingsGroup>
        ) : null}

        <SettingsGroup title="Hosting choices" density="compact" headingClassName="!mt-5">
          <SettingsRow
            title="Hussh Shared"
            description={
              mode === "byoc"
                ? "Remove your current cloud below to switch."
                : "Managed shared service with automatic updates."
            }
            textOverflow="truncate"
            trailing={mode === "shared" ? "Current" : mode === "unplaced" ? "Choose" : undefined}
            onClick={mode === "unplaced" ? chooseHosting : undefined}
            chevron={mode === "unplaced"}
          />
          <SettingsRow
            title="Bring your own cloud"
            description={
              status && !status.featureEnabled
                ? "Temporarily unavailable for new setups."
                : "Your own cloud project. You approve updates."
            }
            textOverflow="truncate"
            trailing={
              mode === "byoc"
                ? "Current"
                : status && !status.featureEnabled
                  ? "Unavailable"
                  : mode === "pending"
                    ? "Continue"
                    : undefined
            }
            onClick={canManageCloud ? chooseHosting : undefined}
            chevron={canManageCloud}
          />
          <SettingsRow
            title="Hussh Pods"
            description={
              mode === "hussh_pods"
                ? status?.deploymentTarget === "ace"
                  ? "Isolated Personal Sandbox with built-in AI."
                  : activeHostedProvider
                    ? `Dedicated pod on ${HOSTED_POD_PROVIDER_LABELS[activeHostedProvider]}.`
                    : "Dedicated Hussh-hosted pod."
                : hostedUnderMaintenance
                  ? "Unavailable for new setups."
                  : "Dedicated pod on Google Cloud or Azure."
            }
            textOverflow="truncate"
            trailing={
              mode === "hussh_pods" ? (
                "Current"
              ) : hostedUnderMaintenance ? (
                "Unavailable"
              ) : (
                <HostedPodDualCloudMarks />
              )
            }
            onClick={canChooseHosted ? chooseHosting : undefined}
            chevron={canChooseHosted}
          />
        </SettingsGroup>

        {mode === "unknown" && status ? (
          <p className="text-sm text-[var(--app-text-secondary)]">
            We couldn’t verify your hosting. Your existing setup has not changed.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {isOwnerCloudTarget(status?.deploymentTarget) ? (
            <CloudRemovalControl
              provider={
                ownerCloudProvider(status?.deploymentTarget) === "azure" ? "azure" : "gcp"
              }
            />
          ) : null}
          <Button
            variant="muted"
            disabled={busy}
            onClick={() => void checkStatus()}
            className="min-h-10 rounded-full px-4 text-sm font-semibold"
          >
            Check hosting
          </Button>
          {mode === "byoc" || needsLinkRecovery ? (
            <Button
              variant="muted"
              disabled={busy}
              onClick={() =>
                void (needsLinkRecovery ? recoverExistingPod() : reconnectDirectPod())
              }
              className="min-h-10 rounded-full px-4 text-sm font-semibold"
            >
              {needsLinkRecovery ? "Link existing pod" : "Reconnect your pod"}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const { stateLabel, release, versionLabel, rawBuildLabel, isPersonalSandbox } =
    agentSettingsSummary(model);
  const hasUpdateDetails = Boolean(
    isPod &&
      (rawBuildLabel ||
        status?.releaseCheckedAt ||
        status?.installedReleaseVerifiedAt ||
        (release && update.available)),
  );

  if (activeDetail === "update-details" && hasUpdateDetails) {
    return (
      <div className="space-y-5" data-testid="update-details-view">
        {!onOpenDetail ? (
          <div>
            <Button type="button" variant="muted" size="sm" onClick={closeLocalDetail}>
              Back to Agent updates
            </Button>
          </div>
        ) : null}

        <SettingsGroup title="Version details" density="compact" headingClassName="!mt-0">
          <SettingsRow title="Status" description={stateLabel} textOverflow="truncate" />
          <SettingsRow
            title="Current version"
            description={versionLabel ?? "Unavailable"}
            textOverflow="truncate"
          />
          {rawBuildLabel && rawBuildLabel !== versionLabel ? (
            <SettingsRow title="Build" description={rawBuildLabel} />
          ) : null}
          {status?.releaseCheckedAt ? (
            <SettingsRow
              title="Last checked"
              description={new Date(status.releaseCheckedAt).toLocaleString()}
            />
          ) : null}
          {status?.installedReleaseVerifiedAt ? (
            <SettingsRow
              title="Installation verified"
              description={new Date(status.installedReleaseVerifiedAt).toLocaleString()}
            />
          ) : null}
        </SettingsGroup>

        {release && update.available ? (
          <SettingsGroup title="What’s in this update" density="compact">
            <div className="space-y-3 p-4 text-sm">
              <p className="text-[var(--app-text-secondary)]">{release.summary}</p>
              {Object.entries(release.notes)
                .filter(([, entries]) => entries.length > 0)
                .map(([heading, entries]) => (
                  <div key={heading} className="space-y-1">
                    <h3 className="text-xs font-semibold capitalize text-foreground">
                      {heading}
                    </h3>
                    <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--app-text-secondary)]">
                      {entries.map((text, index) => (
                        <li key={index}>{text}</li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          </SettingsGroup>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsGroup density="compact">
        <SettingsRow title="Status" description={stateLabel} textOverflow="truncate" />
        {mode === "shared" || isPod ? (
          <SettingsRow
            title="Current version"
            description={versionLabel ?? "Unavailable"}
            textOverflow="truncate"
            onClick={hasUpdateDetails ? () => openDetail("update-details") : undefined}
            chevron={hasUpdateDetails}
            testId="agent-current-version-row"
          />
        ) : null}
        {release && update.available ? (
          <SettingsRow
            title="New version"
            description={releaseLabel(release.version, release.releasedAt)}
            textOverflow="truncate"
            onClick={hasUpdateDetails ? () => openDetail("update-details") : undefined}
            chevron={hasUpdateDetails}
          />
        ) : null}
      </SettingsGroup>

      {isPod && !isPersonalSandbox ? (
        <AgentUpdateActivity
          update={update}
          awaitingMicrosoft={awaitingMicrosoft}
          follow={azureUpdate}
          retryWithMicrosoft={
            ownerCloudProvider(status?.deploymentTarget) === "azure" &&
            update.failed &&
            update.presentationState === "blocked" &&
            Boolean(update.operationId)
          }
        />
      ) : null}

      {mode === "byoc" &&
      isOwnerCloudTarget(status?.deploymentTarget) &&
      status?.browserActivationAvailable ? (
        <BrowserActivationPanel
          userId={userId}
          disabled={busy || working}
          onScheduled={refresh}
          model={browser}
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        {needsLinkRecovery ? (
          <Button
            variant="muted"
            disabled={busy}
            onClick={() => void recoverExistingPod()}
            className="min-h-10 rounded-full px-4 text-sm font-semibold"
          >
            Link existing pod
          </Button>
        ) : null}
        {mode === "byoc" &&
        !needsLinkRecovery &&
        status?.updateAvailable === true &&
        !canInstallUpdate(status) &&
        !working &&
        status.updateBlockedReason === "INSTALLED_RELEASE_UNVERIFIED" ? (
          <Button
            variant="muted"
            disabled={busy}
            onClick={() => void reconnectDirectPod()}
            className="min-h-10 rounded-full px-4 text-sm font-semibold"
          >
            Reconnect your pod
          </Button>
        ) : null}
        {mode === "byoc" &&
        status?.updateAvailable === true &&
        !canInstallUpdate(status) &&
        !working &&
        (status.updateBlockedReason === "PREDECESSOR_NOT_QUALIFIED" ||
          status.updateBlockedReason === "INSTALLED_RELEASE_UNVERIFIED") ? (
          <Button
            variant="muted"
            disabled={busy}
            onClick={chooseHosting}
            className="min-h-10 rounded-full px-4 text-sm font-semibold"
          >
            Review cloud hosting
          </Button>
        ) : null}
        {isPod &&
        !isPersonalSandbox &&
        canInstallUpdate(status) &&
        update.releaseId &&
        !working ? (
          <>
            <Button
              disabled={busy}
              onClick={() => void act("approve")}
              className="min-h-10 rounded-full px-4 text-sm font-semibold"
            >
              Update now
            </Button>
            <Button
              variant="muted"
              disabled={busy}
              onClick={() => void act("defer")}
              className="min-h-10 rounded-full px-4 text-sm font-semibold"
            >
              Later
            </Button>
          </>
        ) : null}
        <Button
          variant="muted"
          disabled={busy}
          onClick={() => void checkStatus()}
          className="min-h-10 rounded-full px-4 text-sm font-semibold"
        >
          Check for updates
        </Button>
        {isPod && update.failed && update.operationId ? (
          <Button
            variant="muted"
            disabled={busy}
            onClick={() => void sendFailureReport()}
            className="min-h-10 rounded-full px-4 text-sm font-semibold"
          >
            Send failure report
          </Button>
        ) : null}
      </div>

      {isPod && update.failed && update.operationId ? (
        <p className="text-xs text-[var(--app-text-secondary)]">
          This sends the update ID, release ID, and up to 12 lifecycle events when you choose to
          report it. It does not send pod logs or your files.
        </p>
      ) : null}
    </div>
  );
}

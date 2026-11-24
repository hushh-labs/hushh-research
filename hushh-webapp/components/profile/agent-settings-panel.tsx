"use client";

import { useState } from "react";
import { CloudHostingHealth } from "./cloud-hosting-health";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  hostModeLabel,
  agentSettingsSummary,
  useAgentSettingsController,
  type AgentSettingsController,
} from "./use-agent-settings-controller";
export {
  HOST_LABELS,
  hostModeLabel,
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
  const [confirmSwitch, setConfirmSwitch] = useState<
    "shared" | "own_cloud" | "sandbox" | null
  >(null);
  const [removePriorCloudOnSandboxSwitch, setRemovePriorCloudOnSandboxSwitch] =
    useState(false);
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
    switchToSharedHosting,
    switchToOwnCloud,
    switchToPersonalSandbox,
    browser,
    azureHosting,
  } = model;

  if (kind === "hosting") {
    const pooledSwitchAvailable = isPooledSandboxSwitchAvailable();
    const isPersonalSandboxActive =
      mode === "hussh_pods" && status?.deploymentTarget === "ace";
    const canManageCloud =
      status?.featureEnabled === true &&
      (mode === "shared" ||
        mode === "pending" ||
        mode === "byoc" ||
        mode === "unplaced" ||
        mode === "hussh_pods");
    const canSwitchToShared = mode === "hussh_pods";
    const hostedUnderMaintenance = isHostedPodTierUnderMaintenance();
    const canSwitchToSandboxFromRow =
      pooledSwitchAvailable &&
      (mode === "shared" ||
        mode === "unplaced" ||
        mode === "pending" ||
        mode === "byoc" ||
        (mode === "hussh_pods" && status?.deploymentTarget !== "ace"));
    const canChooseHosted =
      canSwitchToSandboxFromRow ||
      (!hostedUnderMaintenance &&
        status?.featureEnabled === true &&
        (mode === "shared" || mode === "pending" || mode === "unplaced"));
    const activeHostedProvider = hostedPodProvider(status?.deploymentTarget);
    const activeCloudProvider = podCloudProvider(status?.deploymentTarget);
    const currentHostingDescription = !status
      ? "Checking hosting…"
      : mode === "hussh_pods"
        ? hostedPodDisplayLabel(status.deploymentTarget)
        : hostModeLabel(mode);
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

    const hasCurrentHostingBadges = Boolean(
      activeCloudProvider ||
        (mode === "hussh_pods" && status?.deploymentTarget === "ace") ||
        (mode === "hussh_pods" && status?.state === "active"),
    );

    const currentHostingBadges = hasCurrentHostingBadges ? (
      <span className="flex flex-wrap items-center gap-1.5 pt-1">
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
          <PodCloudBadge
            provider="gcp"
            label="Google Cloud"
            testId="current-hosting-cloud-badge"
          />
        ) : null}
      </span>
    ) : null;

    return (
      <div className="space-y-5">
        <SettingsGroup density="compact">
          <SettingsRow
            title="Current hosting"
            voicePurpose={currentHostingDescription}
            description={
              currentHostingBadges ? (
                <span className="flex flex-col gap-0.5">
                  <span className="text-foreground/90">{currentHostingDescription}</span>
                  {currentHostingBadges}
                </span>
              ) : (
                currentHostingDescription
              )
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
            />
          ) : null}
          <CloudHostingHealth inspection={inspection} />
        </SettingsGroup>

        {mode === "byoc" && ownerCloudProvider(status?.deploymentTarget) === "azure" ? (
          <AzureHostingNotice model={azureHosting} />
        ) : null}

        {showPooledSandboxSwitch ? (
          <SettingsGroup title="Confidential Sandbox" density="compact" headingClassName="!mt-5">
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
          {!pooledSwitchAvailable ? (
            <SettingsRow
              title="Hussh Shared"
              description={
                mode === "byoc"
                  ? "Remove your current cloud below to switch."
                  : "Managed shared service with automatic updates."
              }
              textOverflow="truncate"
              trailing={
                mode === "shared"
                  ? "Current"
                  : mode === "unplaced"
                    ? "Choose"
                    : canSwitchToShared
                      ? "Switch"
                      : undefined
              }
              disabled={busy && canSwitchToShared}
              onClick={
                mode === "unplaced"
                  ? chooseHosting
                  : canSwitchToShared
                    ? () => setConfirmSwitch("shared")
                    : undefined
              }
              chevron={mode === "unplaced" || canSwitchToShared}
              testId="hosting-choice-shared"
            />
          ) : null}
          <SettingsRow
            title="Bring your own cloud"
            description={
              status && !status.featureEnabled
                ? "Temporarily unavailable for new setups."
                : "Your own Google Cloud or Azure project. You approve updates."
            }
            textOverflow="truncate"
            trailing={
              mode === "byoc"
                ? "Current"
                : status && !status.featureEnabled
                  ? "Unavailable"
                  : mode === "pending"
                    ? "Continue"
                    : canManageCloud && (mode === "shared" || mode === "hussh_pods")
                      ? "Switch"
                      : canManageCloud && mode === "unplaced"
                        ? "Choose"
                        : undefined
            }
            disabled={busy && canManageCloud}
            onClick={
              !canManageCloud
                ? undefined
                : mode === "hussh_pods" && !(pooledSwitchAvailable && isPersonalSandboxActive)
                  ? () => setConfirmSwitch("own_cloud")
                  : mode === "shared" || (mode === "hussh_pods" && pooledSwitchAvailable && isPersonalSandboxActive)
                    ? () => void switchToOwnCloud()
                    : chooseHosting
            }
            chevron={canManageCloud}
            testId="hosting-choice-own-cloud"
          />
          <SettingsRow
            title={pooledSwitchAvailable ? "Hussh Confidential Sandbox" : "Hussh Pods"}
            description={
              isPersonalSandboxActive || pooledSwitchAvailable
                ? "Isolated Confidential Sandbox on Google Cloud."
                : mode === "hussh_pods"
                  ? activeHostedProvider
                    ? `Dedicated pod on ${HOSTED_POD_PROVIDER_LABELS[activeHostedProvider]}.`
                    : "Dedicated Hussh-hosted pod."
                  : hostedUnderMaintenance
                    ? "Unavailable for new setups."
                    : "Dedicated pod on Google Cloud."
            }
            textOverflow="truncate"
            trailing={
              isPersonalSandboxActive || (mode === "hussh_pods" && !pooledSwitchAvailable) ? (
                "Current"
              ) : mode === "hussh_pods" && pooledSwitchAvailable ? (
                "Switch"
              ) : !pooledSwitchAvailable && hostedUnderMaintenance ? (
                "Unavailable"
              ) : canSwitchToSandboxFromRow ? (
                <span className="inline-flex items-center gap-2">
                  <PodCloudBadge provider="gcp" label="Google Cloud" />
                  <span className="text-xs font-medium text-[var(--app-text-secondary)]">
                    Switch
                  </span>
                </span>
              ) : (
                <PodCloudBadge provider="gcp" label="Google Cloud" />
              )
            }
            disabled={busy && canChooseHosted}
            onClick={
              !canChooseHosted
                ? undefined
                : canSwitchToSandboxFromRow
                  ? () => {
                      setRemovePriorCloudOnSandboxSwitch(false);
                      setConfirmSwitch("sandbox");
                    }
                  : chooseHosting
            }
            chevron={canChooseHosted && !(isPersonalSandboxActive || (mode === "hussh_pods" && !pooledSwitchAvailable))}
            testId="hosting-choice-pods"
          />
        </SettingsGroup>

        <AlertDialog
          open={confirmSwitch === "shared"}
          onOpenChange={(open) => !busy && setConfirmSwitch(open ? "shared" : null)}
        >
          <AlertDialogContent size="default">
            <AlertDialogHeader>
              <AlertDialogTitle>Switch to Hussh Shared?</AlertDialogTitle>
              <AlertDialogDescription>
                Agent One will run on the managed Hussh Shared service with automatic updates. Your encrypted Vault stays intact, and your prior pod placement is retained safely in history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                data-testid="hosting-switch-shared-confirm"
                onClick={(event) => {
                  event.preventDefault();
                  void Promise.resolve(switchToSharedHosting()).then((switched) => {
                    if (switched !== false) setConfirmSwitch(null);
                  });
                }}
              >
                {busy ? "Switching…" : "Switch to Hussh Shared"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={confirmSwitch === "own_cloud"}
          onOpenChange={(open) => !busy && setConfirmSwitch(open ? "own_cloud" : null)}
        >
          <AlertDialogContent size="default">
            <AlertDialogHeader>
              <AlertDialogTitle>Switch to Bring your own cloud?</AlertDialogTitle>
              <AlertDialogDescription>
                Your current Hussh Pod placement will be detached and retained safely in history so you can connect your own Google Cloud project or Microsoft Azure subscription next.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                data-testid="hosting-switch-own-cloud-confirm"
                onClick={(event) => {
                  event.preventDefault();
                  void Promise.resolve(switchToOwnCloud()).then((switched) => {
                    if (switched !== false) setConfirmSwitch(null);
                  });
                }}
              >
                {busy ? "Preparing…" : "Continue to cloud setup"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={confirmSwitch === "sandbox"}
          onOpenChange={(open) => !busy && setConfirmSwitch(open ? "sandbox" : null)}
        >
          <AlertDialogContent size="default">
            <AlertDialogHeader>
              <AlertDialogTitle>Switch to Hussh Confidential Sandbox?</AlertDialogTitle>
              <AlertDialogDescription>
                Move Agent One into an isolated Hussh Confidential Sandbox on Google Cloud with built-in AI. Your encrypted Vault stays intact.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {mode === "byoc" ? (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-[var(--app-border)] bg-background p-3 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={removePriorCloudOnSandboxSwitch}
                  onChange={(e) => setRemovePriorCloudOnSandboxSwitch(e.target.checked)}
                  data-testid="hosting-choice-sandbox-remove-cloud-checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-[var(--app-border)] accent-[color:var(--app-accent)]"
                />
                <span>Also remove Hussh pod resources from my cloud in the background</span>
              </label>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                data-testid="hosting-switch-sandbox-confirm"
                onClick={(event) => {
                  event.preventDefault();
                  const removeCloud = mode === "byoc" && removePriorCloudOnSandboxSwitch;
                  void Promise.resolve(
                    switchToPersonalSandbox({ removePriorCloudResources: removeCloud }),
                  ).then((switched) => {
                    if (switched !== false) setConfirmSwitch(null);
                  });
                }}
              >
                {busy ? "Switching…" : "Switch to Confidential Sandbox"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

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

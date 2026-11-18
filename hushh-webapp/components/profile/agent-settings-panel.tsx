"use client";

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
  ownerCloudProvider,
  podCloudProvider,
} from "@/lib/one/owner-cloud";
import {
  HostedPodDualCloudMarks,
  HusshPodsActiveCard,
  HusshPodsMigrationCard,
  PodCloudBadge,
} from "@/components/connections/hussh-pods-cloud-card";
import { ROUTES } from "@/lib/navigation/routes";
import { HOST_LABELS, agentSettingsSummary, useAgentSettingsController, type AgentSettingsController } from "./use-agent-settings-controller";
export { HOST_LABELS, agentSettingsSummary, useAgentSettingsController } from "./use-agent-settings-controller";
export type { AgentSettingsController } from "./use-agent-settings-controller";

export function AgentSettingsPanel({ kind, userId, controller }: {
  kind: "hosting" | "software-updates"; userId: string; controller?: AgentSettingsController;
}) {
  return controller ? <AgentSettingsBody model={controller} /> : <OwnedAgentSettingsPanel kind={kind} userId={userId} />;
}

function OwnedAgentSettingsPanel({ kind, userId }: { kind: "hosting" | "software-updates"; userId: string }) {
  return <AgentSettingsBody model={useAgentSettingsController({ kind, userId })} />;
}

function AgentSettingsBody({ model }: { model: AgentSettingsController }) {
  const { kind, userId, status, update, refresh, azureUpdate, busy, inspection, mode, isPod,
    needsLinkRecovery, awaitingMicrosoft, working, checkStatus, act, reconnectDirectPod,
    sendFailureReport, recoverExistingPod, chooseHosting, browser, azureHosting } = model;

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
    const showHostedMigration =
      isHostedAzureMigrationAvailable() &&
      status?.state === "active" &&
      (mode === "byoc" || (mode === "hussh_pods" && activeHostedProvider === "gcp"));

    return (
      <div className="space-y-5">
        <SettingsGroup density="compact">
          <SettingsRow
            title="Current hosting"
            description={currentHostingDescription}
            trailing={
              activeCloudProvider ? (
                <PodCloudBadge
                  provider={activeCloudProvider}
                  label={
                    mode === "hussh_pods" && activeHostedProvider
                      ? HOSTED_POD_PROVIDER_LABELS[activeHostedProvider]
                      : undefined
                  }
                  testId="current-hosting-cloud-badge"
                />
              ) : undefined
            }
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
        {mode === "hussh_pods" && !hostedUnderMaintenance ? (
          <SettingsGroup title="Hussh Pods cloud" density="compact" headingClassName="!mt-5">
            <HusshPodsActiveCard deploymentTarget={status?.deploymentTarget} embedded />
          </SettingsGroup>
        ) : null}
        {mode === "byoc" && ownerCloudProvider(status?.deploymentTarget) === "azure" ? (
          <AzureHostingNotice model={azureHosting} />
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

        <SettingsGroup
          title="Hosting choices"
          density="compact"
          headingClassName="!mt-5"
        >
          <SettingsRow
            title="Hussh Shared"
            description={mode === "byoc" ? "To switch, review and remove your current cloud below. Your Hussh account stays." : "Hussh runs and updates the shared service automatically."}
            trailing={mode === "shared" ? "Current" : mode === "unplaced" ? "Choose" : undefined}
            onClick={mode === "unplaced" ? chooseHosting : undefined}
            chevron={mode === "unplaced"}
          />
          <SettingsRow
            title="Bring your own cloud"
            description={
              status && !status.featureEnabled
                ? "New cloud setup is temporarily unavailable. Your existing setup is unchanged."
                : "Agent One and device relay. You approve updates."
            }
            trailing={
              mode === "byoc"
                ? "Current"
                : status && !status.featureEnabled
                  ? "Unavailable"
                  : mode === "pending"
                    ? "Continue"
                    : undefined
            }
            onClick={
              canManageCloud
                ? chooseHosting
                : undefined
            }
            chevron={canManageCloud}
          />
          <SettingsRow
            title="Hussh Pods"
            description={
              mode === "hussh_pods"
                ? activeHostedProvider
                  ? `Dedicated pod on ${HOSTED_POD_PROVIDER_LABELS[activeHostedProvider]}. You approve updates.`
                  : "Your dedicated Hussh-hosted pod. You approve updates."
                : hostedUnderMaintenance
                  ? "Dedicated hosting is unavailable for new setups."
                  : "Dedicated pod on Google Cloud or Microsoft Azure."
            }
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
          <p className="text-sm text-muted-foreground">
            We couldn’t verify your hosting. Your existing setup has not
            changed.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {isOwnerCloudTarget(status?.deploymentTarget) ? <CloudRemovalControl provider={ownerCloudProvider(status?.deploymentTarget) === "azure" ? "azure" : "gcp"} /> : null}
          <Button
            variant="muted"
            disabled={busy}
            onClick={() => void checkStatus()}
          >
            Check hosting
          </Button>
          {mode === "byoc" || needsLinkRecovery ? (
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

  const { stateLabel, release, versionLabel } = agentSettingsSummary(model);
  return (
    <div className="space-y-5">
      <SettingsGroup density="compact">
        <SettingsRow title="Status" description={stateLabel} />
        {mode === "shared" || isPod ? (
          <SettingsRow
            title="Current version"
            description={versionLabel ?? "Unavailable"}
          />
        ) : null}
        {release && update.available ? (
          <SettingsRow title="New version" description={releaseLabel(release.version, release.releasedAt)} />
        ) : null}
      </SettingsGroup>

      {isPod ? <AgentUpdateActivity update={update} awaitingMicrosoft={awaitingMicrosoft} follow={azureUpdate}
        retryWithMicrosoft={ownerCloudProvider(status?.deploymentTarget) === "azure" && update.failed &&
          update.presentationState === "blocked" && Boolean(update.operationId)} /> : null}

      {mode === "byoc" && isOwnerCloudTarget(status?.deploymentTarget) && status?.browserActivationAvailable ? (
        <BrowserActivationPanel userId={userId} disabled={busy || working} onScheduled={refresh} model={browser} />
      ) : null}

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
        {mode === "byoc" &&
        !needsLinkRecovery &&
        status?.updateAvailable === true &&
        !canInstallUpdate(status) &&
        !working &&
        status.updateBlockedReason === "INSTALLED_RELEASE_UNVERIFIED" ? (
          <Button variant="muted" disabled={busy} onClick={() => void reconnectDirectPod()}>
            Reconnect your pod
          </Button>
        ) : null}
        {mode === "byoc" &&
        status?.updateAvailable === true &&
        !canInstallUpdate(status) &&
        !working &&
        (status.updateBlockedReason === "PREDECESSOR_NOT_QUALIFIED" ||
          status.updateBlockedReason === "INSTALLED_RELEASE_UNVERIFIED") ? (
          <Button variant="muted" disabled={busy} onClick={chooseHosting}>
            Review cloud hosting
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

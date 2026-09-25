"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { Button } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import { ApiService } from "@/lib/services/api-service";
import { isAgentAsleep, isAgentNotAnswering } from "@/lib/feed/agent-presence-policy";

const HOST_LABELS = {
  shared: "Hussh Shared",
  byoc: "Your cloud",
  hussh_pods: "Hussh Pods",
  pending: "Setup in progress",
  unknown: "Hosting unavailable",
} as const;

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
  const [error, setError] = useState<string | null>(null);
  const mode = status?.hostingMode ?? "unknown";
  const working = update.inProgress || update.presentationState === "scheduled";

  async function act(action: "approve" | "defer") {
    if (
      busyRef.current ||
      !status?.updateOfferable ||
      !update.releaseId ||
      working
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action === "approve") {
        await ApiService.approvePersonalAgentUpdate({
          releaseId: update.releaseId,
          idempotencyKey: crypto.randomUUID(),
        });
      } else {
        await ApiService.deferPersonalAgentUpdate({
          releaseId: update.releaseId,
        });
      }
      dispatchFeedStateChanged();
      refresh();
    } catch {
      setError(
        "We couldn’t complete that request. Check for updates and try again.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (kind === "hosting") {
    return (
      <div className="space-y-4">
        <SettingsGroup title="Where your private agent runs">
          <SettingsRow
            title="Hosting"
            description={status ? HOST_LABELS[mode] : "Checking hosting…"}
          />
          {status?.cloudProject ? (
            <SettingsRow
              title="Cloud project"
              description={status.cloudProject}
            />
          ) : null}
          {status?.cloudRegion ? (
            <SettingsRow title="Region" description={status.cloudRegion} />
          ) : null}
        </SettingsGroup>
        {mode === "shared" ? (
          <p className="text-sm text-muted-foreground">
            Hussh manages the shared service. Set up your own cloud for a
            dedicated private agent and Puppy’s private device relay.
          </p>
        ) : null}
        {mode === "pending" ? (
          <p className="text-sm text-muted-foreground">
            Continue your existing setup to verify your cloud and finish
            connecting your private agent.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {mode !== "unknown" ? (
            <Button onClick={() => router.push(ROUTES.ONE_SETUP_CLOUD)}>
              {mode === "shared"
                ? "Set up your cloud"
                : mode === "pending"
                  ? "Continue setup"
                  : "Manage hosting"}
            </Button>
          ) : null}
          <Button variant="muted" onClick={refresh}>
            Check hosting
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          New Hussh Pods deployments are currently unavailable.
        </p>
      </div>
    );
  }

  const shared = mode === "shared";
  const stateLabel = !status
    ? "Checking release status…"
    : shared
      ? "Managed by Hussh"
      : working
        ? "Finishing current work and updating"
        : update.failed
          ? "Update needs attention"
          : status.installedReleaseVerified === true &&
              update.available === false
            ? "Latest offered version installed"
            : update.available === true
              ? "Update available"
              : "Running version not verified";
  const release = status?.availableRelease;
  return (
    <div className="space-y-4">
      <SettingsGroup title="Software updates">
        <SettingsRow title="Status" description={stateLabel} />
        {!shared ? (
          <SettingsRow
            title="Pod connection"
            description={
              isAgentNotAnswering(status?.health)
                ? "Not responding. Installed version details are from the last verification."
                : isAgentAsleep(status?.health)
                  ? "Asleep; wakes when needed."
                  : status?.health === "healthy"
                    ? "Last reported healthy"
                    : "Connection not verified"
            }
          />
        ) : null}
        <SettingsRow
          title="Installed version"
          description={status?.installedRelease?.version ?? "Not verified"}
        />
        {release ? (
          <SettingsRow
            title="Available version"
            description={release.version}
          />
        ) : null}
        {status?.releaseCheckedAt ? (
          <SettingsRow
            title="Release channel checked"
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
      {shared ? (
        <p className="text-sm text-muted-foreground">
          Hussh updates this shared service. If you set up your own cloud, you
          choose when to install updates to your private agent.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          You choose when to install. We finish active work and verify your
          private agent before reporting the update complete.
        </p>
      )}
      {release ? (
        <section aria-label="Release notes" className="space-y-3">
          <p className="text-sm">{release.summary}</p>
          {Object.entries(release.notes)
            .filter(([, entries]) => entries.length > 0)
            .map(([heading, entries]) => (
              <div key={heading}>
                <h3 className="text-sm font-medium capitalize">{heading}</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {entries.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </div>
            ))}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          Verified release notes are not available yet.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!shared &&
        status?.updateOfferable === true &&
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
        <Button variant="muted" disabled={busy} onClick={refresh}>
          Check for updates
        </Button>
      </div>
      {update.running || update.target ? (
        <details className="text-sm text-muted-foreground">
          <summary>Technical details</summary>
          <dl className="mt-2 space-y-2 break-all">
            <dt>Reported running build</dt>
            <dd>{update.running ?? "Unknown"}</dd>
            <dt>Offered build</dt>
            <dd>{update.target ?? "Unknown"}</dd>
          </dl>
        </details>
      ) : null}
    </div>
  );
}

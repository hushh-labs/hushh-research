"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { GoogleCloudLogo } from "@/components/brand/google-cloud-logo";
import { MicrosoftAzureLogo } from "@/components/brand/microsoft-azure-logo";
import { ByocSetupFailedCard } from "@/components/connections/byoc-setup-failed-card";
import { SetupStageChecklist } from "@/components/connections/byoc-setup-stage-checklist";
import {
  HostingChoiceCards,
  type HostingChoice,
  type HostingChoiceOption,
} from "@/components/connections/hosting-choice-cards";
import { OwnerCloudProviderChoice } from "@/components/connections/owner-cloud-provider-choice";
import {
  DedicatedHostingRowIcon,
  OwnCloudRowIcon,
  PauseRowIcon,
  SharedHostingRowIcon,
} from "@/components/icons";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  azureSubscriptionFromRef,
  useAzureSetupStartedSignal,
  useAzureSignIn,
} from "@/lib/one/azure-sign-in";
import {
  setupChecklistFor,
  setupJobProvider,
  setupRetryFor,
} from "@/lib/one/cloud-setup-stages";
import {
  isAzureHomeSelectable,
  isOwnerCloudTarget,
  ownerCloudProvider,
  type OwnerCloudProvider,
} from "@/lib/one/owner-cloud";
import { ApiService } from "@/lib/services/api-service";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import { ROUTES } from "@/lib/navigation/routes";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

/**
 * `/one/setup/cloud` — where a person's private agent gets somewhere to live.
 *
 * This step chooses the hosting placement independently of AI provider access.
 * Shared is the default when the server confirms no pod assignment or pending
 * setup; BYOC and the gated Hussh Pods path are explicit alternatives.
 *
 * The owner signs in to their cloud once: Google for a Google Cloud project,
 * Microsoft for an Azure subscription. The server creates or verifies the home,
 * proves authorization, and only then records the cloud assignment.
 */

/** The revisit state for an agent whose home is the person's Azure subscription. */
function azureConnected(location: string | null | undefined) {
  return {
    projectId: "Microsoft Azure",
    rationale: location
      ? `Your private agent runs in ${location}, in your own Azure subscription.`
      : "Your private agent runs in your own Azure subscription.",
  };
}

/** How long "Checking your cloud..." may stay on screen before the form shows. */
export const CLOUD_CHECK_TIMEOUT_MS = 15_000;

export function ByocCloudSetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const authorizationStarting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // The already-connected state, resolved on mount. This page used to hold all
  // connection truth in per-session state, so a person whose cloud was fully
  // recorded came back to a blank form with a dead Finish button (audit
  // finding, 2026-08-21). The durable cloud marker follows proof, so the
  // owner's registry assignment is the source for this revisit state.
  const [existing, setExisting] = useState<{
    projectId: string;
    rationale: string;
  } | null>(null);
  // Which hosting card is picked. Null falls back to the confirmed Shared state.
  const [choice, setChoice] = useState<HostingChoice | null>(null);
  // The hosted door is closed for maintenance (founder direction, 2026-09-02):
  // the card stays visible so the choice is still honest, but it cannot be
  // taken. Lift it with NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE=0; no code
  // change is needed to reopen.
  const hostedUnderMaintenance =
    process.env.NEXT_PUBLIC_HOSTED_POD_TIER_MAINTENANCE !== "0";
  const [hostedSaving, setHostedSaving] = useState(false);
  const [hosted, setHosted] = useState<Awaited<
    ReturnType<typeof ApiService.selectHostedCloud>
  > | null>(null);
  const [sharedChosen, setSharedChosen] = useState(false);
  const [sharedSaving, setSharedSaving] = useState(false);
  const [hostingMode, setHostingMode] = useState<
    "shared" | "byoc" | "hussh_pods" | "pending" | "unknown" | null
  >(null);
  const [hostingStatusChecked, setHostingStatusChecked] = useState(false);
  const [reservedProjectId, setReservedProjectId] = useState<string | null>(null);
  // Which owner cloud the registry names, so a reserved or assigned Azure home
  // is never sent down the Google authorization path.
  const [ownerProvider, setOwnerProvider] = useState<OwnerCloudProvider | null>(null);
  const azureSignIn = useAzureSignIn();
  const { start: startAzureSignIn } = azureSignIn;
  // The live stage record of the background setup job. Fetched on mount (a
  // person can leave and come back mid-job) and polled every 2s while running.
  // A setup's popup finished and the hub started the job: read it now, not in 2s.
  const [setupPollNonce, setSetupPollNonce] = useState(0);
  useAzureSetupStartedSignal(() => setSetupPollNonce((value) => value + 1), "setup");
  // Where the agent lives is read once on mount; a job this page watched run
  // to recorded re-reads it, or the screen stays on "still in progress".
  const [agentStatusNonce, setAgentStatusNonce] = useState(0);
  const watchedRunningJob = useRef(false);
  const [job, setJob] = useState<Awaited<
    ReturnType<typeof ApiService.getByocSetupStatus>
  > | null>(null);
  // The first answer from the job store has not arrived yet. Until it has,
  // the page must not show the tier choice: on the return from Google the
  // choice flashed for a beat before the "connected" state replaced it
  // (founder-hit, 2026-09-02). Failed polls give up into the form, never hang.
  const [checked, setChecked] = useState(false);
  const [setupStatusReadOk, setSetupStatusReadOk] = useState(false);
  const [checkTimedOut, setCheckTimedOut] = useState(false);

  // "Checking your agent home..." must end. If placement or setup state cannot
  // be read, the page offers refresh and keeps every existing assignment intact.
  useEffect(() => {
    if (!user?.uid) return;
    if (checked && hostingStatusChecked) {
      setCheckTimedOut(false);
      return;
    }
    const ceiling = setTimeout(() => {
      setCheckTimedOut(true);
      setChecked(true);
    }, CLOUD_CHECK_TIMEOUT_MS);
    return () => clearTimeout(ceiling);
  }, [user?.uid, checked, hostingStatusChecked]);

  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    void ApiService.getPersonalAgentStatus()
      .then((status) => {
        if (cancelled) return;
        const mode = status.hostingMode ?? "unknown";
        const provider = ownerCloudProvider(status.deploymentTarget);
        setHostingMode(mode);
        setOwnerProvider(provider);
        setHostingStatusChecked(true);
        const unassignedByoc =
          (mode === "pending" || mode === "byoc") &&
          status.state === "reserved" &&
          isOwnerCloudTarget(status.deploymentTarget) &&
          Boolean(status.cloudProject);
        setReservedProjectId(
          unassignedByoc ? status.cloudProject ?? null : null,
        );
        if (mode === "byoc" && provider === "azure" && !unassignedByoc) {
          setExisting(azureConnected(status.cloudProject));
        } else if (mode === "byoc" && status.cloudProject && !unassignedByoc) {
          setExisting({
            projectId: status.cloudProject,
            rationale: "Your own-cloud agent is still assigned.",
          });
        } else if (mode === "byoc" && !unassignedByoc) {
          setChoice("own");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHostingMode("unknown");
          setReservedProjectId(null);
          setHostingStatusChecked(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [user?.uid, agentStatusNonce]);

  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const status = await ApiService.getByocSetupStatus();
        if (cancelled) return;
        setJob(status.status === "none" ? null : status);
        setChecked(true);
        setSetupStatusReadOk(true);
        if (status.status === "running") watchedRunningJob.current = true;
        if (status.status === "recorded" && watchedRunningJob.current) {
          watchedRunningJob.current = false;
          setAgentStatusNonce((value) => value + 1);
        }
        if (status.status === "recorded") {
          // Only a Google job restores its project from the Google suggestion;
          // an Azure home is already named by the registry status above.
          if (hostingMode === "byoc" && setupJobProvider(status) === "gcp") {
            // The durable marker just landed server-side; refresh the shared
            // bootstrap and restore the BYOC project shown to the person.
            await PreVaultUserStateService.bootstrapState(user.uid, {
              force: true,
            }).catch(() => undefined);
            if (cancelled) return;
            const suggestion = await ApiService.suggestByocProject().catch(
              () => null,
            );
            if (cancelled) return;
            if (suggestion) {
              setExisting({
                projectId: suggestion.projectId,
                rationale: suggestion.rationale ?? "",
              });
            }
          }
          return;
        }
        if (status.status === "running" && !status.stale) {
          timer = setTimeout(() => void poll(), 2000);
        }
      } catch {
        // A missed poll is not a verdict; retry a few times, then stop rather
        // than hammering a deployment that has no job store (the naming form
        // below is always a truthful fallback).
        failures += 1;
        if (!cancelled && failures < 3) {
          timer = setTimeout(() => void poll(), 4000);
        } else {
          setChecked(true);
        }
      }
    };
    let failures = 0;

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [user?.uid, hostingMode, setupPollNonce]);

  useEffect(() => {
    if (!user?.uid || hostingMode !== "byoc" || ownerProvider === "azure") return;
    let cancelled = false;
    void (async () => {
      try {
        const state =
          PreVaultUserStateService.getCachedBootstrapState(user.uid) ??
          (await PreVaultUserStateService.bootstrapState(user.uid));
        if (cancelled || !PreVaultUserStateService.hasOneCloudProject(state)) {
          return;
        }
        const suggestion = await ApiService.suggestByocProject();
        if (cancelled) return;
        setExisting({
          projectId: suggestion.projectId,
          rationale: suggestion.rationale ?? "",
        });
      } catch {
        // Resolving the connected state is best-effort; the naming form is
        // always a truthful fallback.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.uid, hostingMode, ownerProvider]);

  usePublishVoiceSurfaceMetadata({ screenId: "one_setup_cloud" });

  // The OAuth return route lands back here with the server's refusal when the
  // one-click flow could not finish (no billing account, name taken, ...).
  // Surfacing it verbatim is the whole point: it names the person's next move.
  useEffect(() => {
    const reason = searchParams.get("authorize_error");
    if (reason) setError(reason);
  }, [searchParams]);

  // Someone arriving from "Move it to my cloud" has already chosen; showing them
  // the choice again would ask a question they just answered. Their agent keeps
  // running on the hosted tier until their own project is proven, so this is the
  // first half of the move, not a switch that strands them mid-way.
  useEffect(() => {
    if (searchParams.get("intent") === "migrate") setChoice("own");
  }, [searchParams]);

  const handleProjectNamed = useCallback(async (projectId: string) => {
    if (authorizationStarting.current) return;
    authorizationStarting.current = true;
    setSaving(true);
    setError(null);
    try {
      // A transient suggestion failure must not strand someone who entered
      // an existing project. The backend alone admits Files to this setup.
      const suggestion = await ApiService.suggestByocProject().catch(() => null);
      const begun = await ApiService.beginByocAuthorize({
        projectId,
        filesEnabled: suggestion?.filesAvailable === true,
      });
      window.location.assign(begun.authUrl);
      return;
    } catch (err) {
      const serverReason =
        err instanceof Error &&
        err.message &&
        err.message !== "BYOC_AUTHORIZE_BEGIN_FAILED" &&
        err.message !== "BYOC_SUGGESTION_UNAVAILABLE"
          ? err.message
          : null;
      setError(
        serverReason ??
          "We could not start cloud setup. Your existing setup is unchanged; try again in a moment.",
      );
    } finally {
      authorizationStarting.current = false;
      setSaving(false);
    }
  }, []);

  // Azure's one-click setup: the Microsoft sign-in (in a popup), then the return
  // route. A retry names the failed job's subscription, which goes straight to its directory.
  const startAzureSetup = useCallback(
    (subscriptionId?: string | null) => {
      setError(null);
      return startAzureSignIn("setup", subscriptionId ?? undefined);
    },
    [startAzureSignIn],
  );

  const chooseHosted = useCallback(async () => {
    setError(null);
    setHostedSaving(true);
    try {
      const result = await ApiService.selectHostedCloud();
      setHosted(result);
      if (user?.uid) {
        // The server just wrote the durable `cloud` marker; refresh the shared
        // bootstrap so the hub and every other surface flip to the truth
        // without a reload — the same refresh the BYOC path does on its proof.
        await PreVaultUserStateService.bootstrapState(user.uid, {
          force: true,
        }).catch(() => undefined);
      }
    } catch (err) {
      // The server's reason verbatim. "Verify your phone number first" is a
      // normal step of this journey, and replacing it with a generic apology
      // strands the person with no next move.
      const reason =
        err instanceof Error &&
        err.message &&
        err.message !== "HOSTED_SELECT_FAILED"
          ? err.message
          : null;
      setError(
        reason ?? "We could not set that up just now. Try again in a moment.",
      );
    } finally {
      setHostedSaving(false);
    }
  }, [user?.uid]);

  const chooseShared = useCallback(async () => {
    setError(null);
    setSharedSaving(true);
    try {
      const result = await ApiService.selectSharedHosting();
      setHostingMode(result.hostingMode);
      setSharedChosen(true);
      if (user?.uid) {
        await PreVaultUserStateService.bootstrapState(user.uid, {
          force: true,
        }).catch(() => undefined);
      }
    } catch {
      setError(
        "We could not confirm that no pod is assigned yet. Your existing setup is unchanged; refresh and try again.",
      );
    } finally {
      setSharedSaving(false);
    }
  }, [user?.uid]);

  // A durable connected project or a selected hosting mode completes this step.
  const connectedBefore = existing !== null && reservedProjectId === null;
  const hostedChosen = hosted !== null;
  const recordedReservedProject = Boolean(
    reservedProjectId && setupStatusReadOk && job?.status === "recorded" &&
      job.projectId === reservedProjectId,
  );
  const authorized =
    connectedBefore || recordedReservedProject || hostedChosen || sharedChosen ||
    hostingMode === "hussh_pods";
  // One alert, whichever cloud's authorization refused.
  const shownError = error ?? azureSignIn.error;

  // Shared is the confirmed default when the server says so or this session chose it.
  const sharedConfirmed = hostingMode === "shared" || sharedChosen;
  const selectedHosting: HostingChoice | null =
    choice ?? (sharedConfirmed ? "shared" : null);
  // Azure is named only on a build where it can actually be chosen.
  const azureSelectable = isAzureHomeSelectable();
  const hostingOptions: HostingChoiceOption[] = [
    // Your own cloud leads: it is the private agent Hussh is built around.
    {
      value: "own",
      icon: OwnCloudRowIcon,
      title: "Bring your own cloud",
      description: azureSelectable
        ? "Your agent runs in your own Google Cloud Platform or Microsoft Azure account. You own it and pay for it."
        : "Your agent runs in your own Google Cloud Platform account. You own it and pay for it.",
      supporting: (
        <>
          <GoogleCloudLogo decorative className="h-4" />
          {azureSelectable ? <MicrosoftAzureLogo decorative className="h-4 w-4" /> : null}
        </>
      ),
      supportingDecorative: true,
      testId: "cloud-tier-own",
    },
    {
      value: "shared",
      icon: SharedHostingRowIcon,
      title: "Hussh Shared",
      description: "Start right away. Your private information stays locked to you.",
      supporting: "Not a dedicated agent. You can move to your own cloud later.",
      testId: "cloud-tier-shared-option",
    },
    {
      value: "hosted",
      icon: DedicatedHostingRowIcon,
      title: "Hussh Pods",
      description: "A dedicated agent we run for you.",
      supporting: hostedUnderMaintenance ? (
        <>
          <PauseRowIcon size={14} color="currentColor" aria-hidden="true" />
          Paused for maintenance
        </>
      ) : undefined,
      unavailable: hostedUnderMaintenance,
      testId: "cloud-tier-hosted",
    },
  ];
  // The one commit under the cards. Shared keeps its two ids: the confirm on a
  // confirmed Shared state, and the plain pick where Shared is not yet the default.
  const hostingCommit =
    selectedHosting === "shared"
      ? {
          label: sharedChosen
            ? "Hussh Shared selected"
            : sharedSaving
              ? "Saving…"
              : "Continue with Hussh Shared",
          onClick: () => void chooseShared(),
          disabled: sharedSaving || sharedChosen,
          testId: sharedConfirmed ? "cloud-tier-shared-continue" : "cloud-tier-shared",
        }
      : selectedHosting === "hosted" && !hostedUnderMaintenance
        ? {
            label: hostedSaving ? "Setting that up…" : "Set up Hussh Pods",
            onClick: () => void chooseHosted(),
            disabled: hostedSaving,
            testId: "cloud-tier-hosted-continue",
          }
        : null;

  const finish = useCallback(() => {
    const requested = requestInternalAppNavigation({
      href: ROUTES.ONE_SETUP,
      replace: true,
      scroll: false,
      source: "programmatic",
      transitionMode: "full",
    });
    if (!requested) router.replace(ROUTES.ONE_SETUP);
  }, [router]);

  return (
    <AppPageShell
      as="main"
      width="reading"
      nativeTest={{
        routeId: "/one/setup/cloud",
        marker: "native-route-one-setup-cloud",
        authState: "authenticated",
        dataState: saving ? "loading" : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Where your agent lives"
          description="Choose where your private agent runs. Your existing setup stays in place."
          accent="neutral"
        />
        {checkTimedOut && !authorized ? (
          <p
            className="text-sm text-[var(--app-text-secondary)]"
            data-testid="byoc-cloud-check-timed-out"
            aria-live="polite"
          >
            We couldn&rsquo;t confirm your agent home. Your existing setup is unchanged;
            refresh to check before choosing a hosting option.
          </p>
        ) : null}
      </AppPageHeaderRegion>
      <AppPageContentRegion className="space-y-6">
        {reservedProjectId && job && job.projectId !== reservedProjectId ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-reserved-project-mismatch"
            role="alert"
          >
            <p className="text-sm font-semibold">Your cloud setup needs a fresh check</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              The saved project and setup record do not match. Refresh before continuing.
            </p>
            <button
              type="button"
              className="min-h-11 self-start text-sm underline underline-offset-4"
              onClick={() => window.location.reload()}
            >
              Refresh status
            </button>
          </div>
        ) : job && job.status === "running" && !job.stale ? (
          // The live checklist owns the screen while the job runs. Nothing
          // else competes with it: no form, no dead buttons, no guessing.
          <SetupStageChecklist {...setupChecklistFor(job, ownerProvider)} job={job} />
        ) : job && (job.status === "failed" || job.stale) && !authorized ? (
          <ByocSetupFailedCard
            job={job}
            retry={setupRetryFor(job, ownerProvider)}
            busy={saving || azureSignIn.starting}
            onRetry={(retry) =>
              void (retry.provider === "azure"
                ? startAzureSetup(azureSubscriptionFromRef(job.projectId))
                : handleProjectNamed(retry.projectId))
            }
          />
        ) : (!checked || !hostingStatusChecked) && !checkTimedOut && !authorized ? (
          <p
            className="text-sm text-[var(--app-text-secondary)]"
            data-testid="byoc-cloud-checking"
            aria-live="polite"
          >
            Checking your agent home…
          </p>
        ) : connectedBefore ? (
          // The revisit state: their cloud is already recorded and proven.
          // An assigned pod cannot be moved by repeating first-time setup.
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-cloud-connected"
          >
            <p className="text-sm font-semibold">
              Connected: {existing.projectId}
            </p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              {existing.rationale || "Your private agent remains assigned to this project."}
            </p>
          </div>
        ) : recordedReservedProject ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-reserved-project-recorded"
          >
            <p className="text-sm font-semibold">Your cloud is connected</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              {reservedProjectId} is ready. Finish model setup to start your private agent.
            </p>
          </div>
        ) : reservedProjectId && setupStatusReadOk && job === null ? (
          <div
            className="space-y-3 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-reserved-project"
          >
            <p className="text-sm font-semibold">Your cloud project is saved</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              Finish setup in {reservedProjectId} to start your private agent.
            </p>
            <button
              type="button"
              disabled={saving || azureSignIn.starting}
              className="min-h-11 rounded-full border border-[var(--app-border)] px-4 text-sm font-medium disabled:opacity-60"
              onClick={() =>
                void (ownerProvider === "azure"
                  ? startAzureSetup(azureSubscriptionFromRef(reservedProjectId))
                  : handleProjectNamed(reservedProjectId))
              }
              data-testid="byoc-reserved-project-deploy"
            >
              {saving ? "Starting…" : "Deploy to your cloud"}
            </button>
          </div>
        ) : reservedProjectId ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-reserved-project-unverified"
          >
            <p className="text-sm font-semibold">Your cloud setup could not be confirmed</p>
            <button
              type="button"
              className="min-h-11 self-start text-sm underline underline-offset-4"
              onClick={() => window.location.reload()}
            >
              Refresh status
            </button>
          </div>
        ) : hostingMode === "pending" ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="hosting-mode-pending"
            aria-live="polite"
          >
            <p className="text-sm font-semibold">Your pod setup is still in progress</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              Keep the current setup. We will show the available choice after its status is confirmed.
            </p>
          </div>
        ) : hostingMode === "hussh_pods" ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="hussh-pods-assigned"
          >
            <p className="text-sm font-semibold">Hussh Pods is assigned to your account</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              Your existing pod remains in place. New Hussh Pods assignments are currently paused.
            </p>
          </div>
        ) : hostingMode === "unknown" || hostingMode === null ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="hosting-mode-unknown"
            aria-live="polite"
          >
            <p className="text-sm font-semibold">We couldn&rsquo;t confirm your agent home</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              Your existing or in-progress setup is unchanged. Refresh to check its status before choosing a hosting option.
            </p>
            <button
              type="button"
              className="text-sm underline underline-offset-4"
              onClick={() => window.location.reload()}
              data-testid="hosting-mode-refresh"
            >
              Refresh status
            </button>
          </div>
        ) : hostedChosen ? (
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="hosted-cloud-chosen"
          >
            <p className="text-sm font-semibold">Hosted by Hussh</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              {hosted.assurance}
            </p>
            <button
              type="button"
              className="text-sm underline underline-offset-4"
              onClick={() => {
                setHosted(null);
                setChoice("own");
              }}
              data-testid="hosted-cloud-switch"
            >
              Use my own cloud instead
            </button>
          </div>
        ) : (
          // Offer a hosting choice only when the server confirms no pod is
          // assigned or being provisioned. Existing and in-progress placements
          // render above and are never switched by this selection UI. Picking a
          // card only moves the selection; what that pick needs next appears
          // below it, so nothing is committed by a tap or an arrow key alone.
          <div
            className="space-y-4"
            data-testid={sharedConfirmed ? "shared-hosting-selected" : "cloud-tier-choice"}
          >
            <HostingChoiceCards
              label="Where your agent runs"
              options={hostingOptions}
              value={selectedHosting}
              onChange={setChoice}
              busy={sharedSaving || hostedSaving}
            />
            {selectedHosting === "own" ? (
              <OwnerCloudProviderChoice
                onProjectNamed={handleProjectNamed}
                projectBusy={saving}
                onConnectAzure={startAzureSetup}
                azureBusy={azureSignIn.starting}
              />
            ) : hostingCommit ? (
              <Button
                type="button"
                className="w-full"
                onClick={hostingCommit.onClick}
                disabled={hostingCommit.disabled}
                data-testid={hostingCommit.testId}
              >
                {hostingCommit.label}
              </Button>
            ) : null}
          </div>
        )}

        {saving ? (
          <p
            className="text-sm text-[var(--app-text-secondary)]"
            data-testid="byoc-cloud-saving"
          >
            Checking whether we can reach that project…
          </p>
        ) : null}

        {shownError && !(job && job.status === "running" && !job.stale) ? (
          // A refusal must be impossible to miss and must name the next MOVE.
          // The plain one-line rendering read as body copy and the founder
          // scrolled past it (2026-08-21); this is the app's standing alert
          // shape (one-setup-hub's finalization alert), headline plus the
          // server's reason verbatim.
          <div
            role="alert"
            className="flex flex-col gap-1.5 rounded-[var(--app-card-radius-compact)] border border-destructive/30 bg-destructive/5 px-4 py-3"
            data-testid="byoc-cloud-error"
          >
            <p className="text-sm font-semibold text-destructive">
              Your cloud is not set up yet
            </p>
            <p className="text-sm text-destructive">{shownError}</p>
            {/phone/i.test(shownError) ? (
              <a
                className="self-start text-sm underline underline-offset-4 text-destructive"
                href={ROUTES.PHONE_MANDATE}
                data-testid="byoc-cloud-verify-phone"
              >
                Verify your phone number
              </a>
            ) : null}
          </div>
        ) : null}

        {azureSignIn.notice && !shownError && !(job && job.status === "running") ? (
          // Not a refusal: the person (or Microsoft's own page) closed the sign-in window.
          <p
            className="text-sm text-[var(--app-text-secondary)]"
            role="status"
            data-testid="azure-sign-in-notice"
          >
            {azureSignIn.notice}
          </p>
        ) : null}

        {authorized ? (
          <p
            className="text-sm text-[var(--app-success)]"
            data-testid="byoc-cloud-authorized"
          >
            Connected. Your private agent can be set up in your cloud.
          </p>
        ) : null}
      </AppPageContentRegion>
      <SetupCompletionFooter
        label="Finish cloud setup"
        onComplete={finish}
        busy={saving}
        // Gated on the PROVEN grant, not on the form. A person who advances here
        // without it reaches AI access, chooses a model, and their provisioning is
        // then refused for a reason they were never shown on this screen.
        disabled={!authorized || saving}
        controlId="one-setup-cloud-terminal"
        actionId="setup.finish_cloud"
        purpose="Record the person's own cloud and return to setup."
        // Only forward-looking copy earns a line here. The disabled reason is not
        // restated (Restraint Charter: cut copy that repeats a control's own state);
        // the authorize block above already says what is needed.
        supportingText={
          authorized
            ? "Your agent will be built in your own cloud."
            : undefined
        }
      />
    </AppPageShell>
  );
}

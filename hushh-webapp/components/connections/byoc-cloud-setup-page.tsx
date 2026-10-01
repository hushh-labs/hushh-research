"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { ByocCloudCard } from "@/components/connections/byoc-cloud-card";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { useAuth } from "@/lib/firebase/auth-context";
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
 * The owner signs in to Google once; the server creates or verifies the
 * project, proves authorization, and only then records the cloud assignment.
 */
/** The six stages, in the product order, with copy a person can trust. */
const SETUP_STAGES: Array<{ id: string; label: string }> = [
  { id: "creating_project", label: "Creating your project" },
  { id: "linking_billing", label: "Linking your billing" },
  { id: "enabling_apis", label: "Preparing cloud services" },
  { id: "applying_iam", label: "Configuring private access" },
  { id: "settling_grant", label: "Confirming cloud access" },
  { id: "proving", label: "Checking your private agent" },
];

function SetupStageChecklist({
  job,
}: {
  job: { stage: string; stages: Array<{ stage: string }>; projectId: string };
}) {
  const reached = new Set(job.stages.map((entry) => entry.stage));
  return (
    <div
      className="space-y-3 rounded-2xl border border-[var(--app-border)] p-4"
      data-testid="byoc-setup-progress"
      aria-live="polite"
    >
      <p className="text-sm font-semibold">Setting up {job.projectId}</p>
      <ul className="space-y-1.5">
        {SETUP_STAGES.map((stage) => {
          const isCurrent = job.stage === stage.id;
          const isDone = reached.has(stage.id) && !isCurrent;
          return (
            <li key={stage.id} className="flex items-center gap-2 text-sm">
              <span aria-hidden className="w-4 text-center">
                {isDone ? "✓" : isCurrent ? "•" : ""}
              </span>
              <span
                className={
                  isDone
                    ? "text-[var(--app-text-secondary)]"
                    : isCurrent
                      ? "font-medium"
                      : "text-[var(--app-text-secondary)] opacity-60"
                }
              >
                {stage.label}
                {isCurrent ? "…" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-[var(--app-text-secondary)]">
        This runs on its own. You can go back to Setup and continue the other
        steps; this page and the setup list will show when your cloud is ready.
      </p>
    </div>
  );
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
  // Which alternative this person is taking from a confirmed Shared state.
  const [choice, setChoice] = useState<"own" | "hosted" | null>(null);
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
  // The live stage record of the background setup job. Fetched on mount (a
  // person can leave and come back mid-job) and polled every 2s while running.
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
        setHostingMode(mode);
        setHostingStatusChecked(true);
        const unassignedByoc =
          (mode === "pending" || mode === "byoc") &&
          status.state === "reserved" &&
          status.deploymentTarget === "user_gcp" &&
          Boolean(status.cloudProject);
        setReservedProjectId(
          unassignedByoc ? status.cloudProject ?? null : null,
        );
        if (mode === "byoc" && status.cloudProject && !unassignedByoc) {
          setExisting({
            projectId: status.cloudProject,
            rationale: "Your BYOC pod assignment is still active.",
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
  }, [user?.uid]);

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
        if (status.status === "recorded") {
          if (hostingMode === "byoc") {
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
  }, [user?.uid, hostingMode]);

  useEffect(() => {
    if (!user?.uid || hostingMode !== "byoc") return;
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
  }, [user?.uid, hostingMode]);

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
          <SetupStageChecklist job={job} />
        ) : job && (job.status === "failed" || job.stale) && !authorized ? (
          <div
            role="alert"
            className="flex flex-col gap-1.5 rounded-[var(--app-card-radius-compact)] border border-destructive/30 bg-destructive/5 px-4 py-3"
            data-testid="byoc-setup-failed"
          >
            <p className="text-sm font-semibold text-destructive">
              Your cloud is not set up yet
            </p>
            <p className="text-sm text-destructive">
              {job.stale
                ? "The setup stopped partway (our side restarted). Everything already done is kept."
                : job.errorMessage || "The setup could not finish."}
            </p>
            {job.errorCode === "NEEDS_BILLING" ? (
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                <a href="https://console.cloud.google.com/billing" target="_blank" rel="noreferrer"
                  className="underline underline-offset-4" data-testid="byoc-open-billing">
                  Set up Google Cloud billing
                </a>
                <a href="https://console.cloud.google.com/billing/projects" target="_blank" rel="noreferrer"
                  className="underline underline-offset-4" data-testid="byoc-link-project-billing">
                  Link billing to this project
                </a>
                <p className="w-full text-muted-foreground">Return here after billing is active. Your project is preserved.</p>
              </div>
            ) : null}
            <button
              type="button"
              disabled={saving}
              className="min-h-11 self-start text-sm underline underline-offset-4 text-destructive disabled:opacity-50"
              onClick={() => void handleProjectNamed(job.projectId)}
              data-testid="byoc-setup-retry"
            >
              Deploy to your cloud
            </button>
          </div>
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
              disabled={saving}
              className="min-h-11 rounded-full border border-[var(--app-border)] px-4 text-sm font-medium disabled:opacity-60"
              onClick={() => void handleProjectNamed(reservedProjectId)}
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
            <p className="text-sm font-semibold">Hosted by hussh</p>
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
        ) : choice === "own" ? (
          <div className="space-y-4">
            <ByocCloudCard busy={saving} onProjectNamed={handleProjectNamed} />
          </div>
        ) : hostingMode === "shared" || sharedChosen ? (
          <div className="space-y-3" data-testid="shared-hosting-selected">
            <div className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4">
              <p className="text-sm font-semibold">Hussh Shared</p>
              <p className="text-sm text-[var(--app-text-secondary)]">
                Shared uses Hussh&rsquo;s shared runtime without a dedicated pod. Your vault stays owner-scoped, and One uses only the context permitted for the session. A private agent in a personal pod requires BYOC or an available Hussh Pods assignment.
              </p>
              <button
                type="button"
                className="rounded-full border border-[var(--app-border)] px-3 py-1.5 text-sm disabled:opacity-60"
                onClick={() => void chooseShared()}
                disabled={sharedSaving || sharedChosen}
                data-testid="cloud-tier-shared-continue"
              >
                {sharedChosen ? "Hussh Shared selected" : sharedSaving ? "Saving…" : "Continue with Hussh Shared"}
              </button>
            </div>
            <button
              type="button"
              className="w-full space-y-1 rounded-2xl border border-[var(--app-border)] p-4 text-left"
              onClick={() => setChoice("own")}
              data-testid="cloud-tier-own"
            >
              <p className="text-sm font-semibold">BYOC — your own Google Cloud</p>
              <p className="text-sm text-[var(--app-text-secondary)]">
                Your project, compute, and bill. The private agent runs in your cloud.
              </p>
            </button>
            <button
              type="button"
              className="w-full space-y-1 rounded-2xl border border-[var(--app-border)] p-4 text-left disabled:opacity-60"
              onClick={() => void chooseHosted()}
              disabled={hostedSaving || hostedUnderMaintenance}
              aria-disabled={hostedUnderMaintenance || undefined}
              data-testid="cloud-tier-hosted"
            >
              <p className="text-sm font-semibold">
                {hostedSaving ? "Setting that up…" : hostedUnderMaintenance ? "Hussh Pods · unavailable" : "Hussh Pods"}
              </p>
              <p className="text-sm text-[var(--app-text-secondary)]">
                A dedicated pod on Hussh infrastructure. New assignments are paused while this option is under maintenance.
              </p>
            </button>
          </div>
        ) : (
          // Offer a hosting choice only when the server confirms no pod is
          // assigned or being provisioned. Existing and in-progress placements
          // render above and are never switched by this selection UI.
          <div className="space-y-3" data-testid="cloud-tier-choice">
            <button
              type="button"
              className="w-full space-y-1 rounded-2xl border border-[var(--app-border)] p-4 text-left"
              onClick={() => void chooseShared()}
              disabled={sharedSaving}
              data-testid="cloud-tier-shared"
            >
              <p className="text-sm font-semibold">
                {sharedSaving ? "Saving…" : "Hussh Shared · default without a pod"}
              </p>
              <p className="text-sm text-[var(--app-text-secondary)]">
                Use Hussh&rsquo;s shared runtime without a dedicated pod. Your vault stays owner-scoped, and One uses only the context permitted for the session. A private agent in a personal pod requires BYOC or an available Hussh Pods assignment.
              </p>
            </button>
            <button
              type="button"
              className="w-full space-y-1 rounded-2xl border border-[var(--app-border)] p-4 text-left"
              onClick={() => setChoice("own")}
              data-testid="cloud-tier-own"
            >
              <p className="text-sm font-semibold">BYOC — your own Google Cloud</p>
              <p className="text-sm text-[var(--app-text-secondary)]">
                Your Google Cloud project hosts the pod and pays its usage. Hussh uses the authorization you grant to provision it.
              </p>
            </button>
            <button
              type="button"
              className="w-full space-y-1 rounded-2xl border border-[var(--app-border)] p-4 text-left disabled:opacity-60"
              onClick={() => void chooseHosted()}
              disabled={hostedSaving || hostedUnderMaintenance}
              aria-disabled={hostedUnderMaintenance || undefined}
              data-testid="cloud-tier-hosted"
              data-maintenance={hostedUnderMaintenance ? "true" : undefined}
            >
              <p className="text-sm font-semibold">
                {hostedSaving
                  ? "Setting that up…"
                  : hostedUnderMaintenance
                    ? "Hussh Pods · unavailable"
                    : "Hussh Pods"}
              </p>
              <p className="text-sm text-[var(--app-text-secondary)]">
                {hostedUnderMaintenance
                  ? "New Hussh Pods assignments are paused while this option is under maintenance. Existing pod assignments stay in place."
                  : "A dedicated pod on Hussh-operated infrastructure."}
              </p>
            </button>
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

        {error && !(job && job.status === "running" && !job.stale) ? (
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
            <p className="text-sm text-destructive">{error}</p>
            {/phone/i.test(error) ? (
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
            ? "Your agent will be built in your own project."
            : undefined
        }
      />
    </AppPageShell>
  );
}

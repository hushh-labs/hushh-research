"use client";

import { useCallback, useEffect, useState } from "react";
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
 * This is the first root-setup step, before AI access, because the order is the
 * product: once someone's own project exists, their own project's Vertex ADC serves
 * their agent, and supplying an AI key becomes the exception rather than the front
 * door. Asking for a key first taught people the opposite.
 *
 * `ByocCloudCard` was written, finished and never mounted anywhere. This page is the
 * mount, and the only thing it adds is the half the card could not have: naming a
 * project has to be RECORDED and the grant has to be PROVEN, and both of those are
 * server work.
 *
 * WHY "not authorized yet" IS NOT AN ERROR HERE
 *
 * A person cannot authorize hushh before hushh tells them which identity to authorize,
 * and that value (`hushhCaller`) comes back from the save call itself. So the expected
 * sequence is: name the project, get told no along with the exact command, run it,
 * continue. Treating the first answer as a failure would make the normal path look
 * broken.
 */
/** The six stages, in the product order, with copy a person can trust. */
const SETUP_STAGES: Array<{ id: string; label: string }> = [
  { id: "creating_project", label: "Creating your project" },
  { id: "linking_billing", label: "Linking your billing" },
  { id: "enabling_apis", label: "Enabling Google APIs" },
  { id: "applying_iam", label: "Granting the one permission" },
  { id: "settling_grant", label: "Waiting for Google to settle it" },
  { id: "proving", label: "Proving we can act in your cloud" },
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

export function ByocCloudSetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Awaited<
    ReturnType<typeof ApiService.saveByocProject>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The already-connected state, resolved on mount. This page used to hold all
  // connection truth in per-session state, so a person whose cloud was fully
  // recorded came back to a blank form with a dead Finish button (audit
  // finding, 2026-08-21). The durable "cloud" marker only exists after a
  // PROVEN save, so marker + saved name is enough to render the truth.
  const [existing, setExisting] = useState<{
    projectId: string;
    rationale: string;
  } | null>(null);
  const [switching, setSwitching] = useState(false);
  // Which door this person is taking. Null means they have not chosen, which is
  // a real third state and not the same as having chosen their own cloud — the
  // page used to assume BYOC by construction, so someone who arrived with a
  // Google account and nothing else had no way through this step at all.
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
        if (status.status === "recorded") {
          // The durable marker just landed server-side; refresh the shared
          // bootstrap so this page, the hub, and every other surface flip to
          // the truth without a reload.
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
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid) return;
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
  }, [user?.uid]);

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
    setSaving(true);
    setError(null);
    try {
      // THE DEFAULT IS ONE CLICK (founder-directed): sign in to Google once and
      // the server creates the project if needed, links the person's own
      // billing, applies the authorization plan under their transient token,
      // and records the proven cloud. The manual console/script route stays
      // reachable through the card's create-help, as the fallback.
      const begun = await ApiService.beginByocAuthorize({ projectId });
      window.location.assign(begun.authUrl);
      return;
    } catch (err) {
      // A deployment without Google sign-in configured falls back to the
      // manual route: record the name, show the script, prove on re-save.
      // The fallback is a lane, not an error.
      const message = err instanceof Error ? err.message : "";
      if (
        message === "BYOC_AUTHORIZE_BEGIN_FAILED" ||
        /not configured/i.test(message)
      ) {
        try {
          setSaved(await ApiService.saveByocProject({ projectId }));
          return;
        } catch (fallbackErr) {
          err = fallbackErr;
        }
      }
      // The project is not recorded, so the step is genuinely incomplete. Say that
      // rather than advancing: a false "done" here surfaces much later, in their own
      // cloud, as a provisioning failure with nothing naming the cause. When the
      // server sent a real reason (the 409 "verify your phone first" is a normal
      // step of this journey, not a fault), show that reason verbatim — one status
      // line, the actual next action (Restraint Charter: earn every element).
      const serverReason =
        err instanceof Error &&
        err.message &&
        err.message !== "BYOC_SAVE_FAILED"
          ? err.message
          : null;
      setError(
        serverReason ??
          "We could not save your cloud just now. Try again in a moment.",
      );
    } finally {
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

  // A cloud is "done" here either because THIS session just proved it, or
  // because the durable marker says a prior session did, or because the person
  // chose to have hussh host it (which needs no proof — there is nothing to
  // authorize). All three are settled states; the footer treats them the same.
  const connectedNow = saved?.authorized === true;
  const connectedBefore = existing !== null && !switching;
  const hostedChosen = hosted !== null;
  const authorized = connectedNow || connectedBefore || hostedChosen;

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
          description="Your own Google Cloud project, or hosted by hussh. Either way it is your agent, and you can move it later."
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion className="space-y-6">
        {job && job.status === "running" && !job.stale ? (
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
            <button
              type="button"
              className="self-start text-sm underline underline-offset-4 text-destructive"
              onClick={() => void handleProjectNamed(job.projectId)}
              data-testid="byoc-setup-retry"
            >
              Try again
            </button>
          </div>
        ) : !checked && !authorized ? (
          <p
            className="text-sm text-[var(--app-text-secondary)]"
            data-testid="byoc-cloud-checking"
            aria-live="polite"
          >
            Checking your cloud…
          </p>
        ) : connectedBefore && !connectedNow ? (
          // The revisit state: their cloud is already recorded and proven.
          // Showing the naming form here read as "nothing ever happened"
          // (audit finding, 2026-08-21); the truth is a connected cloud with
          // one quiet way out for the person who genuinely wants to switch.
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-cloud-connected"
          >
            <p className="text-sm font-semibold">
              Connected: {existing.projectId}
            </p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              {existing.rationale ||
                "Your saved cloud. Change it only to switch projects."}
            </p>
            <button
              type="button"
              className="text-sm underline underline-offset-4"
              onClick={() => setSwitching(true)}
              data-testid="byoc-cloud-switch"
            >
              Switch project
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
          <ByocCloudCard onProjectNamed={handleProjectNamed} />
        ) : (
          // The choice, and the reason this page stopped assuming one. Both
          // doors write the same durable marker, so neither is a lesser path
          // through setup — the difference is who owns the compute, and it is
          // reversible in one click either way.
          <div className="space-y-3" data-testid="cloud-tier-choice">
            <button
              type="button"
              className="w-full space-y-1 rounded-2xl border border-[var(--app-border)] p-4 text-left"
              onClick={() => setChoice("own")}
              data-testid="cloud-tier-own"
            >
              <p className="text-sm font-semibold">Your own Google Cloud</p>
              <p className="text-sm text-[var(--app-text-secondary)]">
                Your project, your compute, your bill. hussh cannot read your
                agent, because the keys never leave it and the project is not
                ours.
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
                    ? "Host it with hussh · under maintenance"
                    : "Host it with hussh"}
              </p>
              <p className="text-sm text-[var(--app-text-secondary)]">
                {hostedUnderMaintenance
                  ? "Hosted pods are being worked on right now and cannot be chosen. Use your own Google Cloud today; this door reopens on its own, and you can move between the two later."
                  : "Your own instance on hussh\u2019s infrastructure, sealed with keys only your agent holds. hussh does not read it, and you can move it to your own cloud any time, with everything it has learned."}
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

        {saved && !authorized ? (
          // The grant step. `hushhCaller` appeared nowhere a person could see it
          // before this, which made the documented journey impossible to complete.
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-cloud-authorize"
          >
            <p className="text-sm font-semibold">
              One more step, in your own cloud
            </p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              Run this in your project to let us build your agent there. It
              grants one role, to one account, and you can withdraw it with a
              single command.
            </p>
            <pre className="overflow-x-auto rounded-xl bg-[var(--app-surface-sunk)] p-3 text-xs">
              {`PROJECT_ID=${saved.projectId} \\
HUSHH_CALLER=${saved.hushhCaller} \\
  bash deploy/iam/authorize_byoc_project.sh`}
            </pre>
            <p className="text-xs text-[var(--app-text-secondary)]">
              Then come back and confirm your project again. Nothing is created
              until we can prove we can reach it.
            </p>
          </div>
        ) : null}

        {authorized ? (
          <p
            className="text-sm text-[var(--app-success)]"
            data-testid="byoc-cloud-authorized"
          >
            Connected. {saved?.nextStep}
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

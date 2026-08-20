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
import { ApiService } from "@/lib/services/api-service";
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
export function ByocCloudSetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Awaited<
    ReturnType<typeof ApiService.saveByocProject>
  > | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePublishVoiceSurfaceMetadata({ screenId: "one_setup_cloud" });

  // The OAuth return route lands back here with the server's refusal when the
  // one-click flow could not finish (no billing account, name taken, ...).
  // Surfacing it verbatim is the whole point: it names the person's next move.
  useEffect(() => {
    const reason = searchParams.get("authorize_error");
    if (reason) setError(reason);
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
      if (message === "BYOC_AUTHORIZE_BEGIN_FAILED" || /not configured/i.test(message)) {
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
        err instanceof Error && err.message && err.message !== "BYOC_SAVE_FAILED"
          ? err.message
          : null;
      setError(
        serverReason ?? "We could not save your cloud just now. Try again in a moment.",
      );
    } finally {
      setSaving(false);
    }
  }, []);

  const authorized = saved?.authorized === true;

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
          title="Your cloud"
          description="Your private agent runs in your own Google Cloud project. Your compute, your bill, your data."
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion className="space-y-6">
        <ByocCloudCard onProjectNamed={handleProjectNamed} />

        {saving ? (
          <p
            className="text-sm text-[var(--app-text-secondary)]"
            data-testid="byoc-cloud-saving"
          >
            Checking whether we can reach that project…
          </p>
        ) : null}

        {error ? (
          <p className="text-sm text-[var(--app-danger)]" data-testid="byoc-cloud-error">
            {error}
          </p>
        ) : null}

        {saved && !authorized ? (
          // The grant step. `hushhCaller` appeared nowhere a person could see it
          // before this, which made the documented journey impossible to complete.
          <div
            className="space-y-2 rounded-2xl border border-[var(--app-border)] p-4"
            data-testid="byoc-cloud-authorize"
          >
            <p className="text-sm font-semibold">One more step, in your own cloud</p>
            <p className="text-sm text-[var(--app-text-secondary)]">
              Run this in your project to let us build your agent there. It grants one
              role, to one account, and you can withdraw it with a single command.
            </p>
            <pre className="overflow-x-auto rounded-xl bg-[var(--app-surface-sunk)] p-3 text-xs">
              {`PROJECT_ID=${saved.projectId} \\
HUSHH_CALLER=${saved.hushhCaller} \\
  bash deploy/iam/authorize_byoc_project.sh`}
            </pre>
            <p className="text-xs text-[var(--app-text-secondary)]">
              Then come back and confirm your project again. Nothing is created until
              we can prove we can reach it.
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
          authorized ? "Your agent will be built in your own project." : undefined
        }
      />
    </AppPageShell>
  );
}

"use client";

/**
 * "Run your agent in your own cloud" — naming, and creating, a person's GCP project.
 *
 * WHY THIS IS ITS OWN CARD AND NOT A THIRD OPTION IN THE RUNTIME CARD
 * -------------------------------------------------------------------
 * `RuntimeCredentialMode` answers *how the model is reached* — a managed Vertex
 * connection or the person's own key. Where the agent RUNS is a different question with
 * a different answer, and a person who runs their agent in their own cloud still picks
 * one of those two. Folding "own cloud" in as a third credential mode would conflate
 * them and would change a value already persisted in people's vaults.
 *
 * The backend draws the same line: `model_access_policy` decides on (backend, provider),
 * two axes, not one.
 *
 * WHAT THIS CARD PROMISES, AND WHAT IT DOES NOT
 * ----------------------------------------------
 * Naming a project provisions nothing. A pod is still earned by a working AI
 * connection, never by a form — so nothing here touches the provisioning gate. The card
 * gets a person as far as "a project exists that you own", and the bootstrap takes it
 * from there.
 *
 * Creation has two routes. The DEFAULT is one Google sign-in (founder-directed):
 * the person approves once and the server creates the project if needed, links
 * their own billing, and applies the authorization plan under their transient,
 * never-stored token. The manual road — console link + copy-paste command —
 * stays folded behind "Create it manually instead", as the fallback.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiService } from "@/lib/services/api-service";

type ByocCloudCardProps = {
  /** Called once a project name is settled, so the caller can continue the journey. */
  onProjectNamed?: (projectId: string) => void | Promise<void>;
  testId?: string;
};

type Availability = boolean | null;

export function ByocCloudCard({ onProjectNamed, testId }: ByocCloudCardProps) {
  const [projectId, setProjectId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [valid, setValid] = useState(true);
  const [available, setAvailable] = useState<Availability>(null);
  const [reason, setReason] = useState("");
  const [checking, setChecking] = useState(false);
  const [plan, setPlan] = useState<Awaited<
    ReturnType<typeof ApiService.planByocProject>
  > | null>(null);

  // The suggestion is fetched once and pre-filled. It is stable per person, so a
  // reload does not rename the cloud someone was halfway through accepting.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const suggestion = await ApiService.suggestByocProject();
        if (cancelled) return;
        setProjectId(suggestion.projectId);
        setDisplayName(suggestion.displayName);
      } catch {
        // A missing suggestion must not block the field. Someone who already has a
        // project just types its name, which is the common case anyway.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced, because this hits the network and the field is typed into.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const verdict = await ApiService.checkByocProject(projectId);
          if (cancelled) return;
          setValid(verdict.valid);
          setAvailable(verdict.available);
          setReason(verdict.reason);
        } catch {
          // An unreachable probe is not a verdict about the name.
          if (!cancelled) setAvailable(null);
        } finally {
          if (!cancelled) setChecking(false);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setChecking(false);
    };
  }, [projectId]);

  const status = useMemo(() => {
    if (checking) return { label: "Checking…", tone: "muted" as const };
    if (!valid) return { label: reason, tone: "error" as const };
    // `null` is NOT "taken". Saying so would send people off to rename a free project.
    if (available === null)
      return { label: reason || "We will confirm this when it is created.", tone: "muted" as const };
    if (available) return { label: "That name is free.", tone: "ok" as const };
    return { label: "That name is already taken. Try another.", tone: "error" as const };
  }, [checking, valid, available, reason]);

  const showCreationRoutes = useCallback(async () => {
    try {
      const next = await ApiService.planByocProject({ projectId, displayName });
      setPlan(next);
    } catch {
      setPlan(null);
    }
  }, [projectId, displayName]);

  const canContinue = valid && available !== false && projectId.length > 0;

  return (
    // No title here on purpose: the page header already says "Your cloud". A single
    // card must not restate the screen's heading (Restraint Charter: one title per
    // screen). This renders the grouped-card shell only.
    <SettingsGroup testId={testId ?? "connections-byoc-cloud"}>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="byoc-project-id">
            Name your cloud
          </label>
          <Input
            id="byoc-project-id"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value.trim())}
            aria-invalid={!valid}
            aria-describedby="byoc-project-status"
            data-testid="byoc-project-id-input"
            spellCheck={false}
            autoComplete="off"
          />
          <p
            id="byoc-project-status"
            data-testid="byoc-project-status"
            className={
              status.tone === "error"
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {status.label}
          </p>
        </div>

        {/* One primary action, and it carries the promise: Continue signs the
            person in to Google once and everything else happens for them. */}
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            disabled={!canContinue}
            onClick={() => void onProjectNamed?.(projectId)}
            data-testid="byoc-project-continue"
          >
            Continue
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Sign in to Google once — we create the project if needed, link your
            billing, and set it up. Nothing is stored.
          </p>
        </div>

        {/* The MANUAL road, named as such (founder-directed), folded shut by
            default. Native details so the open state is the browser's, not ours. */}
        <details
          className="rounded-xl border border-border/60"
          data-testid="byoc-project-help"
          onToggle={(event) => {
            if ((event.target as HTMLDetailsElement).open && !plan) {
              void showCreationRoutes();
            }
          }}
        >
          <summary className="cursor-pointer select-none p-3 text-sm text-muted-foreground">
            Create it manually instead
          </summary>
          <div className="flex flex-col gap-2 px-3 pb-3">
            {plan ? (
              <>
                <a
                  className="text-sm underline underline-offset-4"
                  href={plan.guided.consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="byoc-console-link"
                >
                  Open Google Cloud and create it
                </a>
                <code className="overflow-x-auto rounded bg-muted p-2 text-xs">
                  {plan.guided.cliCommand}
                </code>
                <p className="text-xs text-muted-foreground">
                  {plan.guided.billingNote} Then come back and press Continue.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Preparing the steps…</p>
            )}
          </div>
        </details>
      </div>
    </SettingsGroup>
  );
}

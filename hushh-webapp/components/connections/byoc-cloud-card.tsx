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
 * Creation has two routes and the default is the one where hushh holds no permission
 * over the person's cloud: we suggest the name and hand them a console link. Letting
 * hushh create it instead needs an organization-level grant, which is categorically
 * larger than anything else in this flow — so it is offered with its cost stated, next
 * to the alternative that avoids it, rather than as the obvious button.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
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
  const [rationale, setRationale] = useState("");
  const [valid, setValid] = useState(true);
  const [available, setAvailable] = useState<Availability>(null);
  const [reason, setReason] = useState("");
  const [checking, setChecking] = useState(false);
  const [plan, setPlan] = useState<Awaited<
    ReturnType<typeof ApiService.planByocProject>
  > | null>(null);
  const [expanded, setExpanded] = useState(false);

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
        setRationale(suggestion.rationale);
      } catch {
        // A missing suggestion must not block the field. Someone who already has a
        // project can type its name, which is the common case anyway.
        if (!cancelled) setRationale("Type the name of the project you want to use.");
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
      setExpanded(true);
    } catch {
      setPlan(null);
    }
  }, [projectId, displayName]);

  const canContinue = valid && available !== false && projectId.length > 0;

  return (
    <SettingsGroup
      title="Run your agent in your own cloud"
      description="Your compute, your storage, your bill. Hushh never holds a key to it."
      testId={testId ?? "connections-byoc-cloud"}
    >
      <div className="flex flex-col gap-3 p-4">
        {canContinue ? (
          <div>
            <Badge variant="secondary">Ready</Badge>
          </div>
        ) : null}
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
              : status.tone === "ok"
                ? "text-sm text-muted-foreground"
                : "text-sm text-muted-foreground"
          }
        >
          {status.label}
        </p>
        {rationale ? (
          <p className="text-xs text-muted-foreground">{rationale}</p>
        ) : null}

        {!expanded ? (
          <Button
            type="button"
            variant="secondary"
            disabled={!canContinue}
            onClick={() => void showCreationRoutes()}
            data-testid="byoc-project-continue"
          >
            I need to create this project
          </Button>
        ) : null}

        {expanded && plan ? (
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <div>
              <p className="text-sm font-medium">Create it yourself — recommended</p>
              <p className="text-xs text-muted-foreground">
                It is yours from the moment it exists, and hushh holds nothing over it.{" "}
                {plan.guided.whatHushhGets}
              </p>
              <div className="mt-2 flex flex-col gap-2">
                <a
                  className="text-sm underline"
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
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {plan.guided.billingNote}
              </p>
            </div>

            {/* The larger permission, shown next to the alternative rather than
                instead of it. `meaning` says it is not scoped to this one project. */}
            {plan.delegated?.grant ? (
              <details data-testid="byoc-delegated-disclosure">
                <summary className="cursor-pointer text-sm">
                  Or let hushh create it for you
                </summary>
                <p className="mt-2 text-xs text-muted-foreground">
                  {plan.delegated.meaning}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {plan.delegated.why_this_is_larger}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {plan.delegated.revocation}
                </p>
              </details>
            ) : (
              <p className="text-xs text-muted-foreground">
                {plan.delegated?.unavailable}
              </p>
            )}

            <Button
              type="button"
              onClick={() => void onProjectNamed?.(projectId)}
              data-testid="byoc-project-done"
            >
              I have created it — continue
            </Button>
          </div>
        ) : null}

        {!expanded ? (
          <Button
            type="button"
            variant="ghost"
            disabled={!canContinue}
            onClick={() => void onProjectNamed?.(projectId)}
            data-testid="byoc-project-existing"
          >
            I already have this project — continue
          </Button>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

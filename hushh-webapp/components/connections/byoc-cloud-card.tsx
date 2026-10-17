"use client";

import { useEffect, useState } from "react";

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiService } from "@/lib/services/api-service";

type ByocCloudCardProps = {
  onProjectNamed?: (projectId: string) => void | Promise<void>;
  busy?: boolean;
  testId?: string;
};

/** The owner authorizes a project; the server proves ownership before publishing it. */
export function ByocCloudCard({ onProjectNamed, busy = false, testId }: ByocCloudCardProps) {
  const [suggestedId, setSuggestedId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [suggestionError, setSuggestionError] = useState(false);
  const [filesAvailable, setFilesAvailable] = useState<boolean | null>(null);
  const [valid, setValid] = useState(true);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ApiService.suggestByocProject().then((suggestion) => {
      if (cancelled) return;
      setSuggestedId(suggestion.projectId);
      setProjectId(suggestion.projectId);
      setFilesAvailable(suggestion.filesAvailable === true);
      setSuggestionError(false);
    }).catch(() => {
      if (!cancelled) setSuggestionError(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!advanced || !projectId) return;
    let cancelled = false;
    setChecking(true);
    const timer = setTimeout(() => {
      void ApiService.checkByocProject(projectId).then((result) => {
        if (!cancelled) setValid(result.valid);
      }).catch(() => {
        // A failed name probe does not establish that the owner's project is invalid.
        if (!cancelled) setValid(true);
      }).finally(() => {
        if (!cancelled) setChecking(false);
      });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [advanced, projectId]);

  return (
    <SettingsGroup testId={testId ?? "connections-byoc-cloud"}>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          Sign in to Google to set up your private agent. Your cloud pays for its usage.
        </p>
        {advanced ? (
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="byoc-project-id">Your project ID</label>
            <Input
              id="byoc-project-id"
              value={projectId}
              onChange={(event) => { setProjectId(event.target.value.trim()); setValid(true); }}
              aria-invalid={!valid}
              aria-describedby="byoc-project-status"
              data-testid="byoc-project-id-input"
              spellCheck={false}
              autoComplete="off"
            />
            <p id="byoc-project-status" className="text-xs text-muted-foreground">
              {checking ? "Checking project ID…" : valid
                ? "Google will confirm that you can use this project."
                : "Enter a valid Google Cloud project ID."}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            {loading ? "Preparing your cloud project…" : suggestionError
              ? "We couldn’t suggest a project. Choose an existing project below."
              : `Project: ${suggestedId}`}
          </p>
        )}
        {filesAvailable === false ? (
          <p className="text-xs text-muted-foreground">
            Private Files is not available for new cloud setups here yet. Your agent can still be deployed.
          </p>
        ) : null}
        <Button
          type="button"
          disabled={busy || !projectId || loading || checking || !valid}
          onClick={() => void onProjectNamed?.(projectId)}
          data-testid="byoc-project-continue"
        >
          Deploy to your cloud
        </Button>
        <button
          type="button"
          className="min-h-11 self-start text-sm text-muted-foreground underline underline-offset-4"
          onClick={() => {
            setAdvanced(!advanced);
            setProjectId(advanced ? suggestedId : projectId);
            setValid(true);
          }}
          data-testid="byoc-project-help"
        >
          {advanced ? "Use suggested project" : "Use an existing project"}
        </button>
      </div>
    </SettingsGroup>
  );
}

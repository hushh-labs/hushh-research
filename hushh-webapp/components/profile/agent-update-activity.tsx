"use client";

import { AgentUpdateProgress } from "@/components/agent/agent-update-progress";
import { AzureUpdateSignInPrompt } from "@/components/profile/azure-update-sign-in-prompt";
import type { AgentUpdateStatus } from "@/lib/feed/agent-update-status";
import { Button } from "@/lib/morphy-ux/morphy";
import { UPDATE_POPUP_CLOSED_NOTICE } from "@/lib/one/azure-sign-in";
import { AZURE_UPDATE_COPY, azureUpdatedLabel } from "@/lib/one/azure-update-outcome";
import type { AzureUpdateProgressState } from "@/lib/one/use-azure-update-progress";

/**
 * The software update's live state inside the profile pane.
 *
 * An Azure update approved here signs in to Microsoft in a popup and is then
 * followed right here, through to "Updated" or a failure with a retry, so the
 * person never lands on a different route (founder, 2026-10-05: "I felt within
 * the profile pane"). With nothing being followed, the pane shows what it
 * always did: the resume prompt for an approval waiting on Microsoft, or the
 * hub's milestone bar.
 */
export function AgentUpdateActivity({
  update,
  awaitingMicrosoft,
  follow,
}: {
  update: AgentUpdateStatus;
  awaitingMicrosoft: boolean;
  follow: AzureUpdateProgressState;
}) {
  const { progress } = follow;
  if (progress.kind === "idle") {
    return awaitingMicrosoft ? <AzureUpdateSignInPrompt /> : <AgentUpdateProgress update={update} />;
  }
  if (progress.kind === "signing_in") {
    return (
      <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="azure-update-signing-in">
        {AZURE_UPDATE_COPY.signingIn}
      </p>
    );
  }
  if (progress.kind === "closed") {
    return (
      <div className="space-y-3" data-testid="azure-update-closed">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {UPDATE_POPUP_CLOSED_NOTICE}
        </p>
        {awaitingMicrosoft ? <AzureUpdateSignInPrompt /> : null}
      </div>
    );
  }
  if (progress.kind === "updated") {
    return (
      <p className="text-sm font-medium" aria-live="polite" data-testid="azure-update-updated">
        {azureUpdatedLabel(progress.version, progress.releasedAt)}
      </p>
    );
  }
  if (progress.kind === "failed") return <UpdateFailed message={progress.message} follow={follow} />;
  if (progress.kind === "unconfirmed") {
    return (
      <p className="text-sm text-muted-foreground" data-testid="azure-update-unconfirmed">
        {AZURE_UPDATE_COPY.unconfirmed}
      </p>
    );
  }
  return (
    <div className="space-y-2" aria-live="polite" data-testid="azure-update-updating">
      <p className="text-sm font-medium">{AZURE_UPDATE_COPY.updating}</p>
      <p className="text-sm text-muted-foreground">
        {progress.confirming ? AZURE_UPDATE_COPY.confirming : AZURE_UPDATE_COPY.running}
      </p>
      <AgentUpdateProgress update={update} />
    </div>
  );
}

/**
 * Shown only on a settled failure (`azureUpdateVerdict`). The message says what
 * was observed; nothing is added about which version runs.
 */
function UpdateFailed({ message, follow }: { message: string; follow: AzureUpdateProgressState }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-[var(--app-card-radius-compact)] border border-destructive/30 bg-destructive/5 px-4 py-3"
      data-testid="azure-update-failed"
    >
      <p className="text-sm font-semibold text-destructive">{AZURE_UPDATE_COPY.failed}</p>
      <p className="text-sm text-destructive">{message}</p>
      <Button className="self-start" disabled={follow.retrying} onClick={() => void follow.retry()}>
        {follow.retrying ? "Opening Microsoft sign-in…" : AZURE_UPDATE_COPY.retry}
      </Button>
      {follow.signInError ? <p className="text-sm text-destructive">{follow.signInError}</p> : null}
    </div>
  );
}

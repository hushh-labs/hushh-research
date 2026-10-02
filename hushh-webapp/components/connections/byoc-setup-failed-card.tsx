import type { SetupRetry } from "@/lib/one/cloud-setup-stages";

/** The part of a setup-status record a failed or stopped job reports. */
type FailedSetupJob = {
  errorCode: string | null;
  errorMessage: string | null;
  stale: boolean;
};

const TEXT_ACTION =
  "min-h-11 self-start text-sm underline underline-offset-4 text-destructive disabled:opacity-50";

function GoogleBillingLinks() {
  return (
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
  );
}

/**
 * The cloud step's card for a setup that failed or stopped. Its one action
 * restarts the same cloud's sign-in: an Azure job never reaches the Google
 * authorization path, and a job whose cloud cannot be told only refreshes.
 */
export function ByocSetupFailedCard({
  job,
  retry,
  busy,
  onRetry,
}: {
  job: FailedSetupJob;
  retry: SetupRetry | null;
  busy: boolean;
  onRetry: (retry: SetupRetry) => void;
}) {
  const azure = retry?.provider === "azure";
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-[var(--app-card-radius-compact)] border border-destructive/30 bg-destructive/5 px-4 py-3"
      data-testid="byoc-setup-failed"
    >
      <p className="text-sm font-semibold text-destructive">
        {azure ? "Your agent is not set up in Azure yet" : "Your cloud is not set up yet"}
      </p>
      <p className="text-sm text-destructive">
        {job.stale
          ? "The setup stopped partway (our side restarted). Everything already done is kept."
          : job.errorMessage || "The setup could not finish."}
      </p>
      {!azure && job.errorCode === "NEEDS_BILLING" ? <GoogleBillingLinks /> : null}
      {retry ? (
        <button
          type="button"
          disabled={busy}
          className={TEXT_ACTION}
          onClick={() => onRetry(retry)}
          data-testid="byoc-setup-retry"
        >
          {azure ? "Sign in with Microsoft again" : "Deploy to your cloud"}
        </button>
      ) : (
        <button
          type="button"
          className={TEXT_ACTION}
          onClick={() => window.location.reload()}
          data-testid="byoc-setup-refresh"
        >
          Refresh status
        </button>
      )}
    </div>
  );
}

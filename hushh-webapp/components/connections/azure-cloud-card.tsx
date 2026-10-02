"use client";

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { isAzureSignInAvailable } from "@/lib/one/azure-sign-in";

/**
 * Azure version 1, stated honestly before anyone signs in
 * (`docs/reference/architecture/byoc-azure.md`, capabilities section).
 */
export const AZURE_V1_CAPABILITY_NOTES: readonly string[] = [
  "Memory recall is keyword-based for now.",
  "Voice is not available yet.",
  "Web search is not available yet.",
  "New-mail alerts are off.",
  "Files are not organized in the background yet.",
];

/** A list price from the Azure Retail Prices API, not a measured bill. */
export const AZURE_COST_NOTE =
  "About $5/month while idle, billed by Microsoft to your subscription; list price, not yet measured.";

type AzureCloudCardProps = {
  onConnect: () => void | Promise<void>;
  busy?: boolean;
};

/** Connect Azure: one Microsoft sign-in, then the agent is built in the person's subscription. */
export function AzureCloudCard({ onConnect, busy = false }: AzureCloudCardProps) {
  const available = isAzureSignInAvailable();
  return (
    <SettingsGroup testId="connections-azure-cloud">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          Sign in with Microsoft to set up your private agent in your own Azure
          subscription. Between your sign-ins, Hussh can only see and restart it.
        </p>
        <ul
          className="list-disc space-y-1 pl-5 text-sm text-muted-foreground"
          aria-label="What is different on Azure for now"
          data-testid="azure-capability-notes"
        >
          {AZURE_V1_CAPABILITY_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground" data-testid="azure-cost-note">
          {AZURE_COST_NOTE}
        </p>
        {available ? null : (
          <p className="text-xs text-muted-foreground" data-testid="azure-web-only">
            Microsoft sign-in is not available in the mobile app yet. Continue on
            the Hussh website.
          </p>
        )}
        <Button
          type="button"
          disabled={busy || !available}
          onClick={() => void onConnect()}
          data-testid="azure-connect"
        >
          {busy ? "Opening Microsoft sign-in…" : "Connect Azure"}
        </Button>
      </div>
    </SettingsGroup>
  );
}

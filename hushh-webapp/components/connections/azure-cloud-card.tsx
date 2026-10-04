"use client";

import { useState } from "react";

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isAzureSignInAvailable } from "@/lib/one/azure-sign-in";
import { isAzureSubscriptionId } from "@/lib/services/azure-byoc-contract";

/** The portal page that lists a person's subscriptions and their ids. */
export const AZURE_SUBSCRIPTIONS_URL =
  "https://portal.azure.com/#view/Microsoft_Azure_Billing/SubscriptionsBlade";

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

/** List price, checked against one measured idle day (the registry, 2026-10-02). */
export const AZURE_COST_NOTE =
  "About $5/month while idle, billed by Microsoft to your subscription. A full idle day measured $0.14.";

type AzureCloudCardProps = {
  onConnect: (subscriptionId: string) => void | Promise<void>;
  busy?: boolean;
};

/**
 * Connect Azure: name the subscription, one Microsoft sign-in, then the agent is
 * built there. The subscription comes first because the sign-in must go to that
 * subscription's own directory: a personal Microsoft account signing in through
 * the shared `common` endpoint lands in Microsoft's consumer directory, which
 * cannot reach Azure at all (measured 2026-10-03, AADSTS900144).
 */
export function AzureCloudCard({ onConnect, busy = false }: AzureCloudCardProps) {
  const available = isAzureSignInAvailable();
  const [subscriptionId, setSubscriptionId] = useState("");
  const trimmed = subscriptionId.trim();
  const valid = isAzureSubscriptionId(trimmed);
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="azure-card-subscription-id" className="text-sm font-medium">
            Your Azure subscription ID
          </Label>
          <Input
            id="azure-card-subscription-id"
            value={subscriptionId}
            onChange={(event) => setSubscriptionId(event.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            className="font-mono"
            aria-invalid={trimmed.length > 0 && !valid}
            aria-describedby="azure-card-subscription-help"
            data-testid="azure-card-subscription-id"
          />
          <p id="azure-card-subscription-help" className="text-xs text-muted-foreground">
            {trimmed.length > 0 && !valid ? "That doesn't look like a subscription ID yet. " : null}
            <a
              href={AZURE_SUBSCRIPTIONS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
              data-testid="azure-card-find-subscription"
            >
              Find it in the Azure portal
            </a>
          </p>
        </div>
        {available ? null : (
          <p className="text-xs text-muted-foreground" data-testid="azure-web-only">
            Microsoft sign-in is not available in the mobile app yet. Continue on
            the Hussh website.
          </p>
        )}
        <Button
          type="button"
          disabled={busy || !available || !valid}
          onClick={() => void onConnect(trimmed.toLowerCase())}
          data-testid="azure-connect"
        >
          {busy ? "Opening Microsoft sign-in…" : "Connect Azure"}
        </Button>
      </div>
    </SettingsGroup>
  );
}

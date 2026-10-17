"use client";

import { useState } from "react";

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { AzurePersonalSubscription } from "@/components/connections/azure-personal-subscription";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  isUsableAzureSubscription,
  type AzureSubscription,
  type AzureSubscriptionReason,
} from "@/lib/services/azure-byoc-contract";


type AzureSubscriptionPickerProps = {
  subscriptions: readonly AzureSubscription[];
  /** Restart the Microsoft sign-in, scoped to the chosen subscription when given. */
  onContinue: (subscriptionId?: string) => void | Promise<void>;
  busy?: boolean;
  /** Why the hub asked; a personal Microsoft account must name its subscription. */
  reason?: AzureSubscriptionReason;
};

/**
 * The person's Microsoft account can see more than one subscription. The agent
 * lives in exactly one, so the person chooses it; only an enabled subscription
 * can be chosen. Continuing restarts the sign-in for that subscription, because
 * the first sign-in's code has already been spent.
 */
export function AzureSubscriptionPicker({
  subscriptions,
  onContinue,
  busy = false,
  reason,
}: AzureSubscriptionPickerProps) {
  const usable = subscriptions.filter(isUsableAzureSubscription);
  // One enabled subscription is the obvious answer; more than one is a choice.
  const [selected, setSelected] = useState(
    usable.length === 1 ? (usable[0]?.subscriptionId ?? "") : "",
  );

  if (subscriptions.length === 0 && reason === "personal_account") {
    return <AzurePersonalSubscription onContinue={onContinue} busy={busy} />;
  }

  if (subscriptions.length === 0) {
    return (
      <SettingsGroup testId="azure-no-subscription">
        <div className="flex flex-col gap-4 p-4">
          <p className="text-sm text-muted-foreground">
            This Microsoft account has no Azure subscription to set up in. Create
            one in the Azure portal, then sign in again.
          </p>
          <a
            href="https://portal.azure.com/"
            target="_blank"
            rel="noreferrer"
            className="min-h-11 self-start text-sm underline underline-offset-4"
          >
            Open the Azure portal
          </a>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void onContinue()}
          >
            {busy ? "Opening Microsoft sign-in…" : "Sign in again"}
          </Button>
        </div>
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup testId="azure-subscription-picker">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          Choose the subscription your agent will live in. Everything it needs is
          created in one new resource group there and billed to that subscription.
        </p>
        <RadioGroup
          value={selected}
          onValueChange={setSelected}
          aria-label="Azure subscription"
          className="gap-4"
        >
          {subscriptions.map((subscription) => {
            const enabled = isUsableAzureSubscription(subscription);
            const inputId = `azure-subscription-${subscription.subscriptionId}`;
            return (
              <div
                key={subscription.subscriptionId}
                className="grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1"
              >
                <RadioGroupItem id={inputId} value={subscription.subscriptionId} disabled={!enabled} />
                <Label htmlFor={inputId} className="text-sm font-medium">
                  {subscription.displayName || subscription.subscriptionId}
                </Label>
                <span className="col-start-2 truncate font-mono text-xs text-muted-foreground">
                  {subscription.subscriptionId}
                  {enabled ? "" : ` · ${subscription.state}`}
                </span>
              </div>
            );
          })}
        </RadioGroup>
        {usable.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="azure-no-enabled-subscription">
            None of these subscriptions is enabled. Enable one in the Azure portal,
            then sign in again.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Microsoft will ask you to confirm once more for this subscription.
          </p>
        )}
        <Button
          type="button"
          disabled={!selected || busy}
          onClick={() => void onContinue(selected)}
          data-testid="azure-subscription-continue"
        >
          {busy ? "Opening Microsoft sign-in…" : "Continue with this subscription"}
        </Button>
      </div>
    </SettingsGroup>
  );
}

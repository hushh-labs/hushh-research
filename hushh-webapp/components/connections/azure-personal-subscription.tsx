"use client";

import { useState } from "react";

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isAzureSubscriptionId } from "@/lib/services/azure-byoc-contract";

const AZURE_SUBSCRIPTIONS_URL =
  "https://portal.azure.com/#view/Microsoft_Azure_Billing/SubscriptionsBlade";

/**
 * A personal Microsoft account cannot list its subscriptions to an app, so the
 * person names the one their agent will live in. Its id is a GUID shown on the
 * portal's Subscriptions page; continuing signs in to that subscription's directory.
 */
export function AzurePersonalSubscription({
  onContinue,
  busy = false,
}: {
  onContinue: (subscriptionId?: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const [value, setValue] = useState("");
  const valid = isAzureSubscriptionId(value);
  return (
    <SettingsGroup testId="azure-personal-subscription">
      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          Personal Microsoft accounts don&apos;t share their subscription list with apps.
          Paste the subscription id your agent should live in.
        </p>
        <Label htmlFor="azure-subscription-id" className="text-sm font-medium">
          Subscription id
        </Label>
        <Input
          id="azure-subscription-id"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          aria-invalid={value.length > 0 && !valid}
          data-testid="azure-subscription-id"
        />
        <a
          href={AZURE_SUBSCRIPTIONS_URL}
          target="_blank"
          rel="noreferrer"
          className="min-h-11 self-start text-sm underline underline-offset-4"
        >
          Find it in the Azure portal
        </a>
        <Button
          type="button"
          disabled={!valid || busy}
          onClick={() => void onContinue(value.trim())}
          data-testid="azure-subscription-continue"
        >
          {busy ? "Opening Microsoft sign-in…" : "Continue with this subscription"}
        </Button>
      </div>
    </SettingsGroup>
  );
}

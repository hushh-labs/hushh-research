"use client";

import { Button } from "@/lib/morphy-ux/morphy";
import { useAzureSignIn } from "@/lib/one/azure-sign-in";

/**
 * Resume an approved Azure update whose Microsoft sign-in did not finish,
 * for example because the person closed it. The approval is already recorded
 * for the exact release they were shown, so this only restarts the sign-in.
 */
export function AzureUpdateSignInPrompt() {
  const signIn = useAzureSignIn();
  return (
    <div className="space-y-2" data-testid="azure-update-awaiting-sign-in">
      <p className="text-sm text-muted-foreground">
        Your agent keeps its current version until you sign in with Microsoft to start this update.
      </p>
      <Button disabled={signIn.starting} onClick={() => void signIn.start("upgrade")}>
        {signIn.starting ? "Opening Microsoft sign-in…" : "Continue to Microsoft sign-in"}
      </Button>
      {signIn.error ? (
        <p role="alert" className="text-sm text-destructive">
          {signIn.error}
        </p>
      ) : null}
    </div>
  );
}

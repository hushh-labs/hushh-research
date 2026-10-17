"use client";

import { Button } from "@/components/ui/button";
import { returnToOpener } from "@/lib/one/azure-sign-in";

/**
 * The sign-in popup's last screen when the Hussh tab that opened it did not answer
 * in time (a busy or sleeping tab). Setup has started either way; the person goes
 * back to their Hussh window to follow it, rather than the popup becoming a second,
 * popup-sized copy of the app.
 */
export function AzureReturnHandoff() {
  return (
    <div className="flex flex-col gap-3" data-testid="azure-return-unanswered">
      <p className="text-sm text-muted-foreground">
        Azure is connected and your agent is being set up. Follow it in your Hussh window.
      </p>
      <Button type="button" onClick={returnToOpener} data-testid="azure-return-to-hussh">
        Return to Hussh
      </Button>
    </div>
  );
}

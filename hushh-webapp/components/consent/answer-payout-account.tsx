"use client";

import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { useState } from "react";
import { AuthService } from "@/lib/services/auth-service";
import { AnswerRequestService } from "@/lib/services/answer-request-service";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";

/** Answer-only account verification; its mode does not change file payments. */
export function AnswerPayoutAccount() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const manage = async () => {
    const epoch = snapshotVaultSessionEpoch();
    setBusy(true);
    setMessage(null);
    try {
      const token = await AuthService.getIdToken();
      if (!token) throw new Error("Sign in to manage payouts.");
      const { account, stripeMode } = await AnswerRequestService.payoutAccount(token);
      setMessage(stripeMode === "test" ? "Test payout setup. No real money moves." : "Live answer payout setup.");
      const url = await AnswerRequestService.payoutLink(token, account?.canManageBank && account.ready ? "dashboard" : "onboarding");
      if (isVaultSessionEpochCurrent(epoch)) window.location.assign(url);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Payout setup is temporarily unavailable.");
    } finally { setBusy(false); }
  };
  return <div className="space-y-1">
    <Button type="button" variant="none" size="standard" disabled={busy} onClick={() => void manage()}>
      {busy ? "Checking payout setup…" : "Manage answer payouts"}
    </Button>
    <HelperText as="p">Answer earnings deduct Hushh’s 3% fee and Stripe’s actual processing fee. Earnings wait safely until your bank account is verified.</HelperText>
    {message ? <HelperText as="p" role="status">{message}</HelperText> : null}
  </div>;
}

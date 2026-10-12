"use client";

import {
  isVaultSessionEpochCurrent,
  snapshotVaultSessionEpoch,
} from "@/lib/vault/session-epoch";
import { useEffect, useState } from "react";
import { AuthService } from "@/lib/services/auth-service";
import { AnswerRequestService } from "@/lib/services/answer-request-service";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";

/** Answer-only account verification; its mode does not change file payments. */
export function AnswerPayoutAccount() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Payout setup has its own reachability rule (`_payout_mode_allowed`): a
  // paused lane must not open an Express account in another Connect mode, so
  // the endpoint 404s. Asked before the control is offered, because the
  // owner can now reach this sheet with payments paused and a button that
  // reports a failure is still a dead button.
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await AuthService.getIdToken();
        if (!token) throw new Error("no token");
        const gates = await AnswerRequestService.gates(token);
        if (!cancelled) setReachable(gates.payouts);
      } catch {
        // Unknown, not "off": the button stays, and a real attempt reports
        // the real reason rather than this component inventing one.
        if (!cancelled) setReachable(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const manage = async () => {
    const epoch = snapshotVaultSessionEpoch();
    setBusy(true);
    setMessage(null);
    try {
      const token = await AuthService.getIdToken();
      if (!token) throw new Error("Sign in to manage payouts.");
      const { account, stripeMode } =
        await AnswerRequestService.payoutAccount(token);
      setMessage(
        stripeMode === "test"
          ? "Test payout setup. No real money moves."
          : "Live answer payout setup.",
      );
      const url = await AnswerRequestService.payoutLink(
        token,
        account?.canManageBank && account.ready ? "dashboard" : "onboarding",
      );
      if (isVaultSessionEpochCurrent(epoch)) window.location.assign(url);
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "Payout setup is temporarily unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (reachable === false) {
    return (
      <HelperText as="p" role="status">
        Answer payout setup opens once paid answers are switched on here.
        Approving still records the price; nothing is charged or paid out
        until then.
      </HelperText>
    );
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="none"
        size="standard"
        disabled={busy}
        onClick={() => void manage()}
      >
        {busy ? "Checking payout setup…" : "Manage answer payouts"}
      </Button>
      <HelperText as="p">
        Answer earnings deduct Hushh’s 3% fee and Stripe’s actual processing
        fee. Earnings wait safely until your bank account is verified.
      </HelperText>
      {message ? (
        <HelperText as="p" role="status">
          {message}
        </HelperText>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useRef, useState } from "react";
import { usePayoutResource } from "@/lib/payouts/payout-live-store";
import { DocumentPayoutService } from "@/lib/services/document-payout-service";

import { PayoutActivityCard } from "./payouts/activity-card";
import { PayoutBankRows, type PayoutAccountState, type PayoutBankActions } from "./payouts/payout-bank-row";
import { PayoutFreshness } from "./payouts/payout-freshness";
import { PayoutSandbox } from "./payouts/payout-sandbox";
import type { PayoutReceiptAction } from "./payouts/receipts/receipt-ui";
import { RedeemAction, useHashcoinRedeem } from "./payouts/redeem-action";
import { YourMoneyCard } from "./payouts/your-money-card";

/**
 * Payouts: "Your money", the one Redeem action, then Activity. Each card reads
 * its own source, so a wallet failure never hides the bank or the history.
 * The one freshness line sits under "Your money", the balances it ages with.
 * Real earnings and simulated withdrawals never share a balance: the sandbox
 * shows only in test mode. A receipt's next step ("Update your bank", "Verify
 * details") uses the bank rows' own actions; no receipt moves money.
 */
export function DocumentHashcoinPayouts() {
  const wallet = usePayoutResource("wallet", DocumentPayoutService.hashcoins);
  const [bank, setBank] = useState<PayoutAccountState | null>(null);
  const redeem = useHashcoinRedeem(wallet, bank);
  const bankActions = useRef<PayoutBankActions>(null);
  const takeReceiptStep = useCallback((action: PayoutReceiptAction) => {
    if (action === "manage_bank") bankActions.current?.manageBank();
    else if (action === "verify") bankActions.current?.verifyDetails();
  }, []);

  if (!wallet.token) return null;
  return <div className="space-y-4">
    <YourMoneyCard wallet={wallet} bank={bank} liveRedeemEnabled={redeem.liveRedeemEnabled}
      freshness={<PayoutFreshness />} bankRows={<PayoutBankRows handleReturn onAccountChange={setBank} actionsRef={bankActions} />} />
    {redeem.liveRedeemEnabled ? <RedeemAction wallet={wallet} redeem={redeem} data-voice-control-id="profile_payouts_redeem" /> : null}
    <PayoutActivityCard onAction={takeReceiptStep} />
    {redeem.sandboxEnabled ? <PayoutSandbox wallet={wallet} redeem={redeem} data-voice-control-id="profile_payouts_test_redeem" /> : null}
  </div>;
}

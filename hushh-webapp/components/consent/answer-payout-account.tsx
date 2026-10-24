"use client";

import { AnswerRequestService } from "@/lib/services/answer-request-service";
import { Button } from "@/lib/morphy-ux/button";
import { HelperText } from "@/components/app-ui/typography";
import { useCommerceRead } from "./use-commerce-session";
import { useCommerceAction } from "./use-commerce-action";
import { useCommerceHostedFlow } from "./use-commerce-hosted-flow";
import { useCommerceManagement } from "./use-commerce-management";

const load = async (token: string) => {
  const gates = await AnswerRequestService.gates(token);
  return { payouts: gates.payouts, ...(gates.payouts ? await AnswerRequestService.payoutAccount(token) : {}) };
};
const pending = () => false;
const prepare = (token: string) => AnswerRequestService.payoutOnboarding(token, crypto.randomUUID());
const prepareManagement = (token: string) => AnswerRequestService.payoutLink(token, "dashboard");

/** Answer-only account verification; its mode never changes other earnings. */
export function AnswerPayoutAccount() {
  const status = useCommerceRead("answer-payout-account", load, pending);
  const action = useCommerceAction(status, "answer-payout-account");
  const hosted = useCommerceHostedFlow(status, action, prepare, () => status.refresh());
  const manageBank = useCommerceManagement(status, action, prepareManagement);
  const canManage = status.data?.account?.ready && status.data.account.canManageBank;
  const manage = () => {
    if (!status.user || action.busy || hosted.hostedPending) return;
    if (!canManage) { void hosted.startHosted("onboarding"); return; }
    void manageBank();
  };
  if (status.data?.payouts === false) return (
    <HelperText as="p" role="status" className="consent-presentation-surface">
      Answer payout setup opens once paid answers are switched on here.
      Approving still records the price; nothing is charged or paid out until then.
    </HelperText>
  );
  return (
    <div className="consent-presentation-surface space-y-1">
      <Button data-consent-role="compact-action" data-consent-quiet-action="true" type="button" variant="none" size="standard" disabled={!status.user || action.busy || hosted.hostedPending} onClick={manage}>
        {action.busy || hosted.hostedPending ? "Checking payout setup…" : "Manage answer payouts"}
      </Button>
      <HelperText as="p">
        Answer earnings deduct Hushh’s 3% fee and Stripe’s actual processing fee.
        Stripe verifies your identity and bank; you do not need a separate company.
      </HelperText>
      {status.data?.stripeMode ? <HelperText as="p">{status.data.stripeMode === "test" ? "Test payout setup. No real money moves." : "Live answer payout setup."}</HelperText> : null}
      {action.message || status.error ? <HelperText as="p" role="status">{action.message || status.error}</HelperText> : null}
    </div>
  );
}

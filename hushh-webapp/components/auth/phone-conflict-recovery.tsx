import type { CSSProperties } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { kaiAppCardTitleClassName } from "@/components/kai/shared/kai-typography";
import { cn } from "@/lib/utils";

type Props = {
  conflict: "choices" | "review";
  busy: boolean;
  submissionBlocked: boolean;
  transferEligible: boolean;
  transferPending: boolean;
  operationError: string | null;
  className?: string;
  style?: CSSProperties;
  reviewTransfer: () => void;
  handleTransfer: () => Promise<unknown>;
  recoverPrevious: (deleting: boolean) => Promise<void>;
  returnToPhoneNumber: () => boolean;
  startFreshSms: () => Promise<unknown>;
};

/** Explicit recovery choices; only fresh provider proof can enable transfer. */
export function PhoneConflictRecovery(props: Props) {
  const { busy, submissionBlocked, transferEligible, transferPending, conflict } = props;
  return <div className={cn("space-y-4", props.className)} style={props.style}>
    <h2 className={kaiAppCardTitleClassName}>{conflict === "choices" ? "This number is linked to another account" : "Use this number on this account?"}</h2>
    <p className="text-sm text-muted-foreground">Only the phone link will move. The previous account, files, vault and information will remain safe.</p>
    {props.operationError ? <p role="alert" className="text-sm text-destructive">{props.operationError}</p> : null}
    {conflict === "choices" ? <>
      <Button type="button" className="w-full" disabled={busy || submissionBlocked || !transferEligible} data-voice-control-id="phone-flow-transfer-review" onClick={props.reviewTransfer}>Use this number on this account</Button>
      {!transferEligible ? <>
        <p className="text-sm text-muted-foreground">Transfers require a fresh real SMS code. Test codes cannot transfer a number.</p>
        <Button type="button" variant="none" className="w-full" disabled={busy || submissionBlocked} data-voice-control-id="phone-flow-fresh-sms" onClick={() => void props.startFreshSms()}>Send a real SMS code</Button>
      </> : null}
      <Button type="button" variant="none" className="w-full" disabled={busy} data-voice-control-id="phone-flow-recover" onClick={() => void props.recoverPrevious(false)}>Recover my previous account</Button>
      <Button type="button" variant="none" className="w-full" disabled={busy} data-voice-control-id="phone-flow-delete-previous" onClick={() => void props.recoverPrevious(true)}>Delete my previous account</Button>
      <p className="text-sm text-muted-foreground">Recovery and deletion require signing in to your previous Google or Apple account. Deletion has its own confirmation.</p>
      <Button type="button" variant="none" disabled={busy} data-voice-control-id="phone-flow-change-number" onClick={props.returnToPhoneNumber}>Use a different number</Button>
    </> : <>
      <p className="text-sm text-muted-foreground">Confirm using your fresh SMS verification. Previous phone-based access will be revoked. This does not delete either account.</p>
      <Button type="button" className="w-full" disabled={busy || submissionBlocked} data-voice-control-id="phone-flow-transfer-confirm" onClick={() => void props.handleTransfer()}>{busy ? "Checking transfer…" : transferPending ? "Check transfer progress" : "Confirm phone transfer"}</Button>
      <Button type="button" variant="none" disabled={busy || transferPending} data-voice-control-id="phone-flow-transfer-cancel" onClick={props.returnToPhoneNumber}>Cancel</Button>
    </>}
  </div>;
}

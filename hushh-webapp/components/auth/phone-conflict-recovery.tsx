import { useState, type CSSProperties } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { kaiAppCardTitleClassName } from "@/components/kai/shared/kai-typography";
import type { LinkedDeletionPreparation } from "@/lib/services/phone-recovery-service";
import { cn } from "@/lib/utils";

type Props = {
  conflict: "choices" | "review" | "delete";
  busy: boolean;
  submissionBlocked: boolean;
  transferEligible: boolean;
  /** The server refused moving any number here; a transfer control could never succeed. */
  transferUnavailable: boolean;
  transferPending: boolean;
  operationError: string | null;
  className?: string;
  style?: CSSProperties;
  reviewTransfer: () => void;
  handleTransfer: () => Promise<unknown>;
  recoverPrevious: (deleting: boolean | "revoke") => Promise<void>;
  deletePrevious: () => Promise<void>;
  deletionReview: LinkedDeletionPreparation | null;
  deletionNeedsFreshProof: boolean;
  deletionUnconfirmed: boolean;
  confirmDeletion: (testCode?: string) => Promise<void>;
  restartVerification: () => void;
  returnToPhoneNumber: () => boolean;
  startFreshSms: () => Promise<unknown>;
};

/** Explicit recovery choices; only fresh provider proof can enable transfer or deletion. */
export function PhoneConflictRecovery(props: Props) {
  const { busy, submissionBlocked, transferEligible, transferUnavailable, transferPending, conflict } = props;
  if (conflict === "delete") return <LinkedDeletionReview {...props} />;
  return <div className={cn("space-y-4", props.className)} style={props.style}>
    <h2 className={kaiAppCardTitleClassName}>{conflict === "choices" ? "This number is linked to another account" : "Use this number on this account?"}</h2>
    {transferUnavailable ? null : <p className="text-sm text-muted-foreground">Moving the phone link keeps both accounts, files and vaults.</p>}
    {props.operationError ? <p role="alert" className="text-sm text-destructive">{props.operationError}</p> : null}
    {conflict === "choices" ? <>
      {transferUnavailable ? null : <Button type="button" className="w-full" disabled={busy || submissionBlocked || !transferEligible} data-voice-control-id="phone-flow-transfer-review" onClick={props.reviewTransfer}>Use this number on this account</Button>}
      {!transferEligible && !transferUnavailable ? <>
        <p className="text-sm text-muted-foreground">Transfers require a fresh real SMS code. Test codes cannot transfer a number.</p>
        <Button type="button" variant="none" className="w-full" disabled={busy || submissionBlocked} data-voice-control-id="phone-flow-fresh-sms" onClick={() => void props.startFreshSms()}>Send a real SMS code</Button>
      </> : null}
      <p className="text-sm text-muted-foreground">Recovery opens your previous account after sign-in.</p>
      <Button type="button" variant="none" className="w-full" disabled={busy} data-voice-control-id="phone-flow-recover" onClick={() => void props.recoverPrevious(false)}>Recover my previous account</Button>
      <p className="text-sm text-muted-foreground">Deletion is permanent and needs a separate review.</p>
      <Button type="button" variant="none" className="w-full" disabled={busy} data-voice-control-id="phone-flow-delete-previous" onClick={() => void props.deletePrevious()}>Delete my previous account</Button>
      <p className="text-sm text-muted-foreground">Revoke access for a selected device after verifying your previous account.</p>
      <Button type="button" variant="none" className="w-full" disabled={busy} data-voice-control-id="phone-flow-revoke-previous" onClick={() => void props.recoverPrevious("revoke")}>Review previous device access</Button>
      <Button type="button" variant="none" disabled={busy} data-voice-control-id="phone-flow-change-number" onClick={props.returnToPhoneNumber}>Use a different number</Button>
    </> : <>
      <p className="text-sm text-muted-foreground">Confirm using your fresh SMS verification. Previous phone-based access will be revoked. This does not delete either account.</p>
      <Button type="button" className="w-full" disabled={busy || submissionBlocked} data-voice-control-id="phone-flow-transfer-confirm" onClick={() => void props.handleTransfer()}>{busy ? "Checking transfer…" : transferPending ? "Check transfer progress" : "Confirm phone transfer"}</Button>
      <Button type="button" variant="none" disabled={busy || transferPending} data-voice-control-id="phone-flow-transfer-cancel" onClick={props.returnToPhoneNumber}>Cancel</Button>
    </>}
  </div>;
}

/** One permanent decision: the number's proof plus an explicit acknowledgement. */
function LinkedDeletionReview(props: Props) {
  const [code, setCode] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const review = props.deletionReview;
  const needsCode = review?.transport === "configured_test";
  const ready = acknowledged && (!needsCode || /^\d{6}$/.test(code)) && !props.busy && !props.submissionBlocked;
  return <div className={cn("space-y-4", props.className)} style={props.style}>
    <h2 className={kaiAppCardTitleClassName}>Delete the account linked to {review?.phone_hint ?? "this number"}?</h2>
    <p className="text-sm text-muted-foreground">That account and its vault are deleted permanently. You can’t undo this.</p>
    {props.operationError ? <p role="alert" className="text-sm text-destructive">{props.operationError}</p> : null}
    {props.deletionNeedsFreshProof ? <Button type="button" className="w-full" disabled={props.busy} data-voice-control-id="phone-flow-delete-verify-again" onClick={props.restartVerification}>Verify this number again</Button> : <>
      {needsCode ? <label className="block space-y-2 text-sm">
        <span>Verification code</span>
        <input className="h-11 w-full rounded-xl border px-3" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
          value={code} disabled={props.busy} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
      </label> : null}
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1" checked={acknowledged} disabled={props.busy} onChange={event => setAcknowledged(event.target.checked)} />
        <span>I understand this can’t be undone.</span>
      </label>
      <Button type="button" variant="destructive" className="w-full" disabled={!ready} data-voice-control-id="phone-flow-delete-confirm" onClick={() => void props.confirmDeletion(needsCode ? code : undefined)}>{props.busy ? "Deleting…" : props.deletionUnconfirmed ? "Check again" : "Delete and continue"}</Button>
    </>}
    <Button type="button" variant="none" disabled={props.busy} data-voice-control-id="phone-flow-delete-cancel" onClick={props.returnToPhoneNumber}>Cancel</Button>
  </div>;
}

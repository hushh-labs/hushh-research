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
  deletionSettled?: "requested" | "not_found" | null;
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

/** One permanent decision: the number's real-SMS proof plus an explicit acknowledgement. */
function LinkedDeletionReview(props: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const review = props.deletionReview;
  const ready = acknowledged && !props.busy && !props.submissionBlocked;
  // Requested is not erased, and no number is linked here; each stays a separate, later state.
  const settled = props.deletionSettled ? SETTLED_TITLES[props.deletionSettled] : null;
  const verifyAgain = (primary: boolean) => <Button type="button" variant={primary ? undefined : "none"} className={primary ? "w-full" : undefined}
    disabled={props.busy} data-voice-control-id="phone-flow-delete-verify-again" onClick={props.restartVerification}>Verify this number again</Button>;
  return <div className={cn("space-y-4", props.className)} style={props.style}>
    <h2 className={kaiAppCardTitleClassName}>{settled ?? `Delete the account linked to ${review?.phone_hint ?? "this number"}?`}</h2>
    {settled ? null : <p className="text-sm text-muted-foreground">This permanently deletes that account and its vault. You can’t undo this.</p>}
    {props.operationError ? <p role={settled ? "status" : "alert"} className={settled ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>{props.operationError}</p> : null}
    {/* A spent or expired proof deletes nothing more; only a new verification continues. */}
    {props.deletionNeedsFreshProof ? verifyAgain(true) : props.deletionUnconfirmed ? <>
      {/* Once a confirmation was sent, nothing can be cancelled or sent again: Check again only reads it back. */}
      <Button type="button" className="w-full" disabled={props.busy || props.submissionBlocked} data-voice-control-id="phone-flow-delete-check" onClick={() => void props.confirmDeletion()}>{props.busy ? "Checking…" : "Check again"}</Button>
      {verifyAgain(false)}
    </> : <>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1" checked={acknowledged} disabled={props.busy} onChange={event => setAcknowledged(event.target.checked)} />
        <span>I understand this can’t be undone.</span>
      </label>
      <Button type="button" variant="destructive" className="w-full" disabled={!ready} data-voice-control-id="phone-flow-delete-confirm" onClick={() => void props.confirmDeletion()}>{props.busy ? "Requesting deletion…" : "Delete and continue"}</Button>
      <Button type="button" variant="none" disabled={props.busy} data-voice-control-id="phone-flow-delete-cancel" onClick={props.returnToPhoneNumber}>Cancel</Button>
    </>}
  </div>;
}

const SETTLED_TITLES = { requested: "Deletion requested", not_found: "Nothing left to delete" } as const;

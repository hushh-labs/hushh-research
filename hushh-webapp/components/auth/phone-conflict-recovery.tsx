"use client";

import { useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import { PHONE_CONFLICT_COPY } from "@/lib/auth/phone-conflict-copy";
import type { LinkedDeletionPreparation } from "@/lib/services/phone-recovery-service";
import { cn } from "@/lib/utils";
import styles from "./phone-conflict-recovery.module.css";

type Props = {
  busy: boolean;
  operationError: string | null;
  className?: string;
  style?: CSSProperties;
  reviewPreviousDeletion: () => Promise<void>;
  canReviewPreviousDeletion: boolean;
  returnToPhoneNumber: () => boolean;
  deletionReview?: LinkedDeletionPreparation | null;
  confirmDeletion?: (testCode?: string) => Promise<void>;
  deletionNeedsFreshProof?: boolean;
  deletionUnconfirmed?: boolean;
  deletionSettled?: "requested" | "not_found" | null;
  restartVerification?: () => void;
};

const SETTLED_TITLES = { requested: "Deletion requested", not_found: "Nothing left to delete" } as const;

/** A phone number remains linked to its existing email account. */
export function PhoneConflictRecovery(props: Props) {
  const pathname = usePathname();
  const Heading = pathname === ROUTES.PHONE_MANDATE ? "h1" : "h2";
  if (props.deletionReview) return <LinkedDeletionReview key={props.deletionReview.operation_id} {...props} Heading={Heading} />;
  const error = props.operationError !== PHONE_CONFLICT_COPY.inApp ? props.operationError : null;

  return <div data-phone-conflict="true" className={cn(styles.content, props.className)} style={props.style}>
    <Heading data-phone-conflict-title="true" className={styles.title}>Number already linked</Heading>
    {error ? <p className={styles.description} role="alert">{error}</p> : null}
    <Button type="button" variant="blue" size="prominent" fullWidth className={styles.primary} disabled={props.busy} data-voice-control-id="phone-flow-change-number" onClick={props.returnToPhoneNumber}>Use a different number</Button>
    <Button type="button" variant="none" effect="fade" fullWidth disabled={props.busy || !props.canReviewPreviousDeletion} className={styles.deleteReview} data-voice-control-id="phone-flow-delete-review" onClick={() => void props.reviewPreviousDeletion()}>Delete my previous account</Button>
  </div>;
}

/** One irreversible decision: the retained real-SMS proof plus an explicit acknowledgement. */
function LinkedDeletionReview(props: Props & { Heading: "h1" | "h2" }) {
  const { Heading, busy, deletionReview: review } = props;
  const [acknowledged, setAcknowledged] = useState(false);
  const ready = !busy && acknowledged;
  const hint = review?.phone_hint ?? "this number";
  const settled = props.deletionSettled ? SETTLED_TITLES[props.deletionSettled] : null;
  const verifyAgain = (primary: boolean) => <Button type="button" variant={primary ? "blue" : "none"} size={primary ? "prominent" : undefined}
    effect={primary ? undefined : "fade"} fullWidth className={primary ? styles.primary : undefined} disabled={busy}
    data-voice-control-id="phone-flow-delete-verify-again" onClick={props.restartVerification}>Verify this number again</Button>;
  return <div data-phone-conflict="true" data-phone-linked-deletion="true" className={cn(styles.content, props.className)} style={props.style}>
    <Heading data-phone-conflict-title="true" className={styles.title}>
      {settled ?? `Delete the account linked to ${hint}?`}
    </Heading>
    {settled ? null : <p className={styles.description}>
      This permanently deletes that account and its vault. You can’t undo this. Your current account isn’t changed.
    </p>}
    {props.operationError ? <p className={styles.description} role={settled ? "status" : "alert"}>{props.operationError}</p> : null}
    {/* A spent or expired proof deletes nothing more; only a new verification continues. */}
    {props.deletionNeedsFreshProof ? verifyAgain(true) : props.deletionUnconfirmed ? <>
      {/* Once a confirmation was sent, Cancel is withdrawn and nothing is sent again: Check again only reads it back. */}
      <Button type="button" variant="blue" size="prominent" fullWidth className={styles.primary} disabled={busy}
        data-voice-control-id="phone-flow-delete-check" onClick={() => void props.confirmDeletion?.()}>{busy ? "Checking…" : "Check again"}</Button>
      {verifyAgain(false)}
    </> : <>
      <label className={styles.description}>
        <input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} />{" "}
        I understand this can’t be undone.
      </label>
      <Button type="button" variant="destructive" size="prominent" fullWidth className={styles.primary} disabled={!ready} data-voice-control-id="phone-flow-delete-confirm"
        onClick={() => void props.confirmDeletion?.()}>{busy ? "Requesting deletion…" : "Delete that account"}</Button>
      <Button type="button" variant="none" effect="fade" fullWidth disabled={busy} data-voice-control-id="phone-flow-delete-cancel" onClick={props.returnToPhoneNumber}>Cancel</Button>
    </>}
  </div>;
}

"use client";

import { useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import { PHONE_CONFLICT_COPY } from "@/lib/auth/phone-conflict-copy";
import { cn } from "@/lib/utils";
import type { LinkedDeletionPreparation } from "@/lib/services/phone-recovery-service";
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
  confirmDeletion?: (code?: string) => Promise<void>;
  deletionUnavailable?: boolean;
};

/** A phone number remains linked to its existing email account. */
export function PhoneConflictRecovery(props: Props) {
  const pathname = usePathname();
  const Heading = pathname === ROUTES.PHONE_MANDATE ? "h1" : "h2";
  if (props.deletionReview) return <LinkedDeletionReview key={props.deletionReview.operation_id} {...props} />;
  const error = props.operationError !== PHONE_CONFLICT_COPY.inApp ? props.operationError : null;

  return <div data-phone-conflict="true" className={cn(styles.content, props.className)} style={props.style}>
    <Heading data-phone-conflict-title="true" className={styles.title}>Number already linked</Heading>
    {error ? <p className={styles.description} role="alert">{error}</p> : null}
    <Button type="button" variant="blue" size="prominent" fullWidth className={styles.primary} disabled={props.busy} data-voice-control-id="phone-flow-change-number" onClick={props.returnToPhoneNumber}>Use a different number</Button>
    <Button type="button" variant="none" effect="fade" fullWidth disabled={props.busy || !props.canReviewPreviousDeletion} className={styles.deleteReview} data-voice-control-id="phone-flow-delete-review" onClick={() => void props.reviewPreviousDeletion()}>Delete my previous account</Button>
  </div>;
}


function LinkedDeletionReview(props: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [code, setCode] = useState("");
  const needsCode = props.deletionReview?.transport === "configured_test";
  return <div className={cn(styles.content, props.className)} style={props.style}>
    <h2 className={styles.title}>Delete the account linked to {props.deletionReview?.phone_hint}?</h2>
    <p className={styles.description}>This permanently deletes that account and its vault.</p>
    {props.operationError ? <p className={styles.description} role="alert">{props.operationError}</p> : null}
    {props.deletionUnavailable ? <p className={styles.description}>Return to the previous screen to review your options.</p> : <>
      {needsCode ? <label>Verification code
        <input inputMode="numeric" autoComplete="one-time-code" value={code} disabled={props.busy}
          onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
      </label> : null}
      <label><input type="checkbox" checked={acknowledged} disabled={props.busy}
        onChange={event => setAcknowledged(event.target.checked)} /> I understand this can’t be undone.</label>
      <Button type="button" variant="destructive"
        disabled={props.busy || !acknowledged || (needsCode && code.length !== 6)}
        onClick={() => void props.confirmDeletion?.(needsCode ? code : undefined)}>Delete and continue</Button>
    </>}
    <Button type="button" variant="none" disabled={props.busy} onClick={props.returnToPhoneNumber}>Back</Button>
  </div>;
}

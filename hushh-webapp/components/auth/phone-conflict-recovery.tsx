"use client";

import { type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import { PHONE_CONFLICT_COPY } from "@/lib/auth/phone-conflict-copy";
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
};

/** A phone number remains linked to its existing email account. */
export function PhoneConflictRecovery(props: Props) {
  const pathname = usePathname();
  const Heading = pathname === ROUTES.PHONE_MANDATE ? "h1" : "h2";
  const error = props.operationError !== PHONE_CONFLICT_COPY.inApp ? props.operationError : null;

  return <div data-phone-conflict="true" className={cn(styles.content, props.className)} style={props.style}>
    <Heading data-phone-conflict-title="true" className={styles.title}>Number already linked</Heading>
    {error ? <p className={styles.description} role="alert">{error}</p> : null}
    <Button type="button" variant="blue" size="prominent" fullWidth className={styles.primary} disabled={props.busy} data-voice-control-id="phone-flow-change-number" onClick={props.returnToPhoneNumber}>Use a different number</Button>
    <Button type="button" variant="none" effect="fade" fullWidth disabled={props.busy || !props.canReviewPreviousDeletion} className={styles.deleteReview} data-voice-control-id="phone-flow-delete-review" onClick={() => void props.reviewPreviousDeletion()}>Delete my previous account</Button>
  </div>;
}

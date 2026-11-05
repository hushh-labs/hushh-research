import type { CSSProperties } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { kaiAppCardTitleClassName } from "@/components/kai/shared/kai-typography";
import { cn } from "@/lib/utils";

type Props = {
  busy: boolean;
  operationError: string | null;
  className?: string;
  style?: CSSProperties;
  recoverPrevious: () => Promise<void>;
  returnToPhoneNumber: () => boolean;
};

/** A phone number remains linked to its existing email account. */
export function PhoneConflictRecovery(props: Props) {
  return <div className={cn("space-y-4", props.className)} style={props.style}>
    <h2 className={kaiAppCardTitleClassName}>This number is linked to another account</h2>
    <p className="text-sm text-muted-foreground">One phone number can only be linked to one email account. Sign in to the existing account or use a different number.</p>
    {props.operationError ? <p role="alert" className="text-sm text-destructive">{props.operationError}</p> : null}
    <Button type="button" className="w-full" disabled={props.busy} data-voice-control-id="phone-flow-recover" onClick={() => void props.recoverPrevious()}>Sign in to existing account</Button>
    <Button type="button" variant="none" disabled={props.busy} data-voice-control-id="phone-flow-change-number" onClick={props.returnToPhoneNumber}>Use a different number</Button>
  </div>;
}

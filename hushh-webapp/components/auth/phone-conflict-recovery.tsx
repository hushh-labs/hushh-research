"use client";

import { useState, type CSSProperties } from "react";
import { usePathname } from "next/navigation";
import { ChevronRight } from "@/components/icons";
import { Sheet, SheetTrigger, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/lib/morphy-ux/button";
import { AdaptiveSheetContent, TaskSurfaceHeader, TaskSurfaceBody } from "@/lib/morphy-ux/ui/task-surfaces";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";
import styles from "./phone-conflict-recovery.module.css";

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
  const pathname = usePathname();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const Heading = pathname === ROUTES.PHONE_MANDATE ? "h1" : "h2";
  useBackLayer(pathname, optionsOpen ? 2 : 0, () => {
    setOptionsOpen(false);
    return true;
  });

  return <div data-phone-conflict="true" className={cn(styles.content, props.className)} style={props.style}>
    <Heading data-phone-conflict-title="true" className={styles.title}>This number is already linked</Heading>
    <p className={styles.description} role={props.operationError ? "alert" : undefined}>{props.operationError || "It’s connected to another Hussh account. Sign in to that account or use a different number."}</p>
    <Button type="button" variant="blue" size="prominent" fullWidth disabled={props.busy} data-voice-control-id="phone-flow-change-number" onClick={props.returnToPhoneNumber}>Use a different number</Button>
    <Sheet modal open={optionsOpen} onOpenChange={setOptionsOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="none" effect="fade" disabled={props.busy} className={styles.options} data-voice-control-id="phone-flow-account-options">
          <span>Account options</span><ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <AdaptiveSheetContent size="sm">
        <TaskSurfaceHeader>
          <SheetTitle>Account options</SheetTitle>
          <SheetDescription>Continue with the account linked to this number.</SheetDescription>
        </TaskSurfaceHeader>
        <TaskSurfaceBody>
          <Button type="button" variant="none" effect="fade" fullWidth disabled={props.busy} className={styles.signIn} data-voice-control-id="phone-flow-recover" onClick={() => {
            setOptionsOpen(false);
            void props.recoverPrevious();
          }}>Sign in to existing account</Button>
        </TaskSurfaceBody>
      </AdaptiveSheetContent>
    </Sheet>
  </div>;
}

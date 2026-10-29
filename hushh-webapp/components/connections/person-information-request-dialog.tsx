"use client";

import type { ComponentProps, ReactNode } from "react";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { InformationRequestReviewFields } from "@/components/consent/information-request-review-fields";
import { Button } from "@/lib/morphy-ux/button";
import { TaskDialogContent, TaskSurfaceHeader, TaskSurfaceBody, TaskSurfaceFooter } from "@/lib/morphy-ux/ui/task-surfaces";

type Props = ComponentProps<typeof InformationRequestReviewFields> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayName: string;
  requesting: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
  children?: ReactNode;
};

/** Presentation only; the page retains live identity, consent and request authority. */
export function PersonInformationRequestDialog({ open, onOpenChange, displayName, requesting, canSubmit, onSubmit, children, ...fields }: Props) {
  return <Dialog modal open={open} onOpenChange={onOpenChange}>
    <TaskDialogContent className="consent-presentation-surface">
      <TaskSurfaceHeader>
        <DialogTitle>Request information from {displayName}</DialogTitle>
        <DialogDescription>They will see exactly what you asked for, why, and for how long.</DialogDescription>
      </TaskSurfaceHeader>
      <TaskSurfaceBody>
        <InformationRequestReviewFields {...fields} disabled={requesting || fields.disabled} />
        {children}
      </TaskSurfaceBody>
      <TaskSurfaceFooter>
        <Button type="button" variant="none" effect="fade" data-consent-quiet-action="true" data-consent-action-context="task" data-voice-control-id="person-profile-request-cancel" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="button" variant="blue-gradient" effect="fill" disabled={!canSubmit || requesting}
          onClick={onSubmit} data-voice-control-id="person-profile-request-confirm">
          {requesting ? "Sending…" : "Send request"}
        </Button>
      </TaskSurfaceFooter>
    </TaskDialogContent>
  </Dialog>;
}

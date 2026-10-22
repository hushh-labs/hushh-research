"use client";

import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ComputerUseReview as Review } from "@/lib/computer-use/contracts";

const COPY = {
  model_process: { title: "Allow screen processing?", action: "Allow for this task" },
  disclose: { title: "Allow this website action?", action: "Allow once" },
  session_remember: { title: "Remember this sign-in?", action: "Remember this site" },
  session_restore: { title: "Use stored sign-in?", action: "Use for this task" },
  provider_safety: { title: "Review this browser action", action: "Allow this action" },
} as const;

/** Owner-only, transient review. Cookies and session values never reach this component. */
export function ComputerUseReview({ review, pending, open, onClose, onConfirm }: {
  review: Review;
  pending: boolean;
  open: boolean;
  onClose: () => void;
  onConfirm: (reviewId: string) => void;
}) {
  const copy = COPY[review.purpose];
  const description = review.purpose === "model_process"
    ? `Allow ${review.model} to process browser screens${review.details.length ? " and these selected details" : ""} for this task.`
    : review.purpose === "disclose"
      ? "Review the destination and action. Sign-in secrets stay out of this review."
      : review.purpose === "provider_safety"
        ? "The model flagged a concern. Review the action and warning before continuing."
      : review.purpose === "session_remember"
        ? "Save this site’s sign-in information encrypted in your cloud. Website expiry and logout still apply."
        : "Use stored sign-in information for this task. The website may ask you to sign in again.";

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }} modal>
      <DialogContent>
        <DialogHeader className="pr-8 text-left">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{description}{review.resultStorage === "owner_encrypted_log"
            ? " Save this task’s result encrypted in your private agent." : ""}</DialogDescription>
        </DialogHeader>
        {review.taskGoal ? <p className="whitespace-pre-wrap break-words text-sm">{review.taskGoal}</p> : null}
        {review.destination || review.origins.length ? (
          <div className="space-y-1 text-sm">
            {(review.destination ? [review.destination] : review.origins).map((origin) => (
              <p key={origin} className="break-all">{origin}</p>
            ))}
          </div>
        ) : null}
        {review.details.length ? (
          <dl className="space-y-3 text-sm">
            {review.details.map(({ label, value }) => (
              <div key={label} className="min-w-0">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="whitespace-pre-wrap break-words">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <DialogFooter>
          <ShellActionSurface variant="pill" className="min-h-11" onClick={onClose}>Not now</ShellActionSurface>
          <ShellActionSurface variant="pill" className="min-h-11" disabled={pending}
            onClick={() => onConfirm(review.id)}>{copy.action}</ShellActionSurface>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

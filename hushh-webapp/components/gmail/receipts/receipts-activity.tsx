"use client";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { RECURRING_EVENT_KINDS, eventText } from "@/lib/mail/receipt-tracking-present";
import mailStyles from "../mail-workspace.module.css";
import { useReceiptTracking } from "./receipt-tracking-context";

function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(at);
}

/** What you decided and what One recorded. "History" lists only choices about recurring bills. */
export function ReceiptsActivitySheet({
  open, onOpenChange, mode, syncLine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "activity" | "history";
  syncLine: string | null;
}) {
  const tracking = useReceiptTracking();
  const events = (tracking?.doc?.events ?? []).filter((event) => mode === "activity" || RECURRING_EVENT_KINDS.has(event.kind));
  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      title={mode === "activity" ? "Activity" : "History"}
      description={mode === "activity" ? "Receipt updates and the choices you made, newest first." : "Every choice about your recurring bills, newest first."}
      surfaceClassName={`${mailStyles.typography} ${mailStyles.portal}`}
      mobilePresentation="sheet"
      desktopMaxWidthClassName="sm:!max-w-[520px]"
    >
      <div className="space-y-3" data-testid={`${mode}-sheet`}>
        {mode === "activity" && syncLine ? <p className="rounded-xl bg-muted/60 px-4 py-3 text-[13px] leading-[19px] text-foreground" role="status">{syncLine}</p> : null}
        {tracking?.status === "error" ? <p className="text-[13px] leading-[19px] text-muted-foreground" role="status">{tracking.error}</p> : null}
        {events.length ? (
          <ol className="divide-y divide-border/60 rounded-2xl border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)]">
            {events.map((event) => (
              <li key={event.id} className="px-4 py-3" data-testid="activity-event">
                <p className="text-[14px] leading-[21px] text-foreground">{eventText(event)}</p>
                <p className="text-[12px] leading-[18px] text-muted-foreground">{when(event.at)}</p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[14px] leading-[21px] text-muted-foreground" role="status">
            Nothing yet. When you track a bill, move its date, skip one or review a plan, it appears here.
          </p>
        )}
      </div>
    </AdaptiveDetailSurface>
  );
}

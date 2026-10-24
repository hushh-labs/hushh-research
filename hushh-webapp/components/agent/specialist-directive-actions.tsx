"use client";

import { Button } from "@/components/ui/button";
import { CalendarCompactAction } from "@/components/calendar/calendar-compact-action";
import calendarPresentation from "@/components/calendar/calendar-presentation.module.css";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import type { SpecialistCardProps } from "./specialist-directive-card";

type Props = Pick<
  SpecialistCardProps,
  "brand" | "confirmLabel" | "onConfirm" | "onCancel" | "busy" | "busyLabel" | "cancelWhileBusy"
>;

export function SpecialistDirectiveActions({
  brand,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
  busyLabel,
  cancelWhileBusy,
}: Props) {
  return (
      <div className="mt-3 flex gap-2">
        {brand === "calendar" ? <CalendarCompactAction
          onClick={onConfirm}
          disabled={busy}
          data-testid="specialist-directive-confirm"
        >
          {busy ? busyLabel ?? "Working…" : confirmLabel}
        </CalendarCompactAction> : <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="relative rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
          data-testid="specialist-directive-confirm"
        >
          {busy ? busyLabel ?? "Working…" : confirmLabel}
          <MaterialRipple variant="none" effect="fill" disabled={busy} />
        </button>}
        {brand === "calendar" ? <Button
          variant="ghost"
          size="compact"
          className={calendarPresentation.utility}
          onClick={onCancel}
          disabled={busy && !cancelWhileBusy}
          data-testid="specialist-directive-cancel"
        >Cancel</Button> : <button
          type="button"
          onClick={onCancel}
          disabled={busy && !cancelWhileBusy}
          className="relative rounded-full bg-black/5 px-4 py-1.5 text-sm dark:bg-white/10"
          data-testid="specialist-directive-cancel"
        >
          Cancel
          <MaterialRipple variant="none" effect="glass" disabled={busy && !cancelWhileBusy} />
        </button>}
      </div>
  );
}

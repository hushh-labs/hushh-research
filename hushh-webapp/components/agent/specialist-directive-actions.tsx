"use client";

import { Button } from "@/components/ui/button";
import { CalendarCompactAction } from "@/components/calendar/calendar-compact-action";
import calendarPresentation from "@/components/calendar/calendar-presentation.module.css";
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
    <div className="mt-3.5 flex min-h-11 items-center gap-2">
      {brand === "calendar" ? (
        <CalendarCompactAction
          onClick={onConfirm}
          disabled={busy}
          data-testid="specialist-directive-confirm"
        >
          {busy ? busyLabel ?? "Working…" : confirmLabel}
        </CalendarCompactAction>
      ) : (
        <Button
          type="button"
          size="sm"
          className="px-4"
          onClick={onConfirm}
          disabled={busy}
          data-testid="specialist-directive-confirm"
        >
          {busy ? busyLabel ?? "Working…" : confirmLabel}
        </Button>
      )}
      {brand === "calendar" ? (
        <Button
          variant="ghost"
          size="compact"
          className={calendarPresentation.utility}
          onClick={onCancel}
          disabled={busy && !cancelWhileBusy}
          data-testid="specialist-directive-cancel"
        >
          Cancel
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="subdued"
          className="px-4"
          onClick={onCancel}
          disabled={busy && !cancelWhileBusy}
          data-testid="specialist-directive-cancel"
        >
          Cancel
        </Button>
      )}
    </div>
  );
}

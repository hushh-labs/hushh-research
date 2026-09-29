"use client";

import { useId, useState } from "react";

import { Flag } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { AgentResponseReportReason } from "@/lib/services/agent-chat-client";
import { cn } from "@/lib/utils";

/**
 * The in-app "Report response" control on one AI answer (Google Play's
 * AI-Generated Content policy). The answer is flagged for the Hussh team by
 * reason only; no ids are shown and no message content is sent.
 */
export const AGENT_RESPONSE_REPORT_REASONS: ReadonlyArray<{
  value: AgentResponseReportReason;
  label: string;
}> = [
  { value: "offensive", label: "Offensive or hateful" },
  { value: "harmful", label: "Harmful or dangerous" },
  { value: "inaccurate", label: "Inaccurate or misleading" },
  { value: "other", label: "Something else" },
];

export function AgentResponseReportButton({
  reported,
  onReport,
}: {
  /** True once this answer has been reported in this session. */
  reported: boolean;
  /** Resolves when the report is recorded; rejects so the dialog can retry. */
  onReport: (reason: AgentResponseReportReason) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<AgentResponseReportReason | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const groupId = useId();

  const close = (next: boolean) => {
    if (submitting) return;
    setOpen(next);
    if (!next) {
      setReason(null);
      setFailed(false);
    }
  };

  const submit = async () => {
    if (!reason || submitting) return;
    setSubmitting(true);
    setFailed(false);
    try {
      await onReport(reason);
      setOpen(false);
      setReason(null);
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "relative grid h-7 w-7 place-items-center rounded-md border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          reported
            ? "border-transparent bg-[color:var(--app-accent)]/10 text-[color:var(--app-accent)]"
            : "border-transparent text-[rgba(0,0,0,0.46)] hover:border-black/10 hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:text-zinc-500 dark:hover:border-white/10 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200",
        )}
        aria-label={reported ? "Response reported" : "Report response"}
        title={reported ? "Reported" : "Report response"}
        data-testid="agent-response-report"
      >
        <Flag className="h-3.5 w-3.5" weight={reported ? "fill" : "regular"} />
        <MaterialRipple variant="none" effect="glass" />
      </button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Report this response</DialogTitle>
            <DialogDescription>
              Tell the Hussh team what is wrong with this answer. We review every
              report. Your conversation stays private.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup
            aria-labelledby={`${groupId}-label`}
            value={reason ?? ""}
            onValueChange={(value) =>
              setReason(value as AgentResponseReportReason)
            }
            className="gap-1"
          >
            <span id={`${groupId}-label`} className="sr-only">
              Reason
            </span>
            {AGENT_RESPONSE_REPORT_REASONS.map((option) => {
              const itemId = `${groupId}-${option.value}`;
              return (
                <label
                  key={option.value}
                  htmlFor={itemId}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                  <RadioGroupItem id={itemId} value={option.value} />
                  {option.label}
                </label>
              );
            })}
          </RadioGroup>
          {failed ? (
            <p role="alert" className="text-sm text-destructive">
              Could not send the report. Check your connection and try again.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => close(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={!reason || submitting}
            >
              {submitting ? "Sending…" : failed ? "Try again" : "Send report"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

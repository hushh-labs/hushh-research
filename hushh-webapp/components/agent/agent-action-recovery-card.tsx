"use client";

import { useId } from "react";
import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AgentActionRecoveryPlan } from "@/lib/agent/agent-action-recovery-plan";

type AgentActionRecoveryCardProps = {
  plan: AgentActionRecoveryPlan;
  onContinue: () => void;
  onCancel: () => void;
  isContinuing?: boolean;
};

export function AgentActionRecoveryCard({
  plan,
  onContinue,
  onCancel,
  isContinuing = false,
}: AgentActionRecoveryCardProps) {
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      aria-busy={isContinuing}
      className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
          aria-hidden="true"
        >
          <ShieldCheck className="size-5" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recovery review
          </p>

          <h3
            id={titleId}
            className="mt-1 text-base font-semibold text-foreground"
          >
            {plan.title}
          </h3>

          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {plan.summary}
          </p>
        </div>
      </div>

      {plan.requiresFreshConsent ? (
        <div className="mt-4 rounded-xl border border-border/70 bg-muted/40 px-3 py-2">
          <p className="text-sm font-medium text-foreground">
            Fresh approval required
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            One will not run this recovery until you review and approve it.
          </p>
        </div>
      ) : null}

      <ol
        aria-label="Recovery steps"
        className="mt-4 space-y-3"
      >
        {plan.steps.map((step, index) => (
          <li
            key={step.id}
            className="flex items-start gap-3 text-sm text-foreground"
          >
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium"
              aria-hidden="true"
            >
              {index + 1}
            </span>

            <span className="pt-0.5 leading-5">{step.label}</span>
          </li>
        ))}
      </ol>

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={isContinuing}
        >
          Cancel
        </Button>

        <Button
          onClick={onContinue}
          isLoading={isContinuing}
          disabled={isContinuing}
        >
          Review and continue
        </Button>
      </div>
    </section>
  );
}

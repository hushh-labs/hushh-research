"use client";

import { Briefcase, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

const OPTIONS = [
  {
    value: "individual" as const,
    icon: Briefcase,
    title: "Individual RIA",
    description:
      "You manage client portfolios independently under your own registration.",
  },
  {
    value: "firm" as const,
    icon: Building2,
    title: "Firm / Practice",
    description:
      "You represent a registered firm or multi-advisor practice.",
  },
];

export function OnboardingStepWelcome({
  onboardingType,
  onSelect,
}: {
  onboardingType: "" | "individual" | "firm";
  onSelect: (type: "individual" | "firm") => void;
}) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-border/60 bg-card/80 shadow-[0_12px_34px_rgba(15,23,42,0.06)] backdrop-blur dark:bg-card/55 dark:shadow-none">
      {OPTIONS.map((option) => {
        const selected = onboardingType === option.value;
        const Icon = option.icon;

        return (
          <div key={option.value}>
            <button
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(option.value)}
              className={cn(
                "relative flex min-h-[92px] w-full items-center gap-4 px-4 py-4 text-left transition-colors sm:px-5",
                selected ? "bg-primary/10" : "hover:bg-muted/45"
              )}
            >
              <span
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px]",
                  selected
                    ? "bg-primary/15 text-primary"
                    : "bg-muted/55 text-muted-foreground"
                )}
              >
                <Icon className="h-5 w-5" />
              </span>

              <span className="min-w-0 flex-1 space-y-1">
                <span className="block text-[17px] font-semibold leading-6 text-foreground">
                  {option.title}
                </span>
                <span className="block text-[15px] leading-6 text-muted-foreground">
                  {option.description}
                </span>
              </span>

              <span
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                  selected ? "border-primary" : "border-muted-foreground/35"
                )}
              >
                {selected ? (
                  <span className="h-3.5 w-3.5 rounded-full bg-primary" />
                ) : null}
              </span>
            </button>
            {option.value !== OPTIONS[OPTIONS.length - 1]?.value ? (
              <div className="ml-[5.5rem] h-px bg-border/50" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

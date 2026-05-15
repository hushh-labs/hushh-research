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
    <div className="flex flex-col gap-4">
      {OPTIONS.map((option) => {
        const selected = onboardingType === option.value;
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(option.value)}
            className={cn(
              "relative flex w-full items-start gap-4 rounded-[28px] border p-5 text-left backdrop-blur-xl transition-all",
              selected
                ? "border-[#0071E3] bg-[#0071E3]/5 shadow-lg"
                : "border-border/70 bg-background/75 hover:border-border"
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl",
                selected
                  ? "bg-[#0071E3]/10 text-[#0071E3]"
                  : "bg-muted/40 text-muted-foreground"
              )}
            >
              <Icon className="h-5 w-5" />
            </span>

            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-[15px] font-semibold text-foreground">
                {option.title}
              </p>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {option.description}
              </p>
            </div>

            <span
              className={cn(
                "mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                selected
                  ? "border-[#0071E3]"
                  : "border-muted-foreground/40"
              )}
            >
              {selected ? (
                <span className="h-3 w-3 rounded-full bg-[#0071E3]" />
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

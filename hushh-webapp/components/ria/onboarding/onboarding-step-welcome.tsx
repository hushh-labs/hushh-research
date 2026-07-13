"use client";

import { User, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { RiaSelectControl } from "@/components/ria/ui/ria-primitives";

const OPTIONS: {
  value: "individual" | "firm";
  icon: LucideIcon;
  title: string;
  description: string;
}[] = [
  {
    value: "individual",
    icon: User,
    title: "Individual RIA",
    description: "Work independently under your own registration.",
  },
  {
    value: "firm",
    icon: Users,
    title: "Firm / Practice",
    description: "Represent a firm or multi-advisor practice.",
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
    <div className="flex flex-col gap-[14px]">
      {OPTIONS.map((option) => {
        const selected = onboardingType === option.value;
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(option.value)}
            className="relative flex min-h-[98px] items-center gap-[14px] rounded-[22px] p-4 text-left transition-transform active:scale-[0.995]"
            style={
              selected
                ? {
                    background:
                      "linear-gradient(135deg, #FFFDF8, #F7E8CE)",
                    border: "1.5px solid rgba(201,139,46,0.55)",
                    boxShadow: "0 10px 26px rgba(120,88,40,0.10)",
                  }
                : {
                    background: "var(--ria-surface)",
                    border: "1px solid var(--ria-divider-outer)",
                    boxShadow: "0 6px 20px rgba(62,48,30,0.045)",
                  }
            }
          >
            <span
              className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full"
              style={{
                backgroundColor: selected ? "rgba(255,255,255,0.6)" : "#F1ECE4",
              }}
            >
              <Icon
                className="h-[22px] w-[22px]"
                strokeWidth={1.8}
                style={{ color: selected ? "var(--ria-gold)" : "#A6A29A" }}
              />
            </span>

            <span className="min-w-0 flex-1">
              <span
                className="block text-[17px] font-semibold leading-6 text-[color:var(--ria-ink)]"
                style={{ letterSpacing: "-0.2px" }}
              >
                {option.title}
              </span>
              <span className="mt-[3px] block text-[15px] leading-[1.34] text-[color:var(--ria-muted)]">
                {option.description}
              </span>
            </span>

            <RiaSelectControl checked={selected} variant="radio" />
          </button>
        );
      })}
    </div>
  );
}

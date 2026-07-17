"use client";

import { User, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";

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
    <SettingsGroup embedded separatorInset>
      {OPTIONS.map((option) => {
        const selected = onboardingType === option.value;
        return (
          <SettingsRow
            key={option.value}
            icon={option.icon}
            iconTone={selected ? "blue" : "gray"}
            title={option.title}
            description={option.description}
            onClick={() => onSelect(option.value)}
            trailing={
              <div
                className="h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors"
                style={{
                  borderColor: selected ? "var(--app-accent)" : "var(--muted-foreground)",
                  opacity: selected ? 1 : 0.4
                }}
              >
                {selected && <div className="h-2.5 w-2.5 rounded-full bg-[color:var(--app-accent)]" />}
              </div>
            }
          />
        );
      })}
    </SettingsGroup>
  );
}

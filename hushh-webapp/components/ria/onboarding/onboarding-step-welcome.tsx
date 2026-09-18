"use client";

import { Phone, User, Users } from "@/components/icons";
import type { LucideIcon } from "@/components/icons";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SectionLabel as AppSectionLabel } from "@/components/app-ui/typography";
import { buildRiaClaimRoute } from "@/lib/ria/ria-claim-entry";

/** Section label that follows the shared readable settings scale. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <AppSectionLabel as="p" className="block px-[6px]">
      {children}
    </AppSectionLabel>
  );
}

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentRoute = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  const selectedOption = OPTIONS.find((option) => option.value === onboardingType);
  return (
    <div className="space-y-5">
      <div className="space-y-2.5">
        <SectionLabel>Registration type</SectionLabel>
        <div
          role="radiogroup"
          aria-label="Registration type"
          className="flex gap-[9px]"
        >
          {OPTIONS.map((option) => {
            const selected = onboardingType === option.value;
            const Icon = option.icon;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onSelect(option.value)}
                className="flex h-[46px] flex-1 items-center justify-center gap-2 rounded-[16px] border text-[14px] transition-colors"
                style={
                  selected
                    ? {
                        background: "var(--app-accent-tint)",
                        borderColor: "var(--app-accent)",
                        borderWidth: "1.5px",
                        color: "var(--app-accent)",
                        fontWeight: 600,
                      }
                    : {
                        background: "var(--card)",
                        borderColor: "var(--ria-divider-outer)",
                        color: "var(--ria-ink)",
                        fontWeight: 500,
                      }
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {option.title}
              </button>
            );
          })}
        </div>
        {selectedOption ? (
          <p className="px-[6px] text-[13px] leading-5 text-muted-foreground">
            {selectedOption.description}
          </p>
        ) : null}
      </div>

      <SettingsGroup embedded separatorInset>
        <SettingsRow
          icon={Phone}
          iconTone="gray"
          title="Claim your profile"
          description="Use the office number on your SEC filing."
          chevron
          onClick={() => router.push(buildRiaClaimRoute("", { returnTo: currentRoute }))}
        />
      </SettingsGroup>
    </div>
  );
}

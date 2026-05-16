"use client";

import {
  BarChart3,
  FileText,
  Landmark,
  ScrollText,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const AVAILABLE_SERVICES: { label: string; icon: LucideIcon }[] = [
  { label: "Portfolio Management", icon: BarChart3 },
  { label: "Retirement Planning", icon: Landmark },
  { label: "Tax Planning", icon: FileText },
  { label: "Estate Planning", icon: ScrollText },
];

const FEE_OPTIONS = ["Fee-only", "AUM %", "Flat", "Hourly"];

export function OnboardingStepServices({
  servicesOffered,
  feeStructure,
  minEngagementAmount,
  bio,
  onServicesChange,
  onFeeStructureChange,
  onMinEngagementChange,
  onBioChange,
}: {
  servicesOffered: string[];
  feeStructure: string[];
  minEngagementAmount: string;
  bio: string;
  onServicesChange: (services: string[]) => void;
  onFeeStructureChange: (fees: string[]) => void;
  onMinEngagementChange: (value: string) => void;
  onBioChange: (value: string) => void;
}) {
  function toggleService(label: string) {
    if (servicesOffered.includes(label)) {
      onServicesChange(servicesOffered.filter((s) => s !== label));
    } else {
      onServicesChange([...servicesOffered, label]);
    }
  }

  function toggleFee(fee: string) {
    if (feeStructure.includes(fee)) {
      onFeeStructureChange(feeStructure.filter((f) => f !== fee));
    } else {
      onFeeStructureChange([...feeStructure, fee]);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Services
        </p>
        <div className="grid grid-cols-2 gap-3">
          {AVAILABLE_SERVICES.map(({ label, icon: Icon }) => {
            const selected = servicesOffered.includes(label);
            return (
              <button
                key={label}
                type="button"
                onClick={() => toggleService(label)}
                className={cn(
                  "rounded-[20px] border p-4 text-center cursor-pointer transition-colors",
                  selected
                    ? "border-[#0071E3] bg-[#0071E3]/5"
                    : "border-border/70 bg-background/75 hover:bg-muted/20"
                )}
              >
                <Icon
                  className={cn(
                    "mx-auto mb-2 h-5 w-5",
                    selected ? "text-[#0071E3]" : "text-muted-foreground"
                  )}
                />
                <span className="text-sm font-medium text-foreground">
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Fee Structure
        </p>
        <div className="flex flex-wrap gap-2">
          {FEE_OPTIONS.map((fee) => {
            const selected = feeStructure.includes(fee);
            return (
              <button
                key={fee}
                type="button"
                onClick={() => toggleFee(fee)}
                className={cn(
                  "rounded-full border px-4 py-2 text-sm cursor-pointer transition-colors",
                  selected
                    ? "bg-[#0071E3] text-white border-[#0071E3]"
                    : "border-border/70 text-foreground hover:bg-muted/20"
                )}
              >
                {fee}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Min. Engagement
        </label>
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            $
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={minEngagementAmount}
            onChange={(e) => onMinEngagementChange(e.target.value)}
            placeholder="250,000"
            className="w-full rounded-[22px] border border-border/70 bg-background/75 py-2.5 pl-8 pr-4 text-sm text-foreground outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/30 transition-colors"
          />
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Short Bio
        </label>
        <textarea
          rows={4}
          value={bio}
          onChange={(e) => onBioChange(e.target.value)}
          placeholder="Briefly describe your approach..."
          className="w-full rounded-[22px] border border-border/70 bg-background/75 px-4 py-3 text-sm text-foreground outline-none resize-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/30 transition-colors"
        />
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[#0071E3]/30 text-[#0071E3] text-sm px-3 py-1.5 cursor-pointer hover:bg-[#0071E3]/5 transition-colors"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Ask Kai to generate a bio based on your self...
        </button>
      </div>
    </div>
  );
}

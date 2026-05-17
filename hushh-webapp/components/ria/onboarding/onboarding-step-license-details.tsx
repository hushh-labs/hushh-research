"use client";

import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

type StatusTone = "green" | "amber" | "red" | "gray";

function resolveStatusTone(status: string): StatusTone {
  const normalized = status.toLowerCase().trim();
  if (
    normalized === "active" ||
    normalized === "currently registered"
  )
    return "green";
  if (normalized === "inactive") return "amber";
  if (normalized === "barred") return "red";
  return "gray";
}

const STATUS_TONE_STYLES: Record<StatusTone, { pill: string; dot: string }> = {
  green: {
    pill: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  amber: {
    pill: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  red: {
    pill: "bg-red-500/15 text-red-700 dark:text-red-300",
    dot: "bg-red-500",
  },
  gray: {
    pill: "bg-muted/60 text-muted-foreground",
    dot: "bg-muted-foreground/60",
  },
};

function EnrichingPlaceholder() {
  return <div className="animate-pulse bg-muted/40 rounded h-5 w-32" />;
}

export function OnboardingStepLicenseDetails({
  advisorName,
  firmName,
  regulator,
  regulatorStatus,
  licenseExpiry,
  certifications,
  city,
  pinZip,
  crdNumber,
  onAdvisorNameChange,
  onCityChange,
  onPinZipChange,
  isEnriching,
}: {
  advisorName: string;
  firmName: string;
  regulator: string;
  regulatorStatus: string;
  licenseExpiry: string;
  certifications: string[];
  city: string;
  pinZip: string;
  crdNumber: string;
  onAdvisorNameChange: (value: string) => void;
  onCityChange: (value: string) => void;
  onPinZipChange: (value: string) => void;
  isEnriching: boolean;
}) {
  const tone = resolveStatusTone(regulatorStatus);
  const toneStyles = STATUS_TONE_STYLES[tone];

  return (
    <div className="space-y-5">
      <div className="flex items-center">
        <span
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5",
            toneStyles.pill
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", toneStyles.dot)} />
          {regulator} &mdash; {regulatorStatus}
        </span>
      </div>

      <div className="space-y-1.5">
        <label className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Advisor Name
        </label>
        <div className="relative">
          <input
            type="text"
            value={advisorName}
            onChange={(e) => onAdvisorNameChange(e.target.value)}
            className="w-full rounded-[22px] border border-border/70 bg-background/75 px-4 py-2.5 pr-10 text-sm text-foreground outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/30 transition-colors"
          />
          <Pencil className="absolute right-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Firm
        </p>
        {isEnriching && !firmName ? (
          <EnrichingPlaceholder />
        ) : (
          <p className="text-sm text-foreground">{firmName}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Expiry
          </p>
          <p className="text-sm text-foreground">{licenseExpiry}</p>
        </div>

        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Certifications
          </p>
          {isEnriching && certifications.length === 0 ? (
            <EnrichingPlaceholder />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {certifications.map((cert) => (
                <span
                  key={cert}
                  className="rounded-full border border-border/70 px-2.5 py-1 text-xs text-foreground"
                >
                  {cert}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          CRD
        </p>
        <p className="text-sm text-foreground">{crdNumber}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            City
          </label>
          {isEnriching && !city ? (
            <EnrichingPlaceholder />
          ) : (
            <input
              type="text"
              value={city}
              onChange={(e) => onCityChange(e.target.value)}
              className="w-full rounded-[22px] border border-border/70 bg-background/75 px-4 py-2.5 text-sm text-foreground outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/30 transition-colors"
            />
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Pin / Zip
          </label>
          <input
            type="text"
            value={pinZip}
            onChange={(e) => onPinZipChange(e.target.value)}
            className="w-full rounded-[22px] border border-border/70 bg-background/75 px-4 py-2.5 text-sm text-foreground outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/30 transition-colors"
          />
        </div>
      </div>
    </div>
  );
}

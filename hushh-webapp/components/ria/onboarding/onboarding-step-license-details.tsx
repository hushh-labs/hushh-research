"use client";

import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

type StatusTone = "green" | "amber" | "red" | "gray";

function resolveStatusTone(status: string): StatusTone {
  const normalized = status.toLowerCase().trim();
  if (normalized === "active" || normalized === "currently registered") {
    return "green";
  }
  if (normalized === "inactive") return "amber";
  if (normalized === "barred") return "red";
  return "gray";
}

const STATUS_TONE_STYLES: Record<StatusTone, string> = {
  green: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  amber: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  red: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
  gray: "border-border/60 bg-muted/45 text-muted-foreground",
};

function EnrichingPlaceholder() {
  return <span className="h-5 w-28 animate-pulse rounded bg-muted/50" />;
}

function GroupShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-border/60 bg-card/80 shadow-[0_12px_34px_rgba(15,23,42,0.06)] backdrop-blur dark:bg-card/55 dark:shadow-none">
      {children}
    </div>
  );
}

function Divider() {
  return <div className="ml-4 h-px bg-border/50 sm:ml-5" />;
}

function InfoRow({
  label,
  value,
  loading,
}: {
  label: string;
  value?: string | null;
  loading?: boolean;
}) {
  return (
    <div className="flex min-h-[52px] items-center gap-4 px-4 py-2 sm:px-5">
      <span className="shrink-0 text-[15px] text-muted-foreground">{label}</span>
      <span className="ml-auto min-w-0 text-right text-[15px] leading-6 text-foreground">
        {loading ? <EnrichingPlaceholder /> : value?.trim() || "Not returned"}
      </span>
    </div>
  );
}

function EditableRow({
  label,
  value,
  onChange,
  loading,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
}) {
  return (
    <label className="flex min-h-[52px] items-center gap-4 px-4 py-2 sm:px-5">
      <span className="shrink-0 text-[15px] text-muted-foreground">{label}</span>
      {loading ? (
        <span className="ml-auto">
          <EnrichingPlaceholder />
        </span>
      ) : (
        <span className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
          <input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-right text-[15px] text-foreground outline-none placeholder:text-muted-foreground/55"
          />
          <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        </span>
      )}
    </label>
  );
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
  const certificationLabel =
    certifications.length > 0 ? certifications.join(", ") : "Not returned";

  return (
    <div className="space-y-4">
      <div
        className={cn(
          "inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-semibold",
          STATUS_TONE_STYLES[tone]
        )}
      >
        {regulator || "Regulator"} - {regulatorStatus || "Status pending"}
      </div>

      <GroupShell>
        <EditableRow
          label="Advisor"
          value={advisorName}
          onChange={onAdvisorNameChange}
        />
        <Divider />
        <InfoRow label="Firm" value={firmName} loading={isEnriching && !firmName} />
        <Divider />
        <InfoRow label="CRD" value={crdNumber} />
      </GroupShell>

      <GroupShell>
        <InfoRow label="Expiry" value={licenseExpiry} />
        <Divider />
        <InfoRow
          label="Certifications"
          value={certificationLabel}
          loading={isEnriching && certifications.length === 0}
        />
      </GroupShell>

      <GroupShell>
        <EditableRow
          label="City"
          value={city}
          onChange={onCityChange}
          loading={isEnriching && !city}
        />
        <Divider />
        <EditableRow label="Pin / Zip" value={pinZip} onChange={onPinZipChange} />
      </GroupShell>
    </div>
  );
}

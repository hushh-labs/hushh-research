"use client";

import { Pencil, Shield } from "lucide-react";
import { cn } from "@/lib/utils";

function EnrichingPlaceholder() {
  return <span className="h-5 w-28 animate-pulse rounded bg-muted/50" />;
}

function GroupShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[22px] border border-[color:var(--ria-divider-outer)] bg-[color:var(--card)] shadow-[0_8px_24px_rgba(62,48,30,0.05)]">
      {children}
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-[color:var(--ria-divider-inner)]" />;
}

function InfoRow({
  label,
  value,
  loading,
  numeric,
}: {
  label: string;
  value?: string | null;
  loading?: boolean;
  numeric?: boolean;
}) {
  return (
    <div className="flex min-h-[64px] items-center gap-4 px-[18px] py-2">
      <span className="shrink-0 text-[15px] text-[color:var(--ria-muted)]">{label}</span>
      <span
        className={cn(
          "ml-auto min-w-0 text-right text-[16px] font-medium leading-6 text-[color:var(--ria-ink)]",
          numeric && "tabular-nums"
        )}
      >
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
  numeric,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
  numeric?: boolean;
}) {
  return (
    <label className="flex min-h-[64px] items-center gap-4 px-[18px] py-2">
      <span className="shrink-0 text-[15px] text-[color:var(--ria-muted)]">{label}</span>
      {loading ? (
        <span className="ml-auto">
          <EnrichingPlaceholder />
        </span>
      ) : (
        <span className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2.5">
          <input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className={cn(
              "min-w-0 flex-1 bg-transparent text-right text-[16px] font-medium text-[color:var(--ria-ink)] outline-none placeholder:text-[color:var(--ria-faint)]",
              numeric && "tabular-nums"
            )}
          />
          <Pencil
            className="h-[18px] w-[18px] shrink-0 text-[color:var(--ria-gold)]"
            strokeWidth={1.8}
          />
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
  const certificationLabel =
    certifications.length > 0 ? certifications.join(", ") : "Not returned";
  const regulatorLine =
    regulator || regulatorStatus
      ? `${regulator || "Regulator"} - ${regulatorStatus || "Status pending"}`
      : "Regulator status pending";

  return (
    <div className="space-y-4">
      {/* Regulator shield card (full-width, replaces the old status pill). */}
      <div className="flex min-h-[50px] items-center gap-[11px] rounded-[16px] border border-[color:var(--ria-divider-outer)] bg-[color:var(--card)] px-4 shadow-[0_4px_14px_rgba(62,48,30,0.05)]">
        <Shield
          className="h-[19px] w-[19px] shrink-0 text-[color:var(--ria-ink)]"
          strokeWidth={1.7}
        />
        <span className="text-[14px] font-medium leading-[1.3] text-[color:var(--ria-ink)]">
          {regulatorLine}
        </span>
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
        <InfoRow label="CRD" value={crdNumber} numeric />
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
        <EditableRow
          label="Pin / Zip"
          value={pinZip}
          onChange={onPinZipChange}
          numeric
        />
      </GroupShell>
    </div>
  );
}

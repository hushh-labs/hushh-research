"use client";

import { Pencil, Shield } from "lucide-react";
import { cn } from "@/lib/utils";

function EnrichingPlaceholder() {
  return <span className="h-5 w-28 animate-pulse rounded bg-muted/50" />;
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
    <SettingsRow
      title={<span className="whitespace-nowrap">{label}</span>}
      trailing={
        <span className={cn("text-[15px] font-medium text-foreground", numeric && "tabular-nums")}>
          {loading ? <EnrichingPlaceholder /> : value?.trim() || "Not returned"}
        </span>
      }
    />
  );
}

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";

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
    <SettingsRow
      title={<span className="whitespace-nowrap">{label}</span>}
      trailing={
        loading ? (
          <EnrichingPlaceholder />
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className={cn("bg-transparent min-w-[120px] max-w-[200px] text-right text-[15px] outline-none text-foreground placeholder:text-muted-foreground", numeric && "tabular-nums")}
            />
            <Pencil className="h-4 w-4 shrink-0 text-muted-foreground" />
          </div>
        )
      }
    />
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
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-background/80 p-4 shadow-sm backdrop-blur-md">
        <Shield
          className="h-[19px] w-[19px] shrink-0 text-foreground"
          strokeWidth={1.7}
        />
        <span className="text-[14px] font-medium leading-[1.3] text-foreground">
          {regulatorLine}
        </span>
      </div>

      <SettingsGroup embedded separatorInset>
        <EditableRow
          label="Advisor"
          value={advisorName}
          onChange={onAdvisorNameChange}
        />

        <InfoRow label="Firm" value={firmName} loading={isEnriching && !firmName} />

        <InfoRow label="CRD" value={crdNumber} numeric />
      </SettingsGroup>

      <SettingsGroup embedded separatorInset>
        <InfoRow label="Expiry" value={licenseExpiry} />

        <InfoRow
          label="Certifications"
          value={certificationLabel}
          loading={isEnriching && certifications.length === 0}
        />
      </SettingsGroup>

      <SettingsGroup embedded separatorInset>
        <EditableRow
          label="City"
          value={city}
          onChange={onCityChange}
          loading={isEnriching && !city}
        />

        <EditableRow
          label="Pin / Zip"
          value={pinZip}
          onChange={onPinZipChange}
          numeric
        />
      </SettingsGroup>
    </div>
  );
}

"use client";

import {
  BarChart3,
  FileText,
  Landmark,
  MapPin,
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
      {children}
    </p>
  );
}

function TextRow({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
  prefix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "numeric" | "text";
  prefix?: string;
}) {
  return (
    <label className="flex min-h-[54px] items-center gap-4 px-4 py-2 sm:px-5">
      <span className="shrink-0 text-[15px] text-muted-foreground">{label}</span>
      <span className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1">
        {prefix ? (
          <span className="text-[15px] text-muted-foreground">{prefix}</span>
        ) : null}
        <input
          type="text"
          inputMode={inputMode}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-transparent text-right text-[15px] text-foreground outline-none placeholder:text-muted-foreground/55"
        />
      </span>
    </label>
  );
}

export function OnboardingStepServices({
  servicesOffered,
  feeStructure,
  minEngagementAmount,
  bio,
  city,
  areaLocality,
  fullStreetAddress,
  pinZip,
  onServicesChange,
  onFeeStructureChange,
  onMinEngagementChange,
  onBioChange,
  onCityChange,
  onAreaLocalityChange,
  onFullStreetAddressChange,
  onPinZipChange,
}: {
  servicesOffered: string[];
  feeStructure: string[];
  minEngagementAmount: string;
  bio: string;
  city: string;
  areaLocality: string;
  fullStreetAddress: string;
  pinZip: string;
  onServicesChange: (services: string[]) => void;
  onFeeStructureChange: (fees: string[]) => void;
  onMinEngagementChange: (value: string) => void;
  onBioChange: (value: string) => void;
  onCityChange: (value: string) => void;
  onAreaLocalityChange: (value: string) => void;
  onFullStreetAddressChange: (value: string) => void;
  onPinZipChange: (value: string) => void;
}) {
  const mapAddress = [fullStreetAddress, areaLocality, city, pinZip]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
  const mapPreviewSrc = mapAddress
    ? `https://www.google.com/maps?q=${encodeURIComponent(mapAddress)}&output=embed`
    : "";

  function toggleService(label: string) {
    if (servicesOffered.includes(label)) {
      onServicesChange(servicesOffered.filter((service) => service !== label));
      return;
    }
    onServicesChange([...servicesOffered, label]);
  }

  function toggleFee(fee: string) {
    if (feeStructure.includes(fee)) {
      onFeeStructureChange(feeStructure.filter((item) => item !== fee));
      return;
    }
    onFeeStructureChange([...feeStructure, fee]);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionLabel>Services</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {AVAILABLE_SERVICES.map(({ label, icon: Icon }) => {
            const selected = servicesOffered.includes(label);
            return (
              <button
                key={label}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleService(label)}
                className={cn(
                  "flex min-h-[82px] items-center gap-3 rounded-[22px] border px-4 py-3 text-left transition-colors",
                  selected
                    ? "border-primary/55 bg-primary/10 text-primary"
                    : "border-border/60 bg-card/80 text-foreground hover:bg-muted/45 dark:bg-card/55"
                )}
              >
                <span
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px]",
                    selected ? "bg-primary/15" : "bg-muted/55 text-muted-foreground"
                  )}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 text-[15px] font-semibold leading-5">
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3">
        <SectionLabel>Fee Structure</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {FEE_OPTIONS.map((fee) => {
            const selected = feeStructure.includes(fee);
            return (
              <button
                key={fee}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleFee(fee)}
                className={cn(
                  "rounded-full border px-4 py-2 text-[15px] font-medium transition-colors",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border/60 bg-card/70 text-foreground hover:bg-muted/45 dark:bg-card/45"
                )}
              >
                {fee}
              </button>
            );
          })}
        </div>
      </div>

      <GroupShell>
        <TextRow
          label="Min. Engagement"
          value={minEngagementAmount}
          onChange={onMinEngagementChange}
          placeholder="250,000"
          inputMode="numeric"
          prefix="$"
        />
      </GroupShell>

      <div className="space-y-3">
        <SectionLabel>Short Bio</SectionLabel>
        <textarea
          rows={4}
          value={bio}
          onChange={(event) => onBioChange(event.target.value)}
          placeholder="Briefly describe your approach..."
          className="w-full resize-none rounded-[24px] border border-border/60 bg-card/80 px-4 py-3 text-[15px] leading-6 text-foreground shadow-[0_12px_34px_rgba(15,23,42,0.06)] outline-none transition-colors placeholder:text-muted-foreground/55 focus:border-primary/70 dark:bg-card/55 dark:shadow-none"
        />
        <button
          type="button"
          className="inline-flex min-h-9 items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3.5 text-sm font-medium text-primary transition-colors hover:bg-primary/15"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Ask Kai to draft a bio
        </button>
      </div>

      <div className="space-y-3">
        <SectionLabel>Business Location</SectionLabel>
        <GroupShell>
          <TextRow
            label="Street"
            value={fullStreetAddress}
            onChange={onFullStreetAddressChange}
            placeholder="Building, floor, street"
          />
          <Divider />
          <TextRow
            label="Area"
            value={areaLocality}
            onChange={onAreaLocalityChange}
            placeholder="Area or state"
          />
          <Divider />
          <TextRow
            label="City"
            value={city}
            onChange={onCityChange}
            placeholder="City"
          />
          <Divider />
          <TextRow
            label="Pin / ZIP"
            value={pinZip}
            onChange={onPinZipChange}
            placeholder="PIN / ZIP"
            inputMode="numeric"
          />
        </GroupShell>

        <div className="relative h-44 overflow-hidden rounded-[24px] border border-border/60 bg-card/70 dark:bg-card/45">
          {mapPreviewSrc ? (
            <iframe
              title="Business location map preview"
              src={mapPreviewSrc}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="h-full w-full border-0"
            />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 text-[15px] text-muted-foreground">
              <MapPin className="h-4 w-4" />
              <span>Map preview</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

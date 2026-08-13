"use client";

import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  FileText,
  Landmark,
  MapPin,
  ScrollText,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { SectionLabel as AppSectionLabel } from "@/components/app-ui/typography";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { RiaAiActionPill } from "@/components/ria/ui/ria-primitives";

const AVAILABLE_SERVICES: { label: string; icon: LucideIcon }[] = [
  { label: "Portfolio Management", icon: BarChart3 },
  { label: "Retirement Planning", icon: Landmark },
  { label: "Tax Planning", icon: FileText },
  { label: "Estate Planning", icon: ScrollText },
];

const FEE_OPTIONS = ["Fee-only", "AUM %", "Flat", "Hourly"];



/** Section label that follows the shared readable settings scale. */
function SectionLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <AppSectionLabel
      as={htmlFor ? "label" : "p"}
      htmlFor={htmlFor}
      className="block px-[6px]"
    >
      {children}
    </AppSectionLabel>
  );
}

function TextRow({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
  prefix,
  autoComplete,
  dense,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "numeric" | "text";
  prefix?: string;
  autoComplete?: string;
  dense?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-4 px-[18px] py-2",
        dense ? "min-h-[46px]" : "min-h-[56px]"
      )}
    >
      <span
        className={cn(
          "shrink-0 text-[color:var(--ria-muted)]",
          dense ? "text-[14px]" : "text-[16px]"
        )}
      >
        {label}
      </span>
      <span className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1">
        {prefix ? (
          <span className="text-[color:var(--ria-faint)]">{prefix}</span>
        ) : null}
        <input
          type="text"
          inputMode={inputMode}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-right font-medium text-foreground outline-none placeholder:text-[color:var(--ria-faint)]",
            dense ? "text-[14px]" : "text-[16px]",
            inputMode === "numeric" && "tabular-nums"
          )}
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
  onDraftBio,
  staticMapPreviewSrc,
  validateTick = 0,
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
  onDraftBio: () => void;
  staticMapPreviewSrc?: string;
  // Incremented by the wizard when the user taps Continue with a required field
  // (services / fees) still empty. Drives scroll-to-field + inline validation.
  validateTick?: number;
}) {
  const servicesRef = useRef<HTMLDivElement | null>(null);
  const feeRef = useRef<HTMLDivElement | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [bioEditing, setBioEditing] = useState(false);

  const needsService = servicesOffered.length === 0;
  const needsFee = feeStructure.length === 0;
  const hasBio = bio.trim().length > 0;

  useEffect(() => {
    if (!validateTick) return;
    setAttempted(true);
    // Scroll to the first unfilled required field so the reason is on screen.
    const target = servicesOffered.length === 0 ? servicesRef : feeRef;
    target.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // servicesOffered/feeStructure are intentionally omitted: only a fresh tap
    // (validateTick bump) should re-scroll, not every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validateTick]);

  const showServiceError = attempted && needsService;
  const showFeeError = attempted && needsFee;

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
    <div className="space-y-[22px]">
      <div ref={servicesRef} className="space-y-3">
        <div
          role="group"
          aria-label="Services offered"
          className="overflow-hidden rounded-[22px] border border-[color:var(--ria-divider-outer)] bg-[color:var(--card)] shadow-[0_8px_24px_rgba(62,48,30,0.05)]"
        >
          {AVAILABLE_SERVICES.map(({ label, icon: Icon }, i) => {
            const selected = servicesOffered.includes(label);
            return (
              <label
                key={label}
                htmlFor={`ria-service-${label.toLowerCase().replaceAll(" ", "-")}`}
                className="flex min-h-[60px] w-full cursor-pointer items-center gap-[14px] px-[18px] py-3 text-left"
                style={
                  i > 0
                    ? { borderTop: "1px solid var(--ria-divider-inner)" }
                    : undefined
                }
              >
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px]"
                  style={{ backgroundColor: "var(--ria-nav-active)" }}
                >
                  <Icon
                    className="h-[23px] w-[23px]"
                    strokeWidth={1.8}
                    style={{ color: "var(--ria-gold)" }}
                  />
                </span>
                <span className="min-w-0 flex-1 text-[16px] font-medium leading-5 text-foreground">
                  {label}
                </span>
                <Checkbox
                  id={`ria-service-${label.toLowerCase().replaceAll(" ", "-")}`}
                  checked={selected}
                  onCheckedChange={() => toggleService(label)}
                  className="h-[26px] w-[26px] rounded-[7px] border-2 border-[color:var(--ria-select-border)] bg-transparent shadow-none data-[state=checked]:border-[color:var(--ria-select-fill)] data-[state=checked]:bg-[color:var(--ria-select-fill)] data-[state=checked]:text-white"
                />
              </label>
            );
          })}
        </div>
        {showServiceError ? (
          <p
            role="alert"
            className="text-[13px] leading-5 text-amber-600 dark:text-amber-400"
          >
            Select at least one service to continue.
          </p>
        ) : null}
      </div>

      <div ref={feeRef} className="space-y-3">
        <SectionLabel>Fee Structure</SectionLabel>
        <div role="group" aria-label="Fee structure" className="flex gap-[9px]">
          {FEE_OPTIONS.map((fee) => {
            const selected = feeStructure.includes(fee);
            return (
              <button
                key={fee}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleFee(fee)}
                className="flex h-[46px] flex-1 items-center justify-center rounded-[16px] border text-[14px] transition-colors"
                style={
                  selected
                    ? {
                        background: "var(--card)",
                        borderColor: "var(--ria-fee-active)",
                        borderWidth: "1.5px",
                        color: "var(--ria-fee-active)",
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
                {fee}
              </button>
            );
          })}
        </div>
        {showFeeError ? (
          <p
            role="alert"
            className="text-[13px] leading-5 text-amber-600 dark:text-amber-400"
          >
            Select at least one fee structure to continue.
          </p>
        ) : null}
      </div>

      <div className="flex h-[56px] items-center rounded-[16px] border border-[color:var(--ria-divider-outer)] bg-[color:var(--card)] px-[18px]">
        <span className="text-[16px] text-[color:var(--ria-muted)]">
          Min. Engagement
        </span>
        <span className="ml-auto pr-2.5 text-[16px] text-[color:var(--ria-faint)]">
          $
        </span>
        <input
          type="text"
          inputMode="numeric"
          value={minEngagementAmount}
          onChange={(event) => onMinEngagementChange(event.target.value)}
          placeholder="250,000"
          className="w-24 bg-transparent text-right text-[16px] font-medium tabular-nums text-foreground outline-none placeholder:text-[color:var(--ria-faint)]"
        />
      </div>

      <div className="space-y-3">
        <SectionLabel htmlFor="ria-bio">Short Bio</SectionLabel>
        <RiaAiActionPill onClick={onDraftBio}>
          Ask Kai to draft a bio
        </RiaAiActionPill>
        {hasBio && !bioEditing ? (
          <button
            type="button"
            aria-label="Edit short bio"
            onClick={() => setBioEditing(true)}
            className="block w-full rounded-[18px] border border-[color:var(--ria-divider-outer)] bg-[color:var(--card)] px-[18px] py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ria-gold)] focus-visible:ring-offset-2"
          >
            <span className="block text-[15px] leading-[1.5] text-foreground">
              {bio}
            </span>
          </button>
        ) : (
          <textarea
            id="ria-bio"
            rows={4}
            value={bio}
            onFocus={() => setBioEditing(true)}
            onBlur={() => {
              if (bio.trim()) setBioEditing(false);
            }}
            onChange={(event) => onBioChange(event.target.value)}
            placeholder="Briefly describe your approach..."
            className="min-h-[122px] w-full resize-none rounded-[18px] border border-[color:var(--ria-divider-outer)] bg-[color:var(--card)] px-[18px] py-4 text-[15px] leading-[1.5] text-foreground outline-none transition-colors placeholder:text-[color:var(--ria-faint)] focus:border-[color:var(--ria-gold)]"
          />
        )}
      </div>

      <div className="space-y-3">
        <SectionLabel>Business Location</SectionLabel>
        <SettingsGroup embedded separatorInset>
          <TextRow
            label="Street"
            value={fullStreetAddress}
            onChange={onFullStreetAddressChange}
            placeholder="Building, floor, street"
            autoComplete="street-address"
            dense
          />
          <div className="h-px bg-[color:var(--ria-divider-inner)]" />
          <TextRow
            label="Area"
            value={areaLocality}
            onChange={onAreaLocalityChange}
            placeholder="Area or state"
            autoComplete="address-level1"
            dense
          />
          <div className="h-px bg-[color:var(--ria-divider-inner)]" />
          <TextRow
            label="City"
            value={city}
            onChange={onCityChange}
            placeholder="City"
            autoComplete="address-level2"
            dense
          />
          <div className="h-px bg-[color:var(--ria-divider-inner)]" />
          <TextRow
            label="Pin / ZIP"
            value={pinZip}
            onChange={onPinZipChange}
            placeholder="PIN / ZIP"
            inputMode="numeric"
            autoComplete="postal-code"
            dense
          />
        </SettingsGroup>

        <div className="relative overflow-hidden rounded-[16px] border border-[color:var(--ria-divider-outer)] bg-[color:var(--card)]">
          {staticMapPreviewSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={staticMapPreviewSrc}
              alt="Business location map"
              className="block h-[132px] w-full select-none object-cover object-center"
              draggable={false}
            />
          ) : mapPreviewSrc ? (
            <iframe
              title="Business location map preview"
              src={mapPreviewSrc}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="h-[132px] w-full border-0"
            />
          ) : (
            <div className="flex h-[132px] items-center justify-center gap-2 text-[14px] text-[color:var(--ria-muted)]">
              <MapPin className="h-4 w-4" />
              <span>Map preview</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

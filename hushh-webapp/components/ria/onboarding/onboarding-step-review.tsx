"use client";

import { useState } from "react";
import { AskOneButton } from "@/components/agent/ask-one-button";
import { ChevronDown, ChevronUp, Pencil, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { RiaChip } from "@/components/ria/ui/ria-primitives";

const DETAIL_ROW_GRID_CLASSNAME =
  "grid grid-cols-[7.25rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[8rem_minmax(0,1fr)]";

interface OnboardingStepReviewProps {
  advisorName: string;
  firmName: string;
  crdNumber: string;
  regulator: string;
  regulatorStatus: string;
  certifications: string[];
  servicesOffered: string[];
  feeStructure: string[];
  minEngagementAmount: string;
  bio: string;
  city: string;
  pinZip: string;
  areaLocality: string;
  fullStreetAddress: string;
  advisoryAccessReady: boolean;
  onEditSection: (section: "license" | "services") => void;
  onAskKaiUpdateAnything: () => void;
}

function SectionCard({
  label,
  onEdit,
  children,
}: {
  label: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className="overflow-hidden rounded-[22px] border border-[color:var(--ria-divider-outer)] bg-[color:var(--card)] shadow-[0_8px_24px_rgba(62,48,30,0.05)]"
      data-testid={`ria-review-section-${label.toLowerCase()}`}
    >
      <div className="flex items-center justify-between gap-3 px-[18px] pb-[11px] pt-[15px]">
        <span className="ui-text-section-label min-w-0">
          {label}
        </span>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-8 items-center gap-1.5 rounded-[16px] border px-3 text-[13px] font-semibold transition-opacity hover:opacity-80"
          style={{
            background: "var(--ria-selected-tint)",
            borderColor: "#E8E0D3",
            color: "var(--ria-gold-deep)",
          }}
        >
          <Pencil className="h-3.5 w-3.5" strokeWidth={1.9} />
          Edit
        </button>
      </div>
      <div
        className="px-[18px] pb-2"
        data-testid={`ria-review-section-${label.toLowerCase()}-rows`}
      >
        {children}
      </div>
    </section>
  );
}

function ReviewRow({
  label,
  value,
}: {
  label: string;
  value: string | undefined | null;
}) {
  const hasValue = Boolean(value?.trim());
  return (
    <div
      className={cn(
        DETAIL_ROW_GRID_CLASSNAME,
        "min-h-[44px] items-start border-t border-[color:var(--ria-divider-inner)] py-[10px] first:border-t-0",
      )}
      data-testid={reviewRowTestId(label)}
    >
      <span
        className="pt-0.5 text-[15px] leading-6 text-[color:var(--ria-muted)]"
        data-slot="review-label"
      >
        {label}
      </span>
      <span
        className={cn(
          "block min-w-0 whitespace-normal break-words text-left text-[15px] font-medium leading-6 [overflow-wrap:anywhere]",
          hasValue
            ? "text-[color:var(--ria-ink)]"
            : "text-[color:var(--ria-faint)]",
        )}
        data-slot="review-value"
      >
        {hasValue ? value : "Not provided"}
      </span>
    </div>
  );
}

function certificationCode(label: string) {
  return label.match(/\bSeries\s+\d+[A-Z]*\b/i)?.[0] ?? null;
}

function reviewRowTestId(label: string) {
  return `ria-review-row-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function ChipRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div
      className={cn(
        DETAIL_ROW_GRID_CLASSNAME,
        "min-h-[44px] items-start border-t border-[color:var(--ria-divider-inner)] py-[10px] first:border-t-0",
      )}
      data-testid={reviewRowTestId(label)}
    >
      <span
        className="pt-0.5 text-[15px] leading-6 text-[color:var(--ria-muted)]"
        data-slot="review-label"
      >
        {label}
      </span>
      <div className="min-w-0" data-slot="review-value">
        {items.length === 0 ? (
          <span className="block text-left text-[15px] leading-6 text-[color:var(--ria-faint)]">
            Not provided
          </span>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const code = certificationCode(item);
              return (
                <div key={item} className="min-w-0 space-y-1.5">
                  <span className="block whitespace-normal break-words text-left text-[15px] font-medium leading-6 text-[color:var(--ria-ink)] [overflow-wrap:anywhere]">
                    {item}
                  </span>
                  {code ? (
                    <RiaChip variant="outline" className="max-w-full">
                      {code}
                    </RiaChip>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function BioReviewRow({ bio }: { bio: string }) {
  const [open, setOpen] = useState(false);
  const hasValue = Boolean(bio?.trim());
  return (
    <div
      className={cn(
        DETAIL_ROW_GRID_CLASSNAME,
        "items-start border-t border-[color:var(--ria-divider-inner)] py-[11px]",
      )}
      data-testid="ria-review-row-bio"
    >
      <span
        className="pt-px text-[15px] leading-6 text-[color:var(--ria-muted)]"
        data-slot="review-label"
      >
        Bio
      </span>
      <div
        className="flex min-w-0 flex-col items-start"
        data-slot="review-value"
      >
        {hasValue ? (
          <p
            className={cn(
              "whitespace-normal break-words text-left text-[14px] leading-[1.5] text-[color:var(--ria-ink)] [overflow-wrap:anywhere]",
              !open && "line-clamp-3",
            )}
          >
            {bio}
          </p>
        ) : (
          <span className="text-[15px] text-[color:var(--ria-faint)]">
            Not provided
          </span>
        )}
        {hasValue ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mt-[7px] flex items-center justify-center"
            aria-label={open ? "Collapse bio" : "Expand bio"}
          >
            {open ? (
              <ChevronUp
                className="h-[18px] w-[18px] text-[color:var(--ria-gold)]"
                strokeWidth={2}
              />
            ) : (
              <ChevronDown
                className="h-[18px] w-[18px] text-[color:var(--ria-gold)]"
                strokeWidth={2}
              />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function OnboardingStepReview({
  advisorName,
  firmName,
  crdNumber,
  regulator,
  regulatorStatus,
  certifications,
  servicesOffered,
  feeStructure,
  minEngagementAmount,
  bio,
  city,
  pinZip,
  areaLocality,
  fullStreetAddress,
  onEditSection,
  onAskKaiUpdateAnything,
}: OnboardingStepReviewProps) {
  return (
    <div className="space-y-[14px]">
      <SectionCard label="Licence" onEdit={() => onEditSection("license")}>
        <ReviewRow label="Advisor" value={advisorName} />
        <ReviewRow label="Firm" value={firmName} />
        <ReviewRow label="CRD" value={crdNumber} />
        <ReviewRow
          label="Regulator"
          value={
            regulator ? `${regulator} - ${regulatorStatus || "Unknown"}` : null
          }
        />
        <ChipRow label="Certifications" items={certifications} />
      </SectionCard>

      <SectionCard label="Services" onEdit={() => onEditSection("services")}>
        <ReviewRow label="Services" value={servicesOffered.join(", ")} />
        <ReviewRow label="Fees" value={feeStructure.join(", ")} />
        <ReviewRow label="Min Engagement" value={minEngagementAmount} />
        <BioReviewRow bio={bio} />
      </SectionCard>

      <SectionCard label="Location" onEdit={() => onEditSection("services")}>
        <ReviewRow label="Address" value={fullStreetAddress} />
        <ReviewRow label="Area" value={areaLocality} />
        <ReviewRow label="City" value={city} />
        <ReviewRow label="Pin / ZIP" value={pinZip} />
      </SectionCard>

      {/* Canonical onboarding state: profile goes live as Pending Verification;
          the verified badge is a separate later layer (design shows gold). */}
      <div
        className="flex items-start gap-3 rounded-[18px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 text-[color:var(--app-secondary-label)]"
      >
        <ShieldCheck
          className="mt-0.5 h-[22px] w-[22px] shrink-0 text-[color:var(--app-accent)]"
          strokeWidth={1.7}
        />
        <span className="text-[13.5px] font-medium leading-[1.45]">
          Goes live as Pending Verification. Verified unlocks after Phase 2.
        </span>
      </div>

      <AskOneButton onClick={onAskKaiUpdateAnything}>
        Ask One to update anything
      </AskOneButton>
    </div>
  );
}

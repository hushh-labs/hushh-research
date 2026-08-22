"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Pencil, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { RiaAiActionPill, RiaChip } from "@/components/ria/ui/ria-primitives";

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
    <section className="overflow-hidden rounded-[22px] border border-[color:var(--ria-divider-outer)] bg-[color:var(--card)] shadow-[0_8px_24px_rgba(62,48,30,0.05)]">
      <div className="flex items-center justify-between gap-3 px-[18px] pb-[11px] pt-[15px]">
        <span className="ui-text-section-label">
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
      <div className="px-[18px] pb-2">{children}</div>
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
    <div className="flex min-h-[44px] items-center justify-between gap-4 border-t border-[color:var(--ria-divider-inner)] py-[9px] first:border-t-0">
      <span className="shrink-0 text-[15px] text-[color:var(--ria-muted)]">
        {label}
      </span>
      <span
        className={cn(
          "ml-auto min-w-0 max-w-[68%] break-words text-right text-[15px] font-medium leading-6",
          hasValue
            ? "text-[color:var(--ria-ink)]"
            : "text-[color:var(--ria-faint)]",
        )}
      >
        {hasValue ? value : "Not provided"}
      </span>
    </div>
  );
}

function ChipRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex min-h-[44px] items-start justify-between gap-4 border-t border-[color:var(--ria-divider-inner)] py-[10px] first:border-t-0">
      <span className="shrink-0 pt-0.5 text-[15px] text-[color:var(--ria-muted)]">
        {label}
      </span>
      <div className="ml-auto min-w-0 max-w-[68%]">
        {items.length === 0 ? (
          <span className="text-[15px] text-[color:var(--ria-faint)]">
            Not provided
          </span>
        ) : (
          <div className="flex flex-wrap justify-end gap-1.5">
            {items.map((item) => (
              <RiaChip key={item} variant="outline">
                {item}
              </RiaChip>
            ))}
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
    <div className="flex items-start justify-between gap-4 border-t border-[color:var(--ria-divider-inner)] py-[11px]">
      <span className="shrink-0 pt-px text-[15px] text-[color:var(--ria-muted)]">
        Bio
      </span>
      <div className="ml-auto flex min-w-0 flex-1 flex-col items-end">
        {hasValue ? (
          <p
            className={cn(
              "text-right text-[14px] leading-[1.5] text-[color:var(--ria-ink)]",
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

      <RiaAiActionPill onClick={onAskKaiUpdateAnything}>
        Ask One to update anything
      </RiaAiActionPill>
    </div>
  );
}

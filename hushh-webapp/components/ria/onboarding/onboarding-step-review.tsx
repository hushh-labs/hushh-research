"use client";

import Link from "next/link";
import { CheckCircle2, Pencil, ShieldCheck, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

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
    <div className="rounded-[24px] border border-border/70 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
        <button
          type="button"
          onClick={onEdit}
          className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      </div>
      {children}
    </div>
  );
}

function ReviewRow({
  label,
  value,
}: {
  label: string;
  value: string | undefined | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 max-w-[70%] break-words text-right text-sm",
          value ? "text-foreground" : "text-muted-foreground/50"
        )}
      >
        {value || "Not provided"}
      </span>
    </div>
  );
}

function ChipList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return (
      <span className="text-sm text-muted-foreground/50">Not provided</span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="rounded-full border border-border/70 bg-muted/50 px-2.5 py-0.5 text-xs text-foreground"
        >
          {item}
        </span>
      ))}
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
  advisoryAccessReady,
  onEditSection,
}: OnboardingStepReviewProps) {
  return (
    <div className="space-y-4">
      <SectionCard label="Licence" onEdit={() => onEditSection("license")}>
        <div className="space-y-1">
          <ReviewRow label="Advisor Name" value={advisorName} />
          <ReviewRow label="Firm" value={firmName} />
          <ReviewRow label="CRD Number" value={crdNumber} />
          <ReviewRow
            label="Regulator"
            value={
              regulator
                ? `${regulator} — ${regulatorStatus || "Unknown"}`
                : null
            }
          />
        </div>
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Certifications</span>
          <ChipList items={certifications} />
        </div>
      </SectionCard>

      <SectionCard
        label="Services"
        onEdit={() => onEditSection("services")}
      >
        <div className="space-y-3">
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">
              Services Offered
            </span>
            <ChipList items={servicesOffered} />
          </div>
          <div className="space-y-1.5">
            <span className="text-xs text-muted-foreground">Fee Structure</span>
            <ChipList items={feeStructure} />
          </div>
          <ReviewRow label="Min Engagement" value={minEngagementAmount} />
          <ReviewRow label="Bio" value={bio} />
        </div>
      </SectionCard>

      <SectionCard
        label="Business Location"
        onEdit={() => onEditSection("services")}
      >
        <div className="space-y-1">
          <ReviewRow label="Address" value={fullStreetAddress} />
          <ReviewRow label="Area" value={areaLocality} />
          <ReviewRow label="City" value={city} />
          <ReviewRow label="Pin / ZIP" value={pinZip} />
        </div>
      </SectionCard>

      {advisoryAccessReady ? (
        <div className="flex items-start gap-3 rounded-[24px] border border-emerald-200 bg-emerald-50 p-4 dark:bg-emerald-950/20">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="space-y-2">
            <p className="text-sm font-medium text-emerald-900 dark:text-emerald-100">
              Verification passed. Your RIA workspace is ready.
            </p>
            <div className="flex items-center gap-3">
              <Link
                href="/ria"
                className="text-sm font-medium text-emerald-700 underline underline-offset-2 dark:text-emerald-300"
              >
                Open RIA Home
              </Link>
              <Link
                href="/ria/clients"
                className="text-sm font-medium text-emerald-700 underline underline-offset-2 dark:text-emerald-300"
              >
                Open Clients
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-[24px] border border-amber-200 bg-amber-50 p-4 dark:bg-amber-950/20">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-sm text-amber-900 dark:text-amber-100">
            Profile goes live as Pending Verification immediately. Full verified
            badge will be unlocked after completing Phase 2 onboarding.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2 rounded-full border border-dashed border-[#0071E3]/30 px-3 py-1.5 w-fit">
        <Sparkles className="h-3.5 w-3.5 text-[#0071E3]" />
        <span className="text-sm text-[#0071E3]">
          Ask Kai to update anything...
        </span>
      </div>
    </div>
  );
}

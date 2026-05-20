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
    <section className="overflow-hidden rounded-[24px] border border-border/60 bg-card/80 shadow-[0_12px_34px_rgba(15,23,42,0.06)] backdrop-blur dark:bg-card/55 dark:shadow-none">
      <div className="flex min-h-[46px] items-center justify-between gap-3 border-b border-border/50 px-4 sm:px-5">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </span>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-muted/60 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      </div>
      <div>{children}</div>
    </section>
  );
}

function Divider() {
  return <div className="ml-4 h-px bg-border/50 sm:ml-5" />;
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
    <div className="flex min-h-[44px] items-center gap-4 px-4 py-2 sm:px-5">
      <span className="shrink-0 text-[15px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "ml-auto min-w-0 max-w-[68%] break-words text-right text-[15px] leading-6",
          hasValue ? "text-foreground" : "text-muted-foreground/50"
        )}
      >
        {hasValue ? value : "Not provided"}
      </span>
    </div>
  );
}

function ChipList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <span className="text-[15px] text-muted-foreground/50">Not provided</span>;
  }
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="rounded-full border border-border/60 bg-muted/45 px-2.5 py-1 text-xs font-medium text-foreground"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function ChipRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex min-h-[44px] items-start gap-4 px-4 py-3 sm:px-5">
      <span className="shrink-0 text-[15px] text-muted-foreground">{label}</span>
      <div className="ml-auto min-w-0 max-w-[68%]">
        <ChipList items={items} />
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
  advisoryAccessReady,
  onEditSection,
}: OnboardingStepReviewProps) {
  return (
    <div className="space-y-4">
      <SectionCard label="Licence" onEdit={() => onEditSection("license")}>
        <ReviewRow label="Advisor" value={advisorName} />
        <Divider />
        <ReviewRow label="Firm" value={firmName} />
        <Divider />
        <ReviewRow label="CRD" value={crdNumber} />
        <Divider />
        <ReviewRow
          label="Regulator"
          value={
            regulator
              ? `${regulator} - ${regulatorStatus || "Unknown"}`
              : null
          }
        />
        <Divider />
        <ChipRow label="Certifications" items={certifications} />
      </SectionCard>

      <SectionCard label="Services" onEdit={() => onEditSection("services")}>
        <ChipRow label="Services" items={servicesOffered} />
        <Divider />
        <ChipRow label="Fees" items={feeStructure} />
        <Divider />
        <ReviewRow label="Min Engagement" value={minEngagementAmount} />
        <Divider />
        <ReviewRow label="Bio" value={bio} />
      </SectionCard>

      <SectionCard label="Location" onEdit={() => onEditSection("services")}>
        <ReviewRow label="Address" value={fullStreetAddress} />
        <Divider />
        <ReviewRow label="Area" value={areaLocality} />
        <Divider />
        <ReviewRow label="City" value={city} />
        <Divider />
        <ReviewRow label="Pin / ZIP" value={pinZip} />
      </SectionCard>

      {advisoryAccessReady ? (
        <div className="rounded-[22px] border border-emerald-500/25 bg-emerald-500/10 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="space-y-2">
              <p className="text-[15px] font-medium text-emerald-800 dark:text-emerald-200">
                Verification passed. Your RIA workspace is ready.
              </p>
              <div className="flex flex-wrap items-center gap-3">
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
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-[22px] border border-amber-500/25 bg-amber-500/10 p-4">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-[15px] leading-6 text-amber-900 dark:text-amber-100">
            Profile goes live as Pending Verification immediately. Full verified
            badge will be unlocked after completing Phase 2 onboarding.
          </p>
        </div>
      )}

      <button
        type="button"
        className="inline-flex min-h-9 items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3.5 text-sm font-medium text-primary transition-colors hover:bg-primary/15"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Ask Kai to update anything
      </button>
    </div>
  );
}

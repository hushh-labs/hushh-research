"use client";

import { Briefcase, Check, Home, User } from "@/components/icons";
import { useId, type ComponentType } from "react";

import { Button } from "@/lib/morphy-ux/button";

const PREVIEW_ROWS: ReadonlyArray<{
  label: string;
  icon: ComponentType<{ className?: string }>;
  barWidth: string;
}> = [
  { label: "Name", icon: User, barWidth: "w-24" },
  { label: "Address", icon: Home, barWidth: "w-28" },
  { label: "Employment", icon: Briefcase, barWidth: "w-20" },
];

/**
 * The KYC intro card. It sizes to its slot rather than the viewport, so it is
 * exactly as wide as the workspace tabs above it at every width. Stacked it
 * reads heading and copy, the preview, then the action; side by side the copy
 * and the action share the left column and the preview sits on the right.
 */
export function KycProfileHero({ onPasteDetails }: { onPasteDetails: () => void }) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-testid="kyc-profile-hero"
      className="@container w-full"
    >
      {/* Three items on one grid. Side by side, the copy and the action are
          centred as a pair by the two flexible rows, and the preview spans all
          four rows on the right. */}
      <div className="grid w-full gap-6 overflow-hidden rounded-[var(--app-card-radius-feature)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-5 shadow-[var(--app-card-shadow-feature)] @lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] @lg:grid-rows-[1fr_auto_auto_1fr] @lg:gap-x-8 @lg:gap-y-0 @lg:p-8">
        <div className="min-w-0 @lg:col-start-1 @lg:row-start-2">
          <h2 id={titleId} className="text-foreground [--foundation-title2-size:clamp(1.75rem,8.2cqw,2.5rem)] [--foundation-title3-size:var(--foundation-title2-size)] [--foundation-title2-line:1.1] [--foundation-title3-line:1.1] [--foundation-title2-weight:800] [--foundation-title3-weight:800]">
            Build your{" "}<br />KYC profile
          </h2>
          <p className="mt-3 max-w-md text-[15px] leading-[22px] text-muted-foreground">
            Paste your profile details to automate future KYC responses. Securely
            parsed and pre-filled by One.
          </p>
        </div>

        <div
          aria-hidden="true"
          className="min-w-0 @lg:col-start-2 @lg:row-span-4 @lg:row-start-1 @lg:self-center"
          data-testid="kyc-profile-preview"
        >
          <div className="mx-auto w-full max-w-[22rem] rounded-[20px] border border-border/50 bg-card p-4 shadow-[0_12px_32px_-12px_color-mix(in_srgb,var(--app-accent)_22%,transparent)] @lg:ml-auto @lg:mr-0 @lg:p-5">
            <div className="flex size-12 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)] @lg:size-14">
              <User className="size-6 @lg:size-7" />
            </div>
            <ul className="mt-4 space-y-2.5">
              {PREVIEW_ROWS.map(({ label, icon: Icon, barWidth }) => (
                <li key={label} className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-muted/40 text-muted-foreground">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-foreground">{label}</p>
                      <div className={`mt-1.5 h-1.5 max-w-full rounded-full bg-[color:var(--app-accent-tint)] ${barWidth}`} />
                    </div>
                  </div>
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-[color:var(--app-accent-tint)] bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent)]">
                    <Check className="size-3.5" />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* The same 244 x 50 footprint as "Chat with One" on the Overview. */}
        <div className="mx-auto w-full max-w-[244px] @lg:col-start-1 @lg:row-start-3 @lg:mx-0 @lg:mt-6">
          <Button
            type="button"
            size="prominent"
            onClick={onPasteDetails}
            className="w-full justify-center"
          >
            Paste details
          </Button>
        </div>
      </div>
    </section>
  );
}

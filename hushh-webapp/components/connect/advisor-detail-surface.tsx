"use client";

import { useEffect, useState } from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/lib/morphy-ux/button";
import {
  AdvisorDirectoryService,
  type AdvisorCard,
  type AdvisorProfile,
} from "@/lib/services/advisor-directory-service";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="type-title2 text-foreground">{value}</p>
      <p className="type-footnote text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * One adviser, opened from the nearby list. The list row already carries name,
 * firm and distance, so this surface exists for the facts a decision actually
 * turns on: tenure, reach, and whether there are disclosures.
 */
export function AdvisorDetailSurface({
  card,
  open,
  onOpenChange,
  getIdToken,
}: {
  card: AdvisorCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  getIdToken: () => Promise<string | null>;
}) {
  const [profile, setProfile] = useState<AdvisorProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const crd = card?.crd ?? null;

  useEffect(() => {
    if (!open || !crd) return;
    const controller = new AbortController();
    let cancelled = false;

    setProfile(null);
    setError(null);
    setLoading(true);

    void (async () => {
      try {
        const idToken = await getIdToken();
        if (!idToken || cancelled) return;
        const next = await AdvisorDirectoryService.getProfile({
          idToken,
          crd,
          signal: controller.signal,
        });
        if (!cancelled) setProfile(next);
      } catch (caught) {
        if (cancelled || controller.signal.aborted) return;
        setError(
          caught instanceof Error ? caught.message : "Profile unavailable.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [crd, getIdToken, open]);

  if (!card) return null;

  const office = profile?.office;
  const address = office
    ? [office.street, office.city, office.state].filter(Boolean).join(", ")
    : null;

  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={card.firmName ?? undefined}
      title={card.name ?? "Advisor"}
      mobilePresentation="sheet"
      footer={
        card.phone ? (
          <Button
            type="button"
            variant="blue-gradient"
            effect="fill"
            size="lg"
            fullWidth
            asChild
          >
            <a href={`tel:${card.phone.replace(/[^\d+]/g, "")}`}>Call</a>
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-7">
        {loading ? (
          <div className="grid grid-cols-3 gap-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : error ? (
          <p className="type-callout text-muted-foreground">{error}</p>
        ) : profile ? (
          <>
            <div className="grid grid-cols-3 gap-4">
              <Stat
                label="Experience"
                value={
                  profile.yearsExperience
                    ? `${Math.floor(profile.yearsExperience)} yrs`
                    : "—"
                }
              />
              <Stat label="Firms" value={String(profile.firmCount ?? "—")} />
              <Stat label="States" value={String(profile.states.length || "—")} />
            </div>

            {profile.disclosureCount > 0 ? (
              <p className="type-callout text-amber-600 dark:text-amber-400">
                {profile.disclosureCount} disclosure
                {profile.disclosureCount === 1 ? "" : "s"} on record.
              </p>
            ) : null}

            {address ? (
              <p className="type-callout text-muted-foreground">{address}</p>
            ) : null}

            {profile.reportUrl ? (
              <a
                href={profile.reportUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="type-callout text-[color:var(--app-accent)] underline-offset-4 hover:underline"
              >
                BrokerCheck report
              </a>
            ) : null}
          </>
        ) : null}
      </div>
    </AdaptiveDetailSurface>
  );
}

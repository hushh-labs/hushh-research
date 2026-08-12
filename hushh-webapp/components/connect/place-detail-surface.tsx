"use client";

import { useEffect, useState } from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/lib/morphy-ux/button";
import {
  PlacesDirectoryService,
  formatPlaceDistance,
  type PlaceCard,
  type PlaceDetails,
} from "@/lib/services/places-directory-service";
import { usTelHref } from "@/lib/services/us-tel-href";

/**
 * One place, opened from the nearby list.
 *
 * The row already carries name, category and distance. Phone, website and
 * posted hours sit in a dearer billing tier at the provider, so they are bought
 * here — once, for the one place a reader opened — rather than for every row of
 * every category they scrolled past.
 *
 * A failed fetch leaves the surface open showing what the row already knew. The
 * reader asked to see this place; answering with an error page when we still
 * hold its name and address would be worse than answering with less.
 */
export function PlaceDetailSurface({
  card,
  open,
  onOpenChange,
  getIdToken,
}: {
  card: PlaceCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  getIdToken: () => Promise<string | null>;
}) {
  const [details, setDetails] = useState<PlaceDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const placeId = card?.placeId ?? null;

  useEffect(() => {
    if (!open || !placeId) return;
    const controller = new AbortController();
    let cancelled = false;

    setDetails(null);
    setFailed(false);
    setLoading(true);

    void (async () => {
      try {
        const idToken = await getIdToken();
        if (!idToken || cancelled) return;
        const next = await PlacesDirectoryService.getDetails({
          idToken,
          placeId,
          signal: controller.signal,
        });
        if (!cancelled) setDetails(next);
      } catch {
        if (cancelled || controller.signal.aborted) return;
        setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [getIdToken, open, placeId]);

  if (!card) return null;

  const distance = formatPlaceDistance(card.distanceMeters);
  const address = details?.address ?? card.address;
  const eyebrow =
    [details?.categoryLabel ?? card.categoryLabel, distance]
      .filter(Boolean)
      .join(" · ") || undefined;

  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={eyebrow}
      title={details?.name ?? card.name}
      mobilePresentation="sheet"
      footer={
        details?.phone ? (
          <Button
            type="button"
            variant="blue-gradient"
            effect="fill"
            size="lg"
            fullWidth
            asChild
          >
            <a href={usTelHref(details.phone)}>Call</a>
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-7">
        {address ? (
          <p className="type-callout text-muted-foreground">{address}</p>
        ) : null}

        {loading ? (
          <div className="space-y-3" data-testid="place-detail-loading">
            <Skeleton className="h-4 w-2/3 rounded-lg" />
            <Skeleton className="h-4 w-1/2 rounded-lg" />
          </div>
        ) : null}

        {details?.weekdayDescriptions.length ? (
          // Posted hours, never "open now": Google's live verdict is a claim we
          // would be repeating without being able to stand behind it.
          <div className="space-y-1" data-testid="place-detail-hours">
            {details.weekdayDescriptions.map((line) => (
              <p key={line} className="type-callout text-muted-foreground">
                {line}
              </p>
            ))}
          </div>
        ) : null}

        {details?.website ? (
          <a
            href={details.website}
            target="_blank"
            rel="noreferrer noopener"
            className="type-callout block text-[color:var(--app-accent)] underline-offset-4 hover:underline"
          >
            Visit website
          </a>
        ) : null}

        {details?.mapsUrl ? (
          <a
            href={details.mapsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="type-callout block text-[color:var(--app-accent)] underline-offset-4 hover:underline"
          >
            Open in Google Maps
          </a>
        ) : null}

        {failed ? (
          <p
            className="type-footnote text-muted-foreground"
            role="status"
            data-testid="place-detail-partial"
          >
            Could not load more details.
          </p>
        ) : null}
      </div>
    </AdaptiveDetailSurface>
  );
}

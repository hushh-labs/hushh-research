"use client";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import type { InsuranceAgentCard } from "@/lib/services/insurance-agent-directory-service";

/**
 * One agency, opened from the nearby list.
 *
 * Unlike the adviser surface this fetches nothing: the locator returns full
 * agency data inline, so the row already holds everything shown here. That is
 * why there is no loading or error state — there is no second request that
 * could be slow or fail.
 *
 * The list row is capped at three products to stay one line; here the full set
 * is shown, because "can they write farm cover?" is the question this surface
 * is open to answer.
 */
export function InsuranceAgentDetailSurface({
  card,
  open,
  onOpenChange,
}: {
  card: InsuranceAgentCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!card) return null;

  const address =
    card.address?.formatted ??
    [card.address?.line1, card.address?.city, card.address?.region]
      .filter(Boolean)
      .join(", ") ??
    null;

  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={card.agencyType ?? undefined}
      title={card.name ?? "Agency"}
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
        {card.products.length ? (
          <p className="type-callout text-foreground">
            {card.products.join(" · ")}
          </p>
        ) : null}

        {address ? (
          <p className="type-callout text-muted-foreground">{address}</p>
        ) : null}

        {card.website ? (
          <a
            href={card.website}
            target="_blank"
            rel="noreferrer noopener"
            className="type-callout block text-[color:var(--app-accent)] underline-offset-4 hover:underline"
          >
            Visit agency
          </a>
        ) : null}
      </div>
    </AdaptiveDetailSurface>
  );
}

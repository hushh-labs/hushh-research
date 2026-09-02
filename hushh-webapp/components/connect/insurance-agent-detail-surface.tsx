"use client";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import {
  agencyStatusLabel,
  formatAgentHours,
  type InsuranceAgentCard,
} from "@/lib/services/insurance-agent-directory-service";
import { usTelHref } from "@/lib/services/us-tel-href";

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

  const hours = formatAgentHours(card);

  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={agencyStatusLabel(card) ?? undefined}
      title={card.name ?? "Agency"}
      headerTextOverflow="wrap"
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
            <a href={usTelHref(card.phone)}>Call</a>
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

        {hours ? (
          // Posted hours, not an open/closed verdict — see formatAgentHours.
          <p className="type-callout text-muted-foreground">{hours}</p>
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

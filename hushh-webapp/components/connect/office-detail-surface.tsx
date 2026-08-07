"use client";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import {
  formatDistance,
  type AdvisorCard,
} from "@/lib/services/advisor-directory-service";
import { usTelHref } from "@/lib/services/us-tel-href";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="type-title2 text-foreground">{value}</p>
      <p className="type-footnote text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * One office, opened from the nearby list when the server groups dense results
 * into branches instead of people.
 *
 * Deliberately not the adviser surface. A branch row carries no CRD, so there
 * is no BrokerCheck profile to fetch and no tenure or disclosure record to
 * show — presenting one would put a person's credentials on an address. This
 * shows only what the office itself is: how many advisers register there, where
 * it is, and how to call it.
 */
export function OfficeDetailSurface({
  card,
  open,
  onOpenChange,
}: {
  card: AdvisorCard | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!card) return null;

  const location = [card.city, card.state].filter(Boolean).join(", ");
  const distance = formatDistance(card.distanceMiles);
  const names = card.advisorNames ?? [];
  // The directory returns at most three names per office, so the list is a
  // sample and must never read as the full roster.
  const undisclosed =
    typeof card.advisorCount === "number"
      ? card.advisorCount - names.length
      : 0;

  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      eyebrow={location || undefined}
      title={card.name ?? "Office"}
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
        <div className="grid grid-cols-3 gap-4">
          <Stat
            label={card.advisorCount === 1 ? "Advisor" : "Advisors"}
            value={String(card.advisorCount ?? "—")}
          />
          <Stat label="Distance" value={distance ?? "—"} />
          <Stat label="State" value={card.state ?? "—"} />
        </div>

        {names.length ? (
          <div className="space-y-2">
            <p className="type-footnote text-muted-foreground">
              Advisors at this office
            </p>
            <ul className="space-y-1">
              {names.map((name) => (
                <li key={name} className="type-callout text-foreground">
                  {name}
                </li>
              ))}
            </ul>
            {undisclosed > 0 ? (
              <p className="type-footnote text-muted-foreground">
                and {undisclosed} more
              </p>
            ) : null}
          </div>
        ) : null}

        {location ? (
          <p className="type-callout text-muted-foreground">{location}</p>
        ) : null}
      </div>
    </AdaptiveDetailSurface>
  );
}

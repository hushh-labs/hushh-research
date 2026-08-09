"use client";

/**
 * RIA profile — the adviser's registered office, and the route to it.
 *
 * The office is known only as words (four address fields off the SEC record),
 * so both embeds are the keyless Google Maps iframes, which geocode the text
 * themselves. With a position for the viewer the directions embed draws the
 * route, both markers, and fits the viewport to them natively.
 *
 * Location is never requested on mount. iOS grants exactly one system prompt,
 * and spending it on a screen the user opened to read their profile would burn
 * it before they know why — so the prompt hangs off an explicit "Show route".
 * A viewer who already granted permission gets the route with no tap, because
 * useCurrentLocation()'s auto pass reads an existing grant without prompting.
 */

import { MapPin } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  googleMapsDirectionsEmbedUrl,
  googleMapsLocationEmbedUrl,
} from "@/lib/one-location/maps-urls";
import { useCurrentLocation } from "@/lib/one-location/use-current-location";

/** Address parts in composition order, paired with how we name a gap. */
const ADDRESS_FIELD_LABELS = [
  "street address",
  "area",
  "city",
  "PIN / ZIP",
] as const;

const MAP_FRAME_CLASS = "h-[180px] w-full border-0";

export interface RiaLocationMapProps {
  city: string;
  areaLocality: string;
  fullStreetAddress: string;
  pinZip: string;
}

export function RiaLocationMap({
  city,
  areaLocality,
  fullStreetAddress,
  pinZip,
}: RiaLocationMapProps) {
  const { status, permission, snapshot, request } = useCurrentLocation();

  // Same composition as the onboarding location step, so the pin the adviser
  // previewed while editing is the pin the reader sees here.
  const parts = [fullStreetAddress, areaLocality, city, pinZip].map((part) =>
    (part ?? "").trim(),
  );
  const destination = parts.filter(Boolean).join(", ");
  const missing = ADDRESS_FIELD_LABELS.filter((_, index) => !parts[index]);

  const origin = snapshot
    ? { lat: snapshot.latitude, lng: snapshot.longitude }
    : null;

  // Denied and unavailable are terminal for this screen: the OS will not
  // re-prompt, so offering a button that cannot work would be a dead control.
  const blocked =
    status === "denied" ||
    status === "unavailable" ||
    permission === "denied" ||
    permission === "restricted" ||
    permission === "unavailable";
  const locating = status === "locating";

  const routeSrc =
    destination && origin
      ? googleMapsDirectionsEmbedUrl(origin, destination)
      : "";
  const officeSrc = destination ? googleMapsLocationEmbedUrl(destination) : "";

  return (
    <div className="p-3" data-testid="ria-location-map">
      <div className="overflow-hidden rounded-[22px] border border-[color:var(--border)] bg-[color:var(--card)]">
        {routeSrc ? (
          <iframe
            title="Route from your location to the advisor's office"
            src={routeSrc}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            className={MAP_FRAME_CLASS}
            data-testid="ria-location-map-route"
          />
        ) : officeSrc ? (
          <iframe
            title="Advisor office location"
            src={officeSrc}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            className={MAP_FRAME_CLASS}
            data-testid="ria-location-map-office"
          />
        ) : (
          <div
            className="flex h-[180px] flex-col items-center justify-center gap-2 px-4 text-center"
            data-testid="ria-location-map-missing"
          >
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <p className="text-[13px] leading-[1.4] text-muted-foreground">
              {`Location unavailable — missing: ${missing.join(", ")}`}
            </p>
          </div>
        )}
      </div>

      {destination && !origin ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          {blocked ? (
            <p
              className="text-[13px] text-muted-foreground"
              data-testid="ria-location-map-denied"
            >
              Location is off — showing the office only.
            </p>
          ) : (
            <>
              <p className="text-[13px] text-muted-foreground">
                {status === "error"
                  ? "Couldn't get your location."
                  : "See how far the office is from you."}
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={locating}
                onClick={() => {
                  void request();
                }}
                data-testid="ria-location-map-show-route"
              >
                {locating ? "Locating…" : "Show route"}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

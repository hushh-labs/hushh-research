"use client";

/**
 * Where to look. Three ways in, because one is not enough.
 *
 * GPS is the fast path when an advisor is standing somewhere. A postcode covers
 * the case where they are prospecting a place they are not in. Coordinates
 * cover the case the other two cannot: only one market is approved today, so an
 * advisor outside it has no way to see a populated screen without typing a
 * point directly.
 */

import { useState } from "react";
import { MapPin, Navigation } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/lib/morphy-ux/button";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import { MUTED_TEXT } from "@/lib/morphy-ux/tokens/surfaces";
import type { NearbyAnchor } from "@/lib/services/nws-nearby-service";
import { cn } from "@/lib/utils";

type ManualMode = "postal" | "coords";

export function NearbyLocationInput({
  onAnchor,
  locationStatus,
  onUseLocation,
  busy = false,
}: {
  onAnchor: (anchor: NearbyAnchor) => void;
  locationStatus: string;
  onUseLocation: () => void;
  busy?: boolean;
}) {
  const [mode, setMode] = useState<ManualMode>("postal");
  const [postal, setPostal] = useState("");
  const [country, setCountry] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [error, setError] = useState<string | null>(null);

  // A denied or unavailable permission is not a failure to report — it is the
  // reason the manual fields exist, so they simply carry on being the answer.
  const locationBlocked =
    locationStatus === "denied" || locationStatus === "unavailable";

  function submitPostal() {
    const code = postal.trim().toUpperCase();
    const iso = country.trim().toUpperCase();
    if (code.length < 3) {
      setError("Enter a postcode.");
      return;
    }
    // The upstream accepts one postcode without a country, for historical
    // reasons. Everything else needs one, so ask rather than guess.
    if (!/^[A-Z]{2}$/.test(iso) && code !== "98033") {
      setError("Enter a two-letter country, like US or IN.");
      return;
    }
    setError(null);
    onAnchor({
      kind: "postal",
      postalCode: code,
      countryCode: iso || "US",
    });
  }

  function submitCoords() {
    const lat = Number(latitude.trim());
    const lng = Number(longitude.trim());
    if (!latitude.trim() || !longitude.trim()) {
      setError("Enter both latitude and longitude.");
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError("Those aren't numbers.");
      return;
    }
    if (lat < -90 || lat > 90) {
      setError("Latitude runs from −90 to 90.");
      return;
    }
    if (lng < -180 || lng > 180) {
      setError("Longitude runs from −180 to 180.");
      return;
    }
    setError(null);
    onAnchor({ kind: "coords", latitude: lat, longitude: lng });
  }

  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="blue-gradient"
        effect="fill"
        size="lg"
        fullWidth
        disabled={busy || locationBlocked}
        onClick={onUseLocation}
      >
        <Navigation className="mr-2 h-4 w-4" aria-hidden />
        Use my location
      </Button>

      {locationBlocked ? (
        <p className={cn(MUTED_TEXT, "text-center")}>
          Location is off. Enter a place below.
        </p>
      ) : (
        <p className={cn(MUTED_TEXT, "text-center")}>or enter a place</p>
      )}

      <SegmentedTabs
        value={mode}
        onValueChange={(value) => {
          setMode(value as ManualMode);
          setError(null);
        }}
        options={[
          { value: "postal", label: "Postcode" },
          { value: "coords", label: "Coordinates" },
        ]}
      />

      {mode === "postal" ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={postal}
            onChange={(event) => setPostal(event.target.value)}
            placeholder="Postcode"
            aria-label="Postcode"
            autoComplete="postal-code"
            className="sm:flex-[2]"
            onKeyDown={(event) => {
              if (event.key === "Enter") submitPostal();
            }}
          />
          <Input
            value={country}
            onChange={(event) => setCountry(event.target.value)}
            placeholder="Country"
            aria-label="Two-letter country code"
            maxLength={2}
            className="sm:flex-1"
            onKeyDown={(event) => {
              if (event.key === "Enter") submitPostal();
            }}
          />
          <Button
            type="button"
            variant="none"
            effect="fill"
            size="lg"
            disabled={busy}
            onClick={submitPostal}
          >
            Search
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={latitude}
            onChange={(event) => setLatitude(event.target.value)}
            placeholder="Latitude"
            aria-label="Latitude"
            inputMode="decimal"
            className="sm:flex-1"
            onKeyDown={(event) => {
              if (event.key === "Enter") submitCoords();
            }}
          />
          <Input
            value={longitude}
            onChange={(event) => setLongitude(event.target.value)}
            placeholder="Longitude"
            aria-label="Longitude"
            inputMode="decimal"
            className="sm:flex-1"
            onKeyDown={(event) => {
              if (event.key === "Enter") submitCoords();
            }}
          />
          <Button
            type="button"
            variant="none"
            effect="fill"
            size="lg"
            disabled={busy}
            onClick={submitCoords}
          >
            Search
          </Button>
        </div>
      )}

      {error ? (
        <p role="alert" className="type-footnote text-destructive">
          {error}
        </p>
      ) : null}

      <p className={cn(MUTED_TEXT, "flex items-start gap-1.5")}>
        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Public professional, civic and institutional associations. Not where
          someone lives, and not who is physically nearby.
        </span>
      </p>
    </div>
  );
}

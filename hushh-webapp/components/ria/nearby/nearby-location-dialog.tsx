"use client";

/**
 * Pick a place — on demand, not on arrival.
 *
 * This used to sit permanently at the top of the pane, so every visit opened
 * with a form the advisor had usually already answered. It is a dialog now:
 * summoned from "Enter a place", and from the empty state when a location
 * turns out to have nothing in it.
 */

import { useState } from "react";

import { AdaptiveDetailSurface } from "@/components/app-ui/settings-ui";
import { Input } from "@/components/ui/input";
import { Button } from "@/lib/morphy-ux/button";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";
import type { NearbyAnchor } from "@/lib/services/nws-nearby-service";

type Mode = "postal" | "coords";

export function NearbyLocationDialog({
  open,
  onOpenChange,
  onAnchor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAnchor: (anchor: NearbyAnchor) => void;
}) {
  const [mode, setMode] = useState<Mode>("postal");
  const [postal, setPostal] = useState("");
  const [country, setCountry] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (mode === "postal") {
      const code = postal.trim().toUpperCase();
      const iso = country.trim().toUpperCase();
      if (code.length < 3) return setError("Enter a postcode.");
      // The upstream accepts one legacy postcode without a country. Everything
      // else needs one, and guessing it would suppress real results.
      if (code !== "98033" && !/^[A-Z]{2}$/.test(iso)) {
        return setError("Add a country, like US or IN.");
      }
      setError(null);
      onAnchor({ kind: "postal", postalCode: code, countryCode: iso || "US" });
    } else {
      const la = Number(lat.trim());
      const ln = Number(lng.trim());
      if (!lat.trim() || !lng.trim()) return setError("Enter both values.");
      if (!Number.isFinite(la) || !Number.isFinite(ln)) return setError("Numbers only.");
      if (la < -90 || la > 90) return setError("Latitude is −90 to 90.");
      if (ln < -180 || ln > 180) return setError("Longitude is −180 to 180.");
      setError(null);
      onAnchor({ kind: "coords", latitude: la, longitude: ln });
    }
    onOpenChange(false);
  }

  return (
    <AdaptiveDetailSurface
      open={open}
      onOpenChange={onOpenChange}
      title="Enter a place"
      mobilePresentation="sheet"
      footer={
        <Button
          type="button"
          variant="blue-gradient"
          effect="fill"
          size="lg"
          fullWidth
          onClick={submit}
        >
          Search
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <SegmentedTabs
          value={mode}
          onValueChange={(value) => {
            setMode(value as Mode);
            setError(null);
          }}
          options={[
            { value: "postal", label: "Postcode" },
            { value: "coords", label: "Coordinates" },
          ]}
        />

        {mode === "postal" ? (
          <div className="flex gap-2">
            <Input
              value={postal}
              onChange={(e) => setPostal(e.target.value)}
              placeholder="Postcode"
              aria-label="Postcode"
              autoComplete="postal-code"
              className="flex-[2]"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <Input
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="Country"
              aria-label="Country code"
              maxLength={2}
              className="flex-1"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="Latitude"
              aria-label="Latitude"
              inputMode="decimal"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <Input
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="Longitude"
              aria-label="Longitude"
              inputMode="decimal"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
        )}

        {error ? (
          <p role="alert" className="type-footnote text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </AdaptiveDetailSurface>
  );
}

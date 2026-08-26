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
import { COUNTRY_PHONE_OPTIONS } from "@/lib/constants/country-phone-options";
import type { NearbyAnchor } from "@/lib/services/nws-nearby-service";

type Mode = "postal" | "coords";

const COUNTRY_OPTIONS = [...COUNTRY_PHONE_OPTIONS].sort((left, right) =>
  left.value.localeCompare(right.value) || left.label.localeCompare(right.label),
);

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
  const [countryCode, setCountryCode] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (mode === "postal") {
      const code = postal.trim().toUpperCase();
      const iso = countryCode.trim().toUpperCase();
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
            <select
              id="nearby-place-country"
              aria-label="Country code"
              autoComplete="country"
              value={countryCode}
              onChange={(event) => {
                setCountryCode(event.target.value);
                setError(null);
              }}
              className="ui-text-input-value h-10 min-w-0 flex-1 rounded-[var(--app-radius-md)] border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] px-3 text-sm text-foreground shadow-none outline-none transition-[background-color,border-color,color,box-shadow] focus-visible:border-[color:var(--app-accent)] focus-visible:ring-[3px] focus-visible:ring-[color:var(--app-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">Code</option>
              {COUNTRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value} - {option.label}
                </option>
              ))}
            </select>
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

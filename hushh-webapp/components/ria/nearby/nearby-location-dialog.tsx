"use client";

/**
 * Pick a place — on demand, not on arrival.
 *
 * This used to sit permanently at the top of the pane, so every visit opened
 * with a form the advisor had usually already answered. It is a dialog now:
 * summoned from "Enter a place", and from the empty state when a location
 * turns out to have nothing in it.
 */

import { useMemo, useState } from "react";

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
  const [countryQuery, setCountryQuery] = useState("");
  const [countryListOpen, setCountryListOpen] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [error, setError] = useState<string | null>(null);
  const filteredCountryOptions = useMemo(() => {
    const query = countryQuery.trim().toUpperCase();
    if (!query) return COUNTRY_OPTIONS;
    return COUNTRY_OPTIONS.filter((option) => option.value.startsWith(query));
  }, [countryQuery]);

  const firstCountryOption = filteredCountryOptions[0];

  function selectCountry(value: string) {
    setCountryCode(value);
    setCountryQuery(value);
    setCountryListOpen(false);
    setError(null);
  }

  function submit() {
    if (mode === "postal") {
      const code = postal.trim().toUpperCase();
      const iso = (countryCode || countryQuery).trim().toUpperCase();
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
            setCountryListOpen(false);
            setError(null);
          }}
          options={[
            { value: "postal", label: "Postcode" },
            { value: "coords", label: "Coordinates" },
          ]}
        />

        {mode === "postal" ? (
          <div
            data-testid="nearby-place-postal-country-row"
            className="flex flex-col gap-2 sm:flex-row"
          >
            <Input
              value={postal}
              onChange={(e) => setPostal(e.target.value)}
              placeholder="Postcode"
              aria-label="Postcode"
              autoComplete="postal-code"
              className="w-full sm:flex-[2]"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <div className="relative w-full min-w-0 sm:flex-1">
              <Input
                id="nearby-place-country"
                aria-label="Country code"
                aria-expanded={countryListOpen}
                aria-controls="nearby-place-country-list"
                aria-autocomplete="list"
                role="combobox"
                autoCapitalize="characters"
                autoComplete="country"
                inputMode="text"
                maxLength={2}
                placeholder="Code"
                value={countryQuery || countryCode}
                className="w-full uppercase"
                onChange={(event) => {
                  const nextValue = event.target.value.replace(/[^a-z]/gi, "").slice(0, 2).toUpperCase();
                  setCountryQuery(nextValue);
                  setCountryCode(COUNTRY_OPTIONS.some((option) => option.value === nextValue) ? nextValue : "");
                  setCountryListOpen(true);
                  setError(null);
                }}
                onFocus={() => setCountryListOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setCountryListOpen(false);
                    return;
                  }
                  if (event.key === "Enter") {
                    if (countryListOpen && firstCountryOption) {
                      event.preventDefault();
                      selectCountry(firstCountryOption.value);
                      return;
                    }
                    submit();
                  }
                }}
              />
              {countryListOpen ? (
                <div
                  id="nearby-place-country-list"
                  role="listbox"
                  aria-label="Country code options"
                  className="mt-2 max-h-[min(42dvh,18rem)] overflow-y-auto rounded-[var(--app-radius-md)] border border-[color:var(--app-separator)] bg-[color:var(--app-secondary-surface)] p-1 shadow-[var(--app-card-shadow-standard)]"
                >
                  {filteredCountryOptions.length > 0 ? (
                    filteredCountryOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        value={option.value}
                        role="option"
                        aria-label={`${option.value} - ${option.label}`}
                        aria-selected={option.value === countryCode}
                        className="flex min-h-10 w-full items-center gap-3 rounded-[var(--app-radius-sm)] px-3 text-left text-foreground transition-colors hover:bg-[color:var(--app-card-surface-compact)] focus-visible:bg-[color:var(--app-card-surface-compact)] focus-visible:outline-none"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => selectCountry(option.value)}
                      >
                        <span className="w-8 shrink-0 text-[13px] font-semibold tracking-[0.08em]">
                          {option.value}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[15px]">
                          {option.label}
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="px-3 py-2 text-[13px] text-muted-foreground">
                      No country codes found.
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
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

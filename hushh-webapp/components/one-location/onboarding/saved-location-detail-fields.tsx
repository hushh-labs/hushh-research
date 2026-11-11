"use client";

import type { ReactNode } from "react";
import type { SavedLocationCategory } from "@/lib/one-location/saved-locations";
import type { SavedLocationAddressDetails } from "@/lib/one-location/saved-location-address";
import { cn } from "@/lib/utils";
import { ADDRESS_LABEL_ROW_CLASSNAME, REQUIRED_BADGE_CLASSNAME, OPTIONAL_BADGE_CLASSNAME } from "./save-location-sheet-layout";

/** Controlled fields: the shared modal owns all values, validation and saving. */
export function SavedLocationDetailFields({
  effectiveAddressLine, addressLineError, addressLineErrorId, setAddressLineValue,
  setAddressTouched, interactionBusy, deferredUntilVault, addressDetails,
  updateAddressDetail, category, customLabel, setCustomLabel,
  controlLabelClassName, controlInputClassName, categoryPicker,
}: {
  effectiveAddressLine: string;
  addressLineError: boolean;
  addressLineErrorId: string;
  setAddressLineValue: (value: string) => void;
  setAddressTouched: (value: boolean) => void;
  interactionBusy: boolean;
  deferredUntilVault: boolean;
  addressDetails: SavedLocationAddressDetails;
  updateAddressDetail: (field: keyof SavedLocationAddressDetails, value: string) => void;
  category: SavedLocationCategory | null;
  customLabel: string;
  setCustomLabel: (value: string) => void;
  controlLabelClassName: string;
  controlInputClassName: string;
  categoryPicker: ReactNode;
}) {
  return (
    <section
      className="min-w-0 space-y-4"
      aria-label="Place details"
    >
      <div>
        <div className={ADDRESS_LABEL_ROW_CLASSNAME}>
          <label data-location-type-role="form-label"
            htmlFor="onboarding-saved-location-address"
            className={cn(controlLabelClassName, "mb-0")}
          >
            Address
          </label>
          <span data-location-type-role="row-description" aria-hidden className={REQUIRED_BADGE_CLASSNAME}>
            Required
          </span>
        </div>
        <input data-location-type-role="input"
          id="onboarding-saved-location-address"
          type="text"
          required
          aria-required="true"
          aria-invalid={addressLineError}
          aria-describedby={
            addressLineError ? addressLineErrorId : undefined
          }
          value={effectiveAddressLine}
          onChange={(event) =>
            setAddressLineValue(event.target.value)
          }
          onBlur={() => setAddressTouched(true)}
          disabled={interactionBusy}
          maxLength={300}
          autoComplete={
            deferredUntilVault ? "off" : "street-address"
          }
          placeholder="12 MG Road, Bengaluru"
          className={cn(
            controlInputClassName,
            "aria-[invalid=true]:border-[color:var(--app-destructive)]",
          )}
        />
        {addressLineError ? (
          <p data-location-type-role="row-description"
            id={addressLineErrorId}
            role="alert"
            className="mt-1.5 text-[13px] leading-[18px] text-[color:var(--app-destructive)]"
          >
            Enter the address.
          </p>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <div>
          <div className={ADDRESS_LABEL_ROW_CLASSNAME}>
            <label data-location-type-role="form-label"
              htmlFor="onboarding-saved-location-house"
              className={cn(controlLabelClassName, "mb-0")}
            >
              House or flat
            </label>
            <span data-location-type-role="row-description" aria-hidden className={OPTIONAL_BADGE_CLASSNAME}>
              Optional
            </span>
          </div>
          <input data-location-type-role="input"
            id="onboarding-saved-location-house"
            type="text"
            value={addressDetails.houseOrFlat}
            onChange={(event) =>
              updateAddressDetail("houseOrFlat", event.target.value)
            }
            disabled={interactionBusy}
            maxLength={80}
            autoComplete={
              deferredUntilVault ? "off" : "address-line1"
            }
            placeholder="Flat 4B, Tower 2"
            className={controlInputClassName}
          />
        </div>
        <div>
          <div className={ADDRESS_LABEL_ROW_CLASSNAME}>
            <label data-location-type-role="form-label"
              htmlFor="onboarding-saved-location-landmark"
              className={cn(controlLabelClassName, "mb-0")}
            >
              Landmark
            </label>
            <span data-location-type-role="row-description" aria-hidden className={OPTIONAL_BADGE_CLASSNAME}>
              Optional
            </span>
          </div>
          <input data-location-type-role="input"
            id="onboarding-saved-location-landmark"
            type="text"
            value={addressDetails.landmark}
            onChange={(event) =>
              updateAddressDetail("landmark", event.target.value)
            }
            disabled={interactionBusy}
            maxLength={100}
            autoComplete={
              deferredUntilVault ? "off" : "address-line2"
            }
            placeholder="e.g. Opposite City Hospital"
            className={controlInputClassName}
          />
        </div>
      </div>

      {categoryPicker}

      {category === "other" ? (
        <div className="[animation:saveLocFadeIn_.2s_ease-out_both]">
          <label data-location-type-role="form-label"
            htmlFor="onboarding-saved-location-name"
            className={controlLabelClassName}
          >
            Name it
          </label>
          <input data-location-type-role="input"
            id="onboarding-saved-location-name"
            type="text"
            value={customLabel}
            onChange={(event) => setCustomLabel(event.target.value)}
            disabled={interactionBusy}
            maxLength={40}
            placeholder="Gym, parents' house"
            className={controlInputClassName}
          />
        </div>
      ) : null}

    </section>
  );
}

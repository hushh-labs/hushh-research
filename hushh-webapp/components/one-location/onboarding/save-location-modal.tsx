"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  Briefcase,
  Check,
  Home,
  Loader2,
  Map as MapIcon,
  MapPin,
  Pencil,
  Search,
  X,
} from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  LocationPickerMap,
  type PickedLocation,
} from "@/components/one-location/onboarding/location-picker-map";
import { cn } from "@/lib/utils";
import type { SavedLocationCategory } from "@/lib/one-location/saved-locations";
import {
  EMPTY_SAVED_LOCATION_ADDRESS_DETAILS,
  inferSavedLocationAddressDetails,
  isValidPostalCode,
  normalizeSavedLocationAddressDetails,
  type SavedLocationAddressDetails,
} from "@/lib/one-location/saved-location-address";

const iconButtonClassName =
  "press-scale absolute flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill-strong)] text-[color:var(--app-secondary-label)] transition-colors hover:bg-[color:var(--app-neutral-fill-strong)]/80 disabled:opacity-45";

const controlLabelClassName =
  "mb-1.5 block text-[13px] font-semibold leading-[18px] text-muted-foreground";

const controlInputClassName =
  "h-12 w-full rounded-[14px] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] px-4 text-[15px] leading-5 text-foreground outline-none transition-colors placeholder:text-[color:var(--app-tertiary-label)] focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent)]/25 disabled:opacity-60";

export type SavedLocationPlaceSuggestion = {
  placeId: string;
  text: string;
};

export type SaveLocationModalProps = {
  open: boolean;
  /** Reverse-geocoded address for display. */
  address?: string | null;
  /** True while the location capture is still resolving. */
  loadingAddress?: boolean;
  /** True while a save is in flight. */
  saving?: boolean;
  /** Authenticated Maps search; selected place details replace point + copy. */
  onSearchPlaces?: (input: string) => Promise<SavedLocationPlaceSuggestion[]>;
  onSelectPlace?: (placeId: string) => Promise<void>;
  /**
   * Current captured coordinate used to seed the drag-to-pin map picker. When
   * provided together with `onPickExactLocation`, an "Adjust on map" action lets
   * the owner confirm their entrance instead of trusting the coarse GPS fix.
   */
  mapInitial?: { latitude: number; longitude: number } | null;
  /** Server reverse-geocode so the picker keeps the address synced to the pin. */
  reverseGeocode?: (lat: number, lng: number) => Promise<string | null>;
  /** Recenter the picker on the live device GPS fix. */
  onLocateMe?: () => Promise<{ latitude: number; longitude: number } | null>;
  /** Commit the owner-confirmed coordinate + address chosen on the map. */
  onPickExactLocation?: (picked: PickedLocation) => void;
  /** Open directly on the map instead of making the owner find an extra CTA. */
  startWithMapPicker?: boolean;
  /** Follow pin confirmation with the complete entrance/address detail step. */
  collectAddressDetails?: boolean;
  /** Pre-select a category when editing an existing saved place. */
  initialCategory?: SavedLocationCategory | null;
  /** Pre-fill the custom label (for an "Other" place) when editing. */
  initialCustomLabel?: string | null;
  /** Pre-fill the structured address detail fields when editing. */
  initialDetails?: SavedLocationAddressDetails | null;
  /** Copy shown on the primary action button (e.g. "Save" vs "Update"). */
  saveLabel?: string;
  /** Explain that a pre-vault draft is held only for the active setup session. */
  deferredUntilVault?: boolean;

  /** Accuracy reported for the initial device fix, never persisted or displayed raw. */
  initialAccuracyM?: number | null;
  /** Existing durable acceptance of the shared Google Maps renderer disclosure. */
  rendererDisclosureAccepted?: boolean;
  /** Persist renderer acceptance when vault authority exists. */
  onAcceptRendererDisclosure?: () => Promise<void>;
  onSave: (
    category: SavedLocationCategory,
    label: string,
    details?: SavedLocationAddressDetails,
    /**
     * The street address as it stands in the Address field -- detected from
     * the pin, or typed over it. Passed separately from `details` so callers
     * compose the saved line from its parts instead of layering this save on
     * top of whatever the last one produced.
     */
    addressLine?: string | null,
  ) => void;
  onSkip: () => void;
};

type SaveLocationFlowStep = "summary" | "map" | "details";

/**
 * Fold what a detected address can tell us into the form, leaving anything the
 * person typed alone.
 *
 * Defined outside the component and taking its "has been edited" flags as an
 * argument so the rule reads as one thing rather than as three closures that
 * each have to remember to check a ref.
 */
function detectedAddressDetails(
  current: SavedLocationAddressDetails,
  address: string | null,
  edited: { houseOrFlat: boolean; postalCode: boolean },
): SavedLocationAddressDetails {
  const inferred = inferSavedLocationAddressDetails(address);
  return {
    ...current,
    houseOrFlat: edited.houseOrFlat ? current.houseOrFlat : inferred.houseOrFlat,
    postalCode: edited.postalCode ? current.postalCode : inferred.postalCode,
  };
}

const CATEGORY_OPTIONS: {
  category: SavedLocationCategory;
  label: string;
  Icon: typeof Home;
}[] = [
  { category: "home", label: "Home", Icon: Home },
  { category: "work", label: "Work", Icon: Briefcase },
  { category: "other", label: "Other", Icon: MapPin },
];

function SavedLocationCategoryPicker({
  value,
  disabled,
  onChange,
}: {
  value: SavedLocationCategory | null;
  disabled: boolean;
  onChange: (category: SavedLocationCategory) => void;
}) {
  return (
    <div role="group" aria-label="Saved location category">
      <p className={controlLabelClassName}>
        What kind of place is this?
      </p>
      <div className="grid grid-cols-3 gap-2.5">
        {CATEGORY_OPTIONS.map(({ category, label, Icon }) => {
          const selected = value === category;
          return (
            <button
              key={category}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(category)}
              disabled={disabled}
              className={cn(
                "press-scale flex min-h-[82px] flex-col items-center justify-center gap-2 rounded-[14px] border px-2 py-3 transition-colors disabled:opacity-45",
                selected
                  ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)]/10 text-[color:var(--app-accent)]"
                  : "border-border/70 bg-[color:var(--app-card-surface-default-solid)] text-muted-foreground hover:bg-foreground/[0.03]",
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={1.9} aria-hidden />
              <span className="text-[13px] font-semibold leading-[18px]">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * SaveLocationModal — a focused, responsive prompt shown during Location
 * onboarding after access is ready. The owner can correct the captured place
 * before tagging it as Home / Work / Other. Because a coarse GPS fix rarely lands
 * on the exact doorstep, the owner can open a drag-to-pin map picker (like other
 * apps) to place their precise spot. The shared dialog primitive owns focus
 * trapping, focus restoration, Escape handling, and screen-reader semantics.
 */
export function SaveLocationModal({
  open,
  address,
  loadingAddress = false,
  saving = false,
  onSearchPlaces,
  onSelectPlace,
  mapInitial,
  reverseGeocode,
  onLocateMe,
  onPickExactLocation,
  startWithMapPicker = false,
  collectAddressDetails = false,
  initialCategory = null,
  initialCustomLabel = null,
  initialDetails = null,
  saveLabel = "Save location",
  deferredUntilVault = false,
  initialAccuracyM = null,

  rendererDisclosureAccepted = false,
  onAcceptRendererDisclosure,
  onSave,
  onSkip,
}: SaveLocationModalProps) {
  const [category, setCategory] = useState<SavedLocationCategory | null>(null);
  const [customLabel, setCustomLabel] = useState("");
  const [editingPlace, setEditingPlace] = useState(false);
  const [flowStep, setFlowStep] = useState<SaveLocationFlowStep>("summary");
  const [pickedAddress, setPickedAddress] = useState<string | null>(null);
  /**
   * Ticked: the fields below are filled from whatever the pin resolves to, and
   * keep following it as the pin moves. Unticked: they are cleared and left
   * alone. Anything typed by hand wins either way -- see the edited refs.
   */
  const [useDetectedAddress, setUseDetectedAddress] = useState(true);
  const [addressDetails, setAddressDetails] =
    useState<SavedLocationAddressDetails>(EMPTY_SAVED_LOCATION_ADDRESS_DETAILS);
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeSuggestions, setPlaceSuggestions] = useState<
    SavedLocationPlaceSuggestion[]
  >([]);
  const [placeSearching, setPlaceSearching] = useState(false);
  const [placeSearchError, setPlaceSearchError] = useState<string | null>(null);
  const [selectingPlaceId, setSelectingPlaceId] = useState<string | null>(null);
  const [rendererDisclosureReady, setRendererDisclosureReady] = useState(
    rendererDisclosureAccepted,
  );
  const rendererReady = rendererDisclosureReady || rendererDisclosureAccepted;
  const descriptionId = useId();
  const postalCodeErrorId = useId();
  const mapTitleRef = useRef<HTMLHeadingElement | null>(null);
  const detailsTitleRef = useRef<HTMLHeadingElement | null>(null);
  // A field the person has typed in is theirs. The pin may fill a blank field
  // and refill it as it moves, but it must never overwrite an answer someone
  // gave -- a prefill that fights the typing is worse than no prefill.
  const postalCodeEditedRef = useRef(false);
  const houseOrFlatEditedRef = useRef(false);

  // Reset internal selection each time the modal (re)opens. When editing an
  // existing saved place, seed the category/label/detail fields from the
  // provided initial values so the same add flow doubles as an update flow.
  useEffect(() => {
    if (open) {
      // Treat provided initial details (edit mode) as already user-authored so
      // the inferred-postal effect does not clobber them.
      postalCodeEditedRef.current = Boolean(
        initialDetails && initialDetails.postalCode,
      );
      houseOrFlatEditedRef.current = Boolean(
        initialDetails && initialDetails.houseOrFlat,
      );
      setCategory(initialCategory ?? null);
      setCustomLabel(initialCustomLabel ?? "");
      setEditingPlace(false);
      setPickedAddress(null);
      setUseDetectedAddress(true);
      setAddressDetails(
        initialDetails
          ? { ...EMPTY_SAVED_LOCATION_ADDRESS_DETAILS, ...initialDetails }
          : { ...EMPTY_SAVED_LOCATION_ADDRESS_DETAILS },
      );
      setPlaceQuery("");
      setPlaceSuggestions([]);
      setPlaceSearching(false);
      setPlaceSearchError(null);
      setSelectingPlaceId(null);
      setRendererDisclosureReady(false);
    }
    // Initial* props are read once per open; excluded to avoid mid-session
    // resets while the modal is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);


  useEffect(() => {
    if (!open || !editingPlace || !onSearchPlaces) return;
    const input = placeQuery.trim();
    if (input.length < 2) {
      setPlaceSuggestions([]);
      setPlaceSearching(false);
      setPlaceSearchError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPlaceSearching(true);
      setPlaceSearchError(null);
      void onSearchPlaces(input)
        .then((suggestions) => {
          if (cancelled) return;
          setPlaceSuggestions(suggestions);
          if (suggestions.length === 0) {
            setPlaceSearchError("No matching places found.");
          }
        })
        .catch(() => {
          if (cancelled) return;
          setPlaceSuggestions([]);
          setPlaceSearchError("Could not search places. Please try again.");
        })
        .finally(() => {
          if (!cancelled) setPlaceSearching(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [editingPlace, onSearchPlaces, open, placeQuery]);

  const resolvedAddress = (address && address.trim()) || null;
  const changingPlace = selectingPlaceId !== null;
  const interactionBusy = saving || changingPlace;
  const canEditPlace = Boolean(onSearchPlaces && onSelectPlace);
  const canPickOnMap = Boolean(
    onPickExactLocation &&
    mapInitial &&
    Number.isFinite(mapInitial.latitude) &&
    Number.isFinite(mapInitial.longitude),
  );
  useEffect(() => {
    if (!open) return;
    if (startWithMapPicker && canPickOnMap) {
      setFlowStep("map");
      return;
    }
    setFlowStep(collectAddressDetails ? "details" : "summary");
  }, [canPickOnMap, collectAddressDetails, open, startWithMapPicker]);

  useEffect(() => {
    if (!open) return;
    const next = (address && address.trim()) || null;
    if (next) setPickedAddress(next);
    if (!useDetectedAddress) return;
    // Spread the detected address across the fields it can actually answer.
    // It was previously only mined for a postal code, so a person looking at
    // "B-284/3, Rd Number 1, ..." on screen still had to retype B-284/3 into
    // the box directly underneath it.
    setAddressDetails((current) =>
      detectedAddressDetails(current, next, {
        houseOrFlat: houseOrFlatEditedRef.current,
        postalCode: postalCodeEditedRef.current,
      }),
    );
  }, [address, open, useDetectedAddress]);

  useEffect(() => {
    if (!open) return;
    const title =
      flowStep === "map"
        ? mapTitleRef.current
        : flowStep === "details"
          ? detailsTitleRef.current
          : null;
    title?.focus({ preventScroll: true });
  }, [flowStep, open, rendererReady]);

  const normalizedAddressDetails =
    normalizeSavedLocationAddressDetails(addressDetails);
  const detectedAddress = pickedAddress || resolvedAddress || "";
  const postalCodeInvalid =
    normalizedAddressDetails.postalCode.length > 0 &&
    !isValidPostalCode(normalizedAddressDetails.postalCode);
  /**
   * Why the primary button is off, in the person's own terms, or null when it
   * is on. This exists because the button used to just sit there dead: House,
   * flat was required and blank, so "Update location" could not be pressed and
   * nothing on screen said why -- which is what "saving address not working"
   * looked like from the outside.
   *
   * The gate is now the one thing saving an address actually needs: an
   * address. The entrance details are enrichment and no longer block a save.
   */
  const saveBlockedReason: string | null =
    saving || changingPlace || loadingAddress || editingPlace || flowStep === "map"
      ? null
      : category === null
        ? "Pick Home, Work or Other first."
        : collectAddressDetails && detectedAddress.length === 0
          ? "Pin a spot on the map first."
          : postalCodeInvalid
            ? // Not the field's own wording. The invalid PIN already says
              // "Enter a valid PIN or postal code." right next to itself, and
              // the same sentence twice on one screen reads as a stutter
              // rather than as two places worth looking.
              "Check the PIN or postal code above."
            : null;
  const canSave =
    category !== null &&
    !saving &&
    !loadingAddress &&
    !editingPlace &&
    flowStep !== "map" &&
    !changingPlace &&
    saveBlockedReason === null;

  const handleSelectPlace = async (placeId: string) => {
    if (!onSelectPlace || changingPlace) return;
    setSelectingPlaceId(placeId);
    setPlaceSearchError(null);
    try {
      await onSelectPlace(placeId);
      setEditingPlace(false);
      setPlaceQuery("");
      setPlaceSuggestions([]);
    } catch {
      setPlaceSearchError("Could not update this place. Please try again.");
    } finally {
      setSelectingPlaceId(null);
    }
  };

  const handleConfirmMapPick = (picked: PickedLocation) => {
    onPickExactLocation?.(picked);
    setPickedAddress(picked.address);
    if (useDetectedAddress) {
      setAddressDetails((current) =>
        detectedAddressDetails(current, picked.address, {
          houseOrFlat: houseOrFlatEditedRef.current,
          postalCode: postalCodeEditedRef.current,
        }),
      );
    }
    setFlowStep(collectAddressDetails ? "details" : "summary");
  };

  const handleAcceptRendererDisclosure = async () => {
    await onAcceptRendererDisclosure?.();
    setRendererDisclosureReady(true);
  };

  const handleSave = () => {
    if (!category || !canSave) return;
    const label =
      category === "other" ? customLabel.trim() || "Other" : undefined;
    if (collectAddressDetails) {
      onSave(
        category,
        label ?? "",
        normalizedAddressDetails,
        detectedAddress || null,
      );
      return;
    }
    onSave(category, label ?? "");
  };

  const updateAddressDetail = (
    key: keyof SavedLocationAddressDetails,
    value: string,
  ) => {
    if (key === "postalCode") postalCodeEditedRef.current = true;
    if (key === "houseOrFlat") houseOrFlatEditedRef.current = true;
    setAddressDetails((current) => ({ ...current, [key]: value }));
  };

  return (
    <Dialog
      open={open}
      modal
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !interactionBusy) onSkip();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="save-location-modal"
        aria-describedby={descriptionId}
        overlayClassName="z-[559] bg-black/45 backdrop-blur-[6px]"
        onEscapeKeyDown={(event) => {
          if (interactionBusy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (interactionBusy || flowStep === "map") event.preventDefault();
        }}
        className={cn(
          "z-[560] bottom-[var(--kb-height,0px)] top-auto max-h-[min(92dvh,760px)] w-full max-w-[420px] translate-y-0 gap-5 overflow-y-auto",
          "rounded-b-none rounded-t-[24px] sm:bottom-auto sm:top-[50%] sm:translate-y-[-50%] sm:rounded-[20px]",
          "border border-border/60 bg-[color:var(--app-card-surface-default-solid)] p-5 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] shadow-none sm:p-6 sm:pb-6",
        )}
      >
        {flowStep === "map" && canPickOnMap ? (
          <>
            <DialogTitle ref={mapTitleRef} tabIndex={-1} className="sr-only">
              {rendererReady ? "Pin your entrance" : "Before Google Maps opens"}
            </DialogTitle>
            <p id={descriptionId} className="sr-only">
              {rendererReady
                ? "Step one of two. Move the map so the centre pin sits on your entrance, then confirm it."
                : "Review how Google Maps uses the selected point before opening the map."}
            </p>
            {collectAddressDetails ? (
              <p className="text-[13px] font-normal leading-[18px] tracking-normal text-[color:var(--app-accent-deep,#0b62c4)] dark:text-[#9bc7f5]">
                Step 1 of 2
              </p>
            ) : null}
            <LocationPickerMap
              initialLatitude={mapInitial!.latitude}
              initialLongitude={mapInitial!.longitude}
              initialAddress={pickedAddress || resolvedAddress}
              initialAccuracyM={initialAccuracyM}
              reverseGeocode={reverseGeocode}
              onLocateMe={onLocateMe}
              onConfirm={handleConfirmMapPick}
              onCancel={() => {
                if (startWithMapPicker) {
                  onSkip();
                  return;
                }
                setFlowStep("summary");
              }}
              rendererDisclosureAccepted={rendererReady}
              onAcceptRendererDisclosure={handleAcceptRendererDisclosure}
              confirmLabel={
                collectAddressDetails ? "Confirm pin" : "Confirm location"
              }
              cancelLabel={startWithMapPicker ? "Skip for now" : "Cancel"}
            />
          </>
        ) : flowStep === "details" && collectAddressDetails ? (
          <>
            <button
              type="button"
              onClick={() =>
                canPickOnMap ? setFlowStep("map") : setFlowStep("summary")
              }
              disabled={interactionBusy}
              aria-label={canPickOnMap ? "Back to map" : "Back"}
              className={cn(iconButtonClassName, "left-4 top-4")}
            >
              <ArrowLeft className="h-4.5 w-4.5" strokeWidth={2.4} />
            </button>
            <button
              type="button"
              onClick={onSkip}
              disabled={interactionBusy}
              aria-label="Close"
              className={cn(iconButtonClassName, "right-4 top-4")}
            >
              <X className="h-4.5 w-4.5" strokeWidth={2.4} />
            </button>

            <header className="px-9 text-center">
              <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                Step 2 of 2
              </p>
              <DialogTitle
                ref={detailsTitleRef}
                tabIndex={-1}
                className="mt-1 text-[28px] font-bold leading-[1.12] tracking-normal text-foreground outline-none"
              >
                Add your address details
              </DialogTitle>
              <p
                id={descriptionId}
                className="mt-2 text-[15px] leading-5 text-muted-foreground"
              >
                Only the address is needed. The rest helps at the door.
              </p>
            </header>

            {/* The detected address, shown as the thing the fields below were
                filled from. */}
            <div className="flex items-start gap-2.5 rounded-[14px] bg-[color:var(--app-card-surface-compact)] px-3.5 py-3">
              <span className="mt-0.5 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)]">
                <MapPin className="h-[17px] w-[17px]" strokeWidth={1.9} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                  Pinned location
                </p>
                <p className="mt-0.5 line-clamp-2 text-[15px] font-semibold leading-5 text-foreground">
                  {loadingAddress
                    ? "Finding your address…"
                    : detectedAddress || "Your selected map point"}
                </p>
              </div>
              {canPickOnMap ? (
                <button
                  type="button"
                  onClick={() => setFlowStep("map")}
                  disabled={interactionBusy}
                  className="press-scale shrink-0 rounded-full bg-[color:var(--app-accent)]/12 px-2.5 py-1.5 text-[13px] font-semibold text-[color:var(--app-accent)] disabled:opacity-45"
                >
                  Edit pin
                </button>
              ) : null}
            </div>

            {/* Ticked, the fields below are filled from that address and keep
                following the pin. Unticked, they are cleared and left alone.
                Anything typed by hand survives either way. */}
            <label className="flex cursor-pointer items-center gap-2 px-1 text-[13px] leading-[18px] text-muted-foreground">
              <input
                type="checkbox"
                checked={useDetectedAddress}
                onChange={(event) => {
                  const next = event.target.checked;
                  setUseDetectedAddress(next);
                  // Both directions act now rather than at the next pin move,
                  // so the box never reads as on while the fields disagree
                  // with it. Unticking forgets that anything was typed, which
                  // is what makes re-ticking a clean redo.
                  houseOrFlatEditedRef.current = false;
                  postalCodeEditedRef.current = false;
                  setAddressDetails((current) =>
                    detectedAddressDetails(current, next ? detectedAddress : null, {
                      houseOrFlat: false,
                      postalCode: false,
                    }),
                  );
                }}
                disabled={interactionBusy}
                className="h-[15px] w-[15px] shrink-0 accent-[color:var(--app-accent)] disabled:opacity-45"
              />
              Fill the fields below from this address
            </label>

            <div className="space-y-3.5">
              <div>
                <label
                  htmlFor="saved-location-house-or-flat"
                  className={controlLabelClassName}
                >
                  House, flat, floor or block{" "}
                  <span className="font-normal">(optional)</span>
                </label>
                <input
                  id="saved-location-house-or-flat"
                  type="text"
                  value={addressDetails.houseOrFlat}
                  onChange={(event) =>
                    updateAddressDetail("houseOrFlat", event.target.value)
                  }
                  disabled={interactionBusy}
                  maxLength={80}
                  autoComplete={deferredUntilVault ? "off" : "address-line1"}
                  placeholder="e.g. Flat 4B, Tower 2"
                  className={controlInputClassName}
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="saved-location-building-color"
                    className={controlLabelClassName}
                  >
                    Building colour{" "}
                    <span className="font-normal">(optional)</span>
                  </label>
                  <input
                    id="saved-location-building-color"
                    type="text"
                    value={addressDetails.buildingColor}
                    onChange={(event) =>
                      updateAddressDetail("buildingColor", event.target.value)
                    }
                    disabled={interactionBusy}
                    maxLength={40}
                    autoComplete="off"
                    placeholder="e.g. Blue gate"
                    className={controlInputClassName}
                  />
                </div>
                <div>
                  <label
                    htmlFor="saved-location-postal-code"
                    className={controlLabelClassName}
                  >
                    PIN / postal code{" "}
                    <span className="font-normal">(optional)</span>
                  </label>
                  <input
                    id="saved-location-postal-code"
                    type="text"
                    value={addressDetails.postalCode}
                    onChange={(event) =>
                      updateAddressDetail("postalCode", event.target.value)
                    }
                    disabled={interactionBusy}
                    maxLength={12}
                    inputMode="text"
                    autoComplete={deferredUntilVault ? "off" : "postal-code"}
                    aria-describedby={
                      addressDetails.postalCode.length > 0 &&
                      !isValidPostalCode(addressDetails.postalCode)
                        ? postalCodeErrorId
                        : undefined
                    }
                    aria-invalid={
                      addressDetails.postalCode.length > 0 &&
                      !isValidPostalCode(addressDetails.postalCode)
                    }
                    placeholder="e.g. 560001"
                    className={cn(
                      controlInputClassName,
                      "aria-[invalid=true]:border-[color:var(--app-destructive)]",
                    )}
                  />
                  {addressDetails.postalCode.length > 0 &&
                  !isValidPostalCode(addressDetails.postalCode) ? (
                    <p
                      id={postalCodeErrorId}
                      role="alert"
                      className="mt-1.5 text-[13px] leading-[18px] text-[color:var(--app-destructive)]"
                    >
                      Enter a valid PIN or postal code.
                    </p>
                  ) : null}
                </div>
              </div>

              <div>
                <label
                  htmlFor="saved-location-landmark"
                  className={controlLabelClassName}
                >
                  Nearby landmark{" "}
                  <span className="font-normal">(optional)</span>
                </label>
                <input
                  id="saved-location-landmark"
                  type="text"
                  value={addressDetails.landmark}
                  onChange={(event) =>
                    updateAddressDetail("landmark", event.target.value)
                  }
                  disabled={interactionBusy}
                  maxLength={100}
                  autoComplete={deferredUntilVault ? "off" : "address-line2"}
                  placeholder="e.g. Opposite City Mall"
                  className={controlInputClassName}
                />
              </div>
            </div>

            <SavedLocationCategoryPicker
              value={category}
              disabled={interactionBusy}
              onChange={setCategory}
            />

            {category === "other" ? (
              <div className="[animation:saveLocFadeIn_.2s_ease-out_both]">
                <label
                  htmlFor="saved-location-details-custom-label"
                  className={controlLabelClassName}
                >
                  Give it a name <span className="font-normal">(optional)</span>
                </label>
                <input
                  id="saved-location-details-custom-label"
                  type="text"
                  value={customLabel}
                  onChange={(event) => setCustomLabel(event.target.value)}
                  disabled={interactionBusy}
                  maxLength={40}
                  placeholder="e.g. Gym, parents' house"
                  className={controlInputClassName}
                />
              </div>
            ) : null}

            <p className="rounded-[14px] bg-[color:var(--app-card-surface-compact)] px-3.5 py-3 text-[13px] leading-[18px] text-muted-foreground">
              {deferredUntilVault
                ? "Held for this session. One encrypts it once your vault is ready."
                : "Encrypted in your vault. Shared only when you approve access."}
            </p>

            <div className="sticky bottom-0 z-20 -mx-3 mt-1 flex flex-col gap-2.5 rounded-t-[18px] border-t border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-default-solid)]/95 px-3 pb-1 pt-3 backdrop-blur">
              {/* A disabled primary button with no explanation is the whole of
                  "saving is not working" from the outside. When it is off, say
                  which single thing turns it on. */}
              {saveBlockedReason ? (
                <p
                  role="status"
                  className="text-center text-[13px] leading-[18px] text-muted-foreground"
                >
                  {saveBlockedReason}
                </p>
              ) : null}
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                aria-busy={saving || undefined}
                className={cn(
                  "press-scale flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[17px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                  "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]",
                )}
              >
                {saving ? (
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                ) : (
                  <Check className="h-5 w-5" strokeWidth={2.6} aria-hidden />
                )}
                {saveLabel}
              </button>
              <button
                type="button"
                onClick={onSkip}
                disabled={interactionBusy}
                className="h-11 w-full rounded-full text-[15px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                Skip for now
              </button>
            </div>
          </>
        ) : (

          <>
            <button
              type="button"
              onClick={onSkip}
              disabled={interactionBusy}
              aria-label="Close"
              className={cn(iconButtonClassName, "right-4 top-4")}
            >
              <X className="h-4.5 w-4.5" strokeWidth={2.4} />
            </button>

            <header className="pr-8">
              <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)]">
                <MapPin className="h-[17px] w-[17px]" strokeWidth={1.9} />
              </span>
              <DialogTitle className="mt-3 text-[28px] font-bold leading-[1.12] tracking-normal text-foreground">
                Save this place
              </DialogTitle>
              <p
                id={descriptionId}
                className="mt-2 text-[15px] leading-5 text-muted-foreground"
              >
                Tag where you are so One can personalise your experience. It
                stays encrypted in your vault and is shared only when you
                approve location access.
              </p>
            </header>

            <div className="flex items-center gap-2.5 rounded-[14px] bg-[color:var(--app-card-surface-compact)] px-3.5 py-3">
              <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)]">
                <MapPin className="h-[17px] w-[17px]" strokeWidth={1.9} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                  Current location
                </p>
                {loadingAddress ? (
                  <span className="mt-0.5 flex items-center gap-1.5 text-[15px] leading-5 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Finding
                    your address…
                  </span>
                ) : (
                  <p className="mt-0.5 truncate text-[15px] font-semibold leading-5 text-foreground">
                    {resolvedAddress || "Address unavailable"}
                  </p>
                )}
              </div>
              {canEditPlace && !loadingAddress ? (
                <button
                  type="button"
                  onClick={() => {
                    setEditingPlace(true);
                    setPlaceQuery("");
                    setPlaceSuggestions([]);
                    setPlaceSearchError(null);
                  }}
                  disabled={interactionBusy}
                  className="press-scale inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-[color:var(--app-accent)]/12 px-2.5 text-[13px] font-semibold text-[color:var(--app-accent)] disabled:opacity-45"
                  aria-label="Change captured location"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  Change
                </button>
              ) : null}
            </div>

            {canPickOnMap && !loadingAddress ? (
              <button
                type="button"
                onClick={() => setFlowStep("map")}
                disabled={interactionBusy}
                data-testid="save-location-adjust-on-map"
                className="press-scale flex w-full items-center gap-3 rounded-[14px] border border-dashed border-[color:var(--app-accent)]/35 bg-[color:var(--app-accent)]/10 px-3.5 py-3 text-left transition-colors hover:bg-[color:var(--app-accent)]/15 disabled:opacity-45"
              >
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)]">
                  <MapIcon className="h-[17px] w-[17px]" strokeWidth={1.9} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold leading-5 text-[color:var(--app-accent)]">
                    Pin your entrance on the map
                  </span>
                  <span className="block text-[13px] leading-[18px] text-muted-foreground">
                    GPS can be off by a few meters — drag the pin to your door.
                  </span>
                </span>
              </button>
            ) : null}

            {editingPlace ? (
              <div className="space-y-2.5 [animation:saveLocFadeIn_.2s_ease-out_both]">
                <label
                  htmlFor="saved-location-place-search"
                  className={controlLabelClassName}
                >
                  Search for another place
                </label>
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--app-tertiary-label)]"
                    aria-hidden
                  />
                  <input
                    id="saved-location-place-search"
                    type="search"
                    value={placeQuery}
                    onChange={(event) => setPlaceQuery(event.target.value)}
                    disabled={interactionBusy}
                    autoComplete="off"
                    placeholder="Search address or place"
                    className={cn(controlInputClassName, "pl-10 pr-10")}
                  />
                  {placeSearching || changingPlace ? (
                    <Loader2
                      className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[color:var(--app-tertiary-label)]"
                      aria-label="Searching places"
                    />
                  ) : null}
                </div>

                {placeSuggestions.length > 0 ? (
                  <div
                    className="max-h-40 overflow-y-auto rounded-[14px] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] p-1 shadow-none"
                    aria-label="Location suggestions"
                  >
                    {placeSuggestions.map((suggestion) => (
                      <button
                        key={suggestion.placeId}
                        type="button"
                        onClick={() =>
                          void handleSelectPlace(suggestion.placeId)
                        }
                        disabled={interactionBusy}
                        className="flex min-h-11 w-full items-start gap-2 rounded-[10px] px-3 py-2.5 text-left text-[15px] leading-5 text-foreground hover:bg-foreground/[0.04] disabled:opacity-45"
                      >
                        <MapPin
                          className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--app-accent)]"
                          aria-hidden
                        />
                        <span>{suggestion.text}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {placeSearchError ? (
                  <p
                    role="alert"
                    className="text-[13px] leading-[18px] text-[color:var(--app-destructive)]"
                  >
                    {placeSearchError}
                  </p>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    setEditingPlace(false);
                    setPlaceQuery("");
                    setPlaceSuggestions([]);
                    setPlaceSearchError(null);
                  }}
                  disabled={interactionBusy}
                  className="text-[13px] font-semibold text-muted-foreground disabled:opacity-45"
                >
                  Keep current location
                </button>
              </div>
            ) : null}

            <SavedLocationCategoryPicker
              value={category}
              disabled={interactionBusy}
              onChange={setCategory}
            />

            {category === "other" ? (
              <div className="[animation:saveLocFadeIn_.2s_ease-out_both]">
                <label
                  htmlFor="saved-location-custom-label"
                  className={controlLabelClassName}
                >
                  Give it a name <span className="font-normal">(optional)</span>
                </label>
                <input
                  id="saved-location-custom-label"
                  type="text"
                  value={customLabel}
                  onChange={(event) => setCustomLabel(event.target.value)}
                  disabled={interactionBusy}
                  maxLength={40}
                  placeholder="e.g. Gym, Mom's house, Cafe"
                  className={controlInputClassName}
                />
              </div>
            ) : null}

            <div className="mt-1 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                aria-busy={saving || undefined}
                className={cn(
                  "press-scale flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[17px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                  "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]",
                )}
              >
                {saving ? (
                  <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                ) : (
                  <Check className="h-5 w-5" strokeWidth={2.6} aria-hidden />
                )}
                {saveLabel}
              </button>
              <button
                type="button"
                onClick={onSkip}
                disabled={interactionBusy}
                className="h-11 w-full rounded-full text-[15px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                Skip for now
              </button>
            </div>
          </>
        )}

      </DialogContent>
    </Dialog>
  );
}

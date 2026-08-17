"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Briefcase,
  Check,
  ChevronDown,
  Home,
  Loader2,
  Map as MapIcon,
  MapPin,
  Pencil,
  Search,
  X,
} from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, useSheetDragHandle } from "@/components/ui/sheet";
import {
  LocationPickerMap,
  type LocationPickerMapHandle,
  type PickedLocation,
} from "@/components/one-location/onboarding/location-picker-map";
import {
  ADDRESS_LABEL_ROW_CLASSNAME,
  DOOR_DETAILS_TOGGLE_CLASSNAME,
  REQUIRED_BADGE_CLASSNAME,
  SHEET_BODY_CLASSNAME,
  SHEET_DETAILS_SHELL_CLASSNAME,
  SHEET_FOOTER_CLASSNAME,
  SHEET_HEADER_CLASSNAME,
} from "@/components/one-location/onboarding/save-location-sheet-layout";
import { isNative } from "@/lib/capacitor/platform";
import { cn } from "@/lib/utils";
import {
  defaultSavedLocationCategory,
  type SavedLocation,
  type SavedLocationCategory,
} from "@/lib/one-location/saved-locations";
import {
  EMPTY_SAVED_LOCATION_ADDRESS_DETAILS,
  inferSavedLocationAddressDetails,
  isValidPostalCode,
  normalizeSavedLocationAddressDetails,
  stripPlusCodeSegment,
  type SavedLocationAddressDetails,
} from "@/lib/one-location/saved-location-address";

/**
 * Grows the tappable region to 44x44 while the visible control keeps its size,
 * because the `::after` box is painted rather than laid out.
 *
 * Deliberately does NOT include `relative`. Adding it to an element that is
 * already `absolute` puts two positioning utilities in one class string, and
 * tailwind-merge keeps the last — which drops the element out of absolute
 * positioning entirely. That collapsed the sheet's corner buttons from 36px
 * to 18px. Elements that are not already positioned add `relative` themselves.
 */
const touchTargetClassName =
  "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']";

const iconButtonClassName =
  `press-scale absolute flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill-strong)] text-[color:var(--app-secondary-label)] transition-colors hover:bg-[color:var(--app-neutral-fill-strong)]/80 disabled:opacity-45 ${touchTargetClassName}`;

/**
 * The same control, laid out instead of absolutely positioned. Written as its
 * own string rather than merged from the one above, because dropping
 * `absolute` through tailwind-merge needs a competing utility from the same
 * key and `relative` is the only one -- which is exactly the trap documented
 * on `touchTargetClassName`.
 */
const inlineIconButtonClassName =
  `press-scale relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill-strong)] text-[color:var(--app-secondary-label)] transition-colors hover:bg-[color:var(--app-neutral-fill-strong)]/80 disabled:opacity-45 ${touchTargetClassName}`;

const controlLabelClassName =
  "mb-1.5 block text-[13px] font-semibold leading-[18px] text-muted-foreground";

const controlInputClassName =
  "h-12 w-full rounded-[14px] border border-border/70 bg-[color:var(--app-card-surface-default-solid)] px-4 text-[15px] leading-5 text-foreground outline-none transition-colors placeholder:text-[color:var(--app-tertiary-label)] focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent)]/25 disabled:opacity-60";

/**
 * Blue is a promise that the tap moves you forward. When it cannot, the button
 * goes neutral instead of dimming the same blue -- a 45%-opacity primary still
 * reads as the live action and earns a dead tap.
 */
function primaryActionClassName(enabled: boolean): string {
  return cn(
    "press-scale flex h-[52px] w-full items-center justify-center gap-2 rounded-full text-[17px] font-semibold transition-colors disabled:cursor-not-allowed",
    enabled
      ? "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]"
      : "bg-[color:var(--app-neutral-fill-strong)] text-[color:var(--app-tertiary-label)]",
  );
}

/**
 * Where you are in the pin-then-details pair, and a way to move without
 * hunting for the button. Replaces the "Step 1 of 2" / "Step 2 of 2" labels,
 * which announced the flow as longer than it is.
 */
function CarouselDots({
  index,
  count,
  labels,
  onSelect,
  canAdvance,
  compact = false,
}: {
  index: number;
  count: number;
  labels: string[];
  onSelect: (next: number) => void;
  canAdvance: boolean;
  /**
   * Sits where an iOS sheet's grabber sits, doing both jobs at once. Half the
   * height, so the pinned header stays a header -- the touch target is given
   * back vertically by the painted `::after` box, and the 44px of horizontal
   * separation that keeps a tap off the wrong dot is untouched.
   */
  compact?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-center gap-1"
      role="tablist"
      aria-label="Save this place"
    >
      {Array.from({ length: count }, (_, dot) => {
        const active = dot === index;
        const reachable = dot <= index || canAdvance;
        return (
          <button
            key={dot}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={labels[dot]}
            disabled={!reachable}
            onClick={() => onSelect(dot)}
            // A real 44x44 each, laid out rather than faked, because two dots
            // sit side by side and overlapping hit regions would send a tap
            // near the boundary to the wrong slide.
            className={cn(
              "flex w-11 items-center justify-center disabled:cursor-not-allowed",
              compact
                ? `relative h-[18px] after:h-11 after:w-11 ${touchTargetClassName}`
                : "h-11",
            )}
          >
            <span
              className={cn(
                "block h-[5px] rounded-full transition-all duration-200",
                active
                  ? "w-[24px] bg-[color:var(--app-accent)]"
                  : "w-[7px] bg-[color:var(--app-neutral-fill-strong)]",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

/** The plain iOS grabber, for a sheet with only one slide to be on. */
function SheetGrabber() {
  return (
    <div className="flex h-[18px] items-center justify-center" aria-hidden>
      <span className="block h-[5px] w-9 rounded-full bg-[color:var(--app-neutral-fill-strong)]" />
    </div>
  );
}

/**
 * Makes the row it wraps the sheet's drag surface, so pulling down on the
 * grabber -- or on the slide indicator standing in for it -- dismisses the
 * sheet the way every other bottom sheet in the app does.
 *
 * Inert outside a bottom sheet: on a desktop-width screen this component sits
 * inside a centred dialog, `useSheetDragHandle` returns null, and the wrapper
 * is a plain div with no handlers and no `touch-none`.
 */
function SheetDragRegion({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const drag = useSheetDragHandle();
  return (
    <div
      data-testid="save-location-sheet-grabber"
      className={cn(drag && "touch-none select-none", className)}
      onPointerDown={(event) => {
        // A press that lands on a dot is a slide change. Letting it start a
        // drag as well would both move the sheet and switch the pane from one
        // gesture, and the pointer capture the drag takes would land the
        // resulting click somewhere the person never pressed.
        if ((event.target as HTMLElement).closest?.("button")) return;
        drag?.onPointerDown(event);
      }}
      onPointerMove={drag?.onPointerMove}
      onPointerUp={drag?.onPointerUp}
      onPointerCancel={drag?.onPointerCancel}
    >
      {children}
    </div>
  );
}

/**
 * The width at which this surface stops being a bottom sheet and becomes a
 * centred dialog. The same 640px boundary its own `sm:` classes switch on --
 * one number, so the presentation and the styling can never disagree.
 */
const SHEET_PRESENTATION_QUERY = "(max-width: 639.98px)";

function sheetPresentationSupported(): boolean {
  return (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
  );
}

function subscribeToSheetPresentation(onChange: () => void): () => void {
  if (!sheetPresentationSupported()) return () => {};
  const query = window.matchMedia(SHEET_PRESENTATION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Read on the first render rather than in an effect. An effect would paint one
 * frame of the centred dialog before swapping to the sheet, which on a phone
 * is a visible flash on every single open.
 */
function useSheetPresentation(): boolean {
  return useSyncExternalStore(
    subscribeToSheetPresentation,
    () =>
      sheetPresentationSupported() &&
      window.matchMedia(SHEET_PRESENTATION_QUERY).matches,
    () => false,
  );
}

/** Distance a horizontal drag must cover before it counts as a slide. */
const CAROUSEL_SWIPE_THRESHOLD_PX = 56;

/**
 * Only the sheet's CONTENT travels. The sheet itself is centred with a
 * translate, so animating it would fight its own positioning.
 */
const CAROUSEL_KEYFRAMES = `
@keyframes saveLocSlideFromRight {
  from { opacity: 0; transform: translate3d(14px, 0, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}
@keyframes saveLocSlideFromLeft {
  from { opacity: 0; transform: translate3d(-14px, 0, 0); }
  to { opacity: 1; transform: translate3d(0, 0, 0); }
}
@media (prefers-reduced-motion: reduce) {
  [data-save-location-pane] { animation: none !important; }
}
`;

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
  /**
   * Places already saved. Only their categories are read, to pre-select a label
   * that is still free -- Home and Work are singletons, so pre-selecting an
   * occupied one would overwrite that place on save.
   */
  existingLocations?: readonly Pick<SavedLocation, "category">[];
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
      <p className={controlLabelClassName}>Kind of place</p>
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
  existingLocations = [],
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
  /** Which edge the incoming slide travels from, so back reads as back. */
  const [slideFrom, setSlideFrom] = useState<"right" | "left" | null>(null);
  /** Mirrors the picker's own "this pin is ready to commit". */
  const [mapReady, setMapReady] = useState(false);
  const rendererReady = rendererDisclosureReady || rendererDisclosureAccepted;
  const descriptionId = useId();
  const postalCodeErrorId = useId();
  const addressHelpId = useId();
  const addressLineErrorId = useId();
  const doorDetailsId = useId();
  const mapTitleRef = useRef<HTMLHeadingElement | null>(null);
  const detailsTitleRef = useRef<HTMLHeadingElement | null>(null);
  // The pin, its settle state and its resolved address all live inside the
  // picker, so a swipe or a dot tap has to ask it whether it may commit.
  const mapPickerRef = useRef<LocationPickerMapHandle | null>(null);
  const swipeOriginRef = useRef<{ x: number; y: number } | null>(null);
  // A field the person has typed in is theirs. The pin may fill a blank field
  // and refill it as it moves, but it must never overwrite an answer someone
  // gave -- a prefill that fights the typing is worse than no prefill.
  const postalCodeEditedRef = useRef(false);
  const houseOrFlatEditedRef = useRef(false);
  // The address line itself, editable and separate from the entrance-detail
  // fields below it -- it IS the detected address, not something inferred
  // from it, so it is not governed by the "fill the fields below" checkbox.
  const addressLineEditedRef = useRef(false);
  const [addressLineValue, setAddressLineValue] = useState("");
  /**
   * An empty required field is not an error until the person has had a turn at
   * it. Flipped by leaving the box, or by pressing Save -- so the sheet never
   * opens already shouting, and never lets a press land on nothing.
   */
  const [addressTouched, setAddressTouched] = useState(false);
  /** Progressive disclosure for the details that are polish, not address. */
  const [doorDetailsOpen, setDoorDetailsOpen] = useState(false);
  const sheetPresentation = useSheetPresentation();

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
      addressLineEditedRef.current = false;
      setAddressLineValue("");
      setAddressTouched(false);
      // Open the polish step only when it already holds an answer, so editing
      // a saved place never hides something the person typed last time.
      setDoorDetailsOpen(
        Boolean(
          initialDetails &&
            (initialDetails.landmark || initialDetails.buildingColor),
        ),
      );
      // Editing keeps the place's own label; a new place opens on the first
      // label still free, so the primary button is live on arrival instead of
      // waiting behind "Pick Home, Work or Other first."
      setCategory(
        initialCategory ?? defaultSavedLocationCategory(existingLocations),
      );
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
      setSlideFrom(null);
      setMapReady(false);
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

  // A leading plus code is a coordinate wearing an address's clothes. Dropped
  // once, here, so every place this line is shown or saved says the same thing.
  const resolvedAddress = stripPlusCodeSegment(address);
  const changingPlace = selectingPlaceId !== null;
  const interactionBusy = saving || changingPlace;
  const canEditPlace = Boolean(onSearchPlaces && onSelectPlace);
  const canPickOnMap = Boolean(
    onPickExactLocation &&
    mapInitial &&
    Number.isFinite(mapInitial.latitude) &&
    Number.isFinite(mapInitial.longitude),
  );
  /**
   * The native map is on screen, which means anything painted over the sheet is
   * painted over the map itself. Only true on device: on web the map is an
   * ordinary element inside the sheet and the scrim belongs there.
   */
  const nativeMapShowing = isNative() && flowStep === "map" && canPickOnMap;
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
  const detectedAddress =
    stripPlusCodeSegment(pickedAddress) || resolvedAddress || "";
  /**
   * The Address line box tracks the detected address until the person types
   * over it -- the same "typed wins" rule as House/flat and PIN, just for the
   * line those fields are extracted from rather than for one piece of it.
   */
  const effectiveAddressLine = addressLineEditedRef.current
    ? addressLineValue
    : detectedAddress;
  /**
   * The one field a saved place cannot do without. It is required, and it is
   * marked required on screen -- an address box that quietly accepted nothing
   * was read as optional, and the save then failed for a reason nobody could
   * see.
   *
   * Requiring it is safe precisely because the box is editable. A pinned point
   * does not always come back with an address: on the native build before the
   * vault exists there is no server reverse-geocode and no browser geocoder
   * either, so the lookup returns nothing however good the pin is. That person
   * is not stuck -- they type the line themselves, in the box that is already
   * in front of them, and the save unblocks.
   */
  const addressLineMissing =
    collectAddressDetails && effectiveAddressLine.trim().length === 0;
  /**
   * Shown beside the box. Immediately when the lookup settled on nothing --
   * that is precisely the moment the person needs telling, and the box has
   * been sitting empty in front of them since it opened. Only on leaving the
   * box when THEY emptied it, so clearing the line to retype does not flash an
   * error at every keystroke.
   */
  const addressLineError =
    addressLineMissing &&
    !loadingAddress &&
    (addressTouched || !addressLineEditedRef.current);
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
        : addressLineMissing
          ? // Not the field's own wording. The empty Address box already says
            // "Enter the address." right next to itself, and the same sentence
            // twice on one screen reads as a stutter rather than as two places
            // worth looking.
            "Add the address above."
          : postalCodeInvalid
            ? // Not the field's own wording. The invalid PIN already says
              // "Enter a valid PIN or postcode." right next to itself, and
              // the same sentence twice on one screen reads as a stutter
              // rather than as two places worth looking.
              "Check the PIN or postcode above."
            : null;
  const canSave =
    category !== null &&
    !saving &&
    !loadingAddress &&
    !editingPlace &&
    flowStep !== "map" &&
    !changingPlace &&
    saveBlockedReason === null;

  /**
   * The pin and the address details are two slides of one thing, not two
   * steps of a longer setup. Only true when both slides genuinely exist for
   * this caller; a modal with a single pane keeps its plain layout.
   */
  const carouselMode = collectAddressDetails && canPickOnMap;
  const paneProps = {
    "data-save-location-pane": "",
    // Restores the gap the fragment used to inherit from the sheet, so the
    // wrapper is a pure animation host and changes no spacing.
    className: cn(
      "flex min-h-0 flex-col gap-5",
      slideFrom === "right" &&
        "[animation:saveLocSlideFromRight_260ms_cubic-bezier(0.2,0,0,1)_both]",
      slideFrom === "left" &&
        "[animation:saveLocSlideFromLeft_260ms_cubic-bezier(0.2,0,0,1)_both]",
    ),
  };
  const carouselIndex = flowStep === "details" ? 1 : 0;
  const carouselLabels = ["Pin your entrance", "Address details"];
  /**
   * The details pane owns its own scrolling, so the sheet around it stops
   * being a scroll box and becomes a frame: pinned header, one scroller,
   * pinned footer. Scoped to this pane so the map and summary panes keep the
   * plain scrolling sheet they were built against.
   */
  const detailsPaneActive = flowStep === "details" && collectAddressDetails;

  const goToSlide = (next: number) => {
    if (interactionBusy || next === carouselIndex) return;
    if (next === 1) {
      // Moving forward commits the pin, exactly as the Confirm button does.
      // The picker decides whether that is safe right now.
      mapPickerRef.current?.confirm();
      return;
    }
    setSlideFrom("left");
    setMapReady(false);
    setFlowStep("map");
  };

  /**
   * Horizontal drags on the sheet move between the two slides. Gestures that
   * begin on the map surface belong to the map -- panning to place a pin is a
   * horizontal drag too, and stealing it would make the pin impossible to
   * move. Vertical-dominant drags are left to the scroll container.
   */
  const handleSwipeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (!carouselMode || event.pointerType === "mouse") {
      swipeOriginRef.current = null;
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("[data-location-picker-surface]")) {
      swipeOriginRef.current = null;
      return;
    }
    swipeOriginRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleSwipeEnd = (event: PointerEvent<HTMLDivElement>) => {
    const origin = swipeOriginRef.current;
    swipeOriginRef.current = null;
    if (!origin) return;
    const deltaX = event.clientX - origin.x;
    const deltaY = event.clientY - origin.y;
    if (Math.abs(deltaX) < CAROUSEL_SWIPE_THRESHOLD_PX) return;
    if (Math.abs(deltaX) <= Math.abs(deltaY)) return;
    goToSlide(deltaX < 0 ? carouselIndex + 1 : carouselIndex - 1);
  };

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
    setSlideFrom("right");
    setMapReady(false);
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
        effectiveAddressLine.trim() || null,
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

  const handleSurfaceOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && !interactionBusy) onSkip();
  };

  // Location onboarding is a full-screen takeover at z-560 with an OPAQUE
  // background. The scrim used to sit at z-559 -- underneath it -- so the dim
  // and the blur were painted where nothing could see them, and the sheet
  // landed on a fully lit screen with no separation at all. That is the "it
  // looks like a patch": not a missing blur, a buried one. Above the takeover,
  // below the app's sheets/drawers at z-711 -- held at these values in BOTH
  // presentations, so moving to the shared sheet primitive does not quietly
  // move this surface to a different layer.
  const surfaceOverlayClassName = cn(
    "z-[600]",
    nativeMapShowing
      ? // The native map is not part of the page: @capacitor/google-maps draws
        // it BELOW the WebView and the WebView is punched through to reveal
        // it. This overlay is a Radix sibling of the sheet, so the rule that
        // clears backgrounds inside [data-testid="save-location-modal"] never
        // reached it -- and a 55% black scrim with a 10px blur sat over the
        // whole screen, hiding the map while the HTML pin and cards stayed
        // crisp on top. That is exactly the "no map behind it, just one pin"
        // report: the map was rendering the whole time, behind the scrim.
        "bg-transparent backdrop-blur-none [-webkit-backdrop-filter:none]"
      : "bg-black/55 backdrop-blur-[10px] [-webkit-backdrop-filter:blur(10px)]",
  );

  // A real edge and a real lift, so the surface reads as a layer above the
  // screen rather than a rectangle pasted onto it.
  const surfaceEdgeClassName =
    "border border-black/[0.06] bg-[color:var(--app-card-surface-default-solid)] dark:border-white/[0.08]";
  const surfacePaddingClassName = detailsPaneActive
    ? SHEET_DETAILS_SHELL_CLASSNAME
    : "gap-5 overflow-y-auto p-5 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] sm:p-6 sm:pb-6";
  // `!` because the arbitrary shadow does not merge away the primitive's own
  // `shadow-[var(--app-card-shadow-feature)]`: tailwind-merge leaves both
  // classes on the element and the base one wins on stylesheet order, so the
  // lift never actually rendered.
  const surfaceShadowClassName =
    "!shadow-[0_24px_60px_-12px_rgba(16,24,40,0.35),0_8px_20px_-8px_rgba(16,24,40,0.24)] dark:!shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]";

  const surfaceChildren = (
    <>
      <style>{CAROUSEL_KEYFRAMES}</style>
        {flowStep === "map" && canPickOnMap ? (
          <div {...paneProps}>
            <DialogTitle ref={mapTitleRef} tabIndex={-1} className="sr-only">
              {rendererReady ? "Pin your entrance" : "Before Google Maps opens"}
            </DialogTitle>
            <p id={descriptionId} className="sr-only">
              {rendererReady
                ? "Move the pin to the entrance."
                : "Review before opening Maps."}
            </p>
            <LocationPickerMap
              ref={mapPickerRef}
              initialLatitude={mapInitial!.latitude}
              initialLongitude={mapInitial!.longitude}
              initialAddress={pickedAddress || resolvedAddress}
              initialAccuracyM={initialAccuracyM}
              reverseGeocode={reverseGeocode}
              onLocateMe={onLocateMe}
              onConfirm={handleConfirmMapPick}
              onReadyChange={setMapReady}
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
            {carouselMode ? (
              <CarouselDots
                index={0}
                count={2}
                labels={carouselLabels}
                canAdvance={mapReady}
                onSelect={goToSlide}
              />
            ) : null}
          </div>
        ) : flowStep === "details" && collectAddressDetails ? (
          <div
            {...paneProps}
            className={cn(paneProps.className, "flex-1 gap-0")}
          >
            {/* Pinned. The controls are laid out beside the title rather than
                floated over it, which is what let a 36px button starting at
                16px cover a header padded to 36px. */}
            <header className={SHEET_HEADER_CLASSNAME}>
              {/* On a phone this row IS the sheet's grabber, so a pull down on
                  it dismisses the sheet -- the dots sit exactly where an iOS
                  grabber sits and were already doing that job visually. */}
              <SheetDragRegion>
                {carouselMode ? (
                  <CarouselDots
                    compact
                    index={1}
                    count={2}
                    labels={carouselLabels}
                    canAdvance
                    onSelect={goToSlide}
                  />
                ) : (
                  <SheetGrabber />
                )}
              </SheetDragRegion>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    canPickOnMap ? goToSlide(0) : setFlowStep("summary")
                  }
                  disabled={interactionBusy}
                  aria-label={canPickOnMap ? "Back to map" : "Back"}
                  className={inlineIconButtonClassName}
                >
                  <ArrowLeft className="h-4.5 w-4.5" strokeWidth={2.4} />
                </button>
                <DialogTitle
                  ref={detailsTitleRef}
                  tabIndex={-1}
                  className="min-w-0 flex-1 truncate text-center text-[17px] font-semibold leading-[22px] tracking-normal text-foreground outline-none"
                >
                  Address details
                </DialogTitle>
                <button
                  type="button"
                  onClick={onSkip}
                  disabled={interactionBusy}
                  aria-label="Close"
                  className={inlineIconButtonClassName}
                >
                  <X className="h-4.5 w-4.5" strokeWidth={2.4} />
                </button>
              </div>
              {/* The sentence that used to sit under the title. The card below
                  shows the address and the group label below that says the
                  fields are optional, so on screen it only repeated them. */}
              <p id={descriptionId} className="sr-only">
                Optional details that help someone reach your door.
              </p>
            </header>

            <div className={SHEET_BODY_CLASSNAME}>
              {/* The detected address, shown as the thing the fields below were
                  filled from. */}
              <div className="flex items-start gap-2.5 rounded-[14px] bg-[color:var(--app-card-surface-compact)] px-3.5 py-3">
                <span className="mt-0.5 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/12 text-[color:var(--app-accent)]">
                  <MapPin className="h-[17px] w-[17px]" strokeWidth={1.9} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground">
                    Pinned
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-[15px] font-semibold leading-5 text-foreground">
                    {loadingAddress
                      ? "Finding address…"
                      : detectedAddress || "No address found"}
                  </p>
                </div>
                {canPickOnMap ? (
                  <button
                    type="button"
                    onClick={() => goToSlide(0)}
                    disabled={interactionBusy}
                    // One visible word; the pin is what the icon and the line
                    // above it already say. The accessible name keeps the phrase.
                    aria-label="Edit pin"
                    className={cn(
                      "press-scale shrink-0 rounded-full bg-[color:var(--app-accent)]/12 px-2.5 py-1.5 text-[13px] font-semibold text-[color:var(--app-accent)] disabled:opacity-45",
                      "relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']",
                    )}
                  >
                    Edit
                  </button>
                ) : null}
              </div>

              {/* The address itself is editable, because a pin that resolves
                  to the wrong line left no way to correct it. It is also the
                  one field a saved place cannot do without, so it is first and
                  it is marked required -- an unmarked box that quietly
                  accepted nothing read as optional right up until the save
                  would not go. */}
              <div>
                {/* The badge is a sibling of the label, not inside it. Inside,
                    it becomes part of the field's accessible name -- the box
                    would announce as "Address Required" and stop matching a
                    query for its own label. The requirement reaches assistive
                    technology through `aria-required` instead, which is what
                    that attribute is for. */}
                <div className={ADDRESS_LABEL_ROW_CLASSNAME}>
                  <label
                    htmlFor="saved-location-address-line"
                    className={cn(controlLabelClassName, "mb-0")}
                  >
                    Address
                  </label>
                  {/* The word, not only a red asterisk: an asterisk is a
                      convention people have to already know, and colour on its
                      own carries nothing to anyone who cannot see it. */}
                  <span aria-hidden className={REQUIRED_BADGE_CLASSNAME}>
                    Required
                  </span>
                </div>
                <p
                  id={addressHelpId}
                  className="mb-1.5 text-[13px] leading-[18px] text-muted-foreground"
                >
                  Used to find your door.
                </p>
                <input
                  id="saved-location-address-line"
                  type="text"
                  required
                  aria-required="true"
                  aria-invalid={addressLineError}
                  aria-describedby={
                    addressLineError
                      ? `${addressHelpId} ${addressLineErrorId}`
                      : addressHelpId
                  }
                  value={effectiveAddressLine}
                  onChange={(event) => {
                    addressLineEditedRef.current = true;
                    setAddressLineValue(event.target.value);
                  }}
                  onBlur={() => setAddressTouched(true)}
                  disabled={interactionBusy}
                  maxLength={300}
                  autoComplete={deferredUntilVault ? "off" : "street-address"}
                  placeholder={
                    loadingAddress ? "Finding address…" : "12 MG Road, Bengaluru"
                  }
                  className={cn(
                    controlInputClassName,
                    "aria-[invalid=true]:border-[color:var(--app-destructive)]",
                  )}
                />
                {addressLineError ? (
                  <p
                    id={addressLineErrorId}
                    role="alert"
                    className="mt-1.5 text-[13px] leading-[18px] text-[color:var(--app-destructive)]"
                  >
                    Enter the address.
                  </p>
                ) : null}
              </div>

              {/* Second, because naming the place is the other thing the save
                  genuinely needs. It used to sit under four optional boxes, so
                  the two required answers were separated by everything that
                  was not one. */}
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
                    Name it
                  </label>
                  <input
                    id="saved-location-details-custom-label"
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

              {/* Ticked, the fields below are filled from that address and keep
                  following the pin. Unticked, they are cleared and left alone.
                  Anything typed by hand survives either way. */}
              <label className="flex min-h-11 cursor-pointer items-center gap-2 px-1 text-[13px] leading-[18px] text-muted-foreground">
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
                Fill from this address
              </label>

              <div className="space-y-3.5">
                {/* Said once, for the group, instead of an "(optional)" tag
                    hanging off every label. */}
                <p className="px-1 text-[13px] leading-[18px] text-muted-foreground">
                  Optional — helps at the door.
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="saved-location-house-or-flat"
                      className={controlLabelClassName}
                    >
                      House or flat
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
                      placeholder="Flat 4B, Tower 2"
                      className={controlInputClassName}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="saved-location-postal-code"
                      className={controlLabelClassName}
                    >
                      PIN / postcode
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
                      placeholder="560001"
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
                        Enter a valid PIN or postcode.
                      </p>
                    ) : null}
                  </div>
                </div>

                {/* Behind a tap, not in front of one. Being asked the colour of
                    your building before you have finished saying where it is
                    reads as an odd question; asked later, of someone who chose
                    to open this, it reads as care. Kept mounted so anything
                    already typed survives collapsing, and opened on arrival
                    when it holds an answer. */}
                <div>
                  <button
                    type="button"
                    onClick={() => setDoorDetailsOpen((shown) => !shown)}
                    disabled={interactionBusy}
                    aria-expanded={doorDetailsOpen}
                    aria-controls={doorDetailsId}
                    data-testid="save-location-door-details-toggle"
                    className={DOOR_DETAILS_TOGGLE_CLASSNAME}
                  >
                    <span className="text-[15px] font-semibold leading-5 text-foreground">
                      More door details
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-[color:var(--app-tertiary-label)] transition-transform duration-200",
                        doorDetailsOpen && "rotate-180",
                      )}
                      strokeWidth={2.2}
                      aria-hidden
                    />
                  </button>
                  <div
                    id={doorDetailsId}
                    hidden={!doorDetailsOpen}
                    className="mt-3.5 space-y-3.5"
                  >
                    <div>
                      <label
                        htmlFor="saved-location-landmark"
                        className={controlLabelClassName}
                      >
                        Landmark
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
                        autoComplete={
                          deferredUntilVault ? "off" : "address-line2"
                        }
                        placeholder="Opposite City Mall"
                        className={controlInputClassName}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="saved-location-building-color"
                        className={controlLabelClassName}
                      >
                        Building colour
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
                        placeholder="Blue gate"
                        className={controlInputClassName}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* A caption, not a card. It reassures; it is not a control, and
                  the panel it used to sit in gave it a control's weight. */}
              <p className="px-1 text-[13px] leading-[18px] text-muted-foreground">
                {deferredUntilVault
                  ? "Saves once your lock is set."
                  : "Private to you."}
              </p>
            </div>

            <div className={SHEET_FOOTER_CLASSNAME}>
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
                className={primaryActionClassName(canSave)}
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
          </div>
        ) : (

          <div {...paneProps}>
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
                Tag where you are. It stays private to you.
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
                  className={cn(
                    "press-scale inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-[color:var(--app-accent)]/12 px-2.5 text-[13px] font-semibold text-[color:var(--app-accent)] disabled:opacity-45",
                    "relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']",
                  )}
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
                    Pin your entrance
                  </span>
                  <span className="block text-[13px] leading-[18px] text-muted-foreground">
                    GPS lands near, not at, your door.
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
                  Name it
                </label>
                <input
                  id="saved-location-custom-label"
                  type="text"
                  value={customLabel}
                  onChange={(event) => setCustomLabel(event.target.value)}
                  disabled={interactionBusy}
                  maxLength={40}
                  placeholder="Gym, Mom's house"
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
                className={primaryActionClassName(canSave)}
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
          </div>
        )}
    </>
  );

  /**
   * On a phone this is the app's own bottom sheet -- the same component, drag
   * handle and drag-to-dismiss the Market surfaces use -- rather than a
   * dialog wearing a sheet's corners. Above 640px it stays the centred dialog
   * it already was.
   *
   * `contentDragDismiss` is off because the details pane is a fixed frame with
   * its own inner scroller: the outer surface never scrolls, so a body drag
   * would engage on every downward swipe and cancel the scroll it was meant to
   * be. The header row is the drag surface instead -- see `SheetDragRegion`.
   */
  if (sheetPresentation) {
    return (
      <Sheet open={open} modal onOpenChange={handleSurfaceOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          showDragHandle={false}
          contentDragDismiss={false}
          data-testid="save-location-modal"
          aria-describedby={descriptionId}
          onPointerDown={handleSwipeStart}
          onPointerUp={handleSwipeEnd}
          onPointerCancel={() => {
            swipeOriginRef.current = null;
          }}
          overlayClassName={surfaceOverlayClassName}
          onEscapeKeyDown={(event) => {
            if (interactionBusy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (interactionBusy || flowStep === "map") event.preventDefault();
          }}
          className={cn(
            "z-[601] mx-auto max-h-[min(92dvh,760px)] w-full max-w-[420px] rounded-t-[24px]",
            surfaceEdgeClassName,
            surfacePaddingClassName,
            surfaceShadowClassName,
          )}
        >
          {surfaceChildren}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} modal onOpenChange={handleSurfaceOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid="save-location-modal"
        aria-describedby={descriptionId}
        onPointerDown={handleSwipeStart}
        onPointerUp={handleSwipeEnd}
        onPointerCancel={() => {
          swipeOriginRef.current = null;
        }}
        overlayClassName={surfaceOverlayClassName}
        onEscapeKeyDown={(event) => {
          if (interactionBusy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (interactionBusy || flowStep === "map") event.preventDefault();
        }}
        className={cn(
          "z-[601] bottom-[var(--kb-height,0px)] top-auto max-h-[min(92dvh,760px)] w-full max-w-[420px] translate-y-0",
          "rounded-b-none rounded-t-[24px] sm:bottom-auto sm:top-[50%] sm:translate-y-[-50%] sm:rounded-[20px]",
          surfaceEdgeClassName,
          surfacePaddingClassName,
          surfaceShadowClassName,
        )}
      >
        {surfaceChildren}
      </DialogContent>
    </Dialog>
  );
}

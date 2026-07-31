"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  Clock3,
  Loader2,
  MapPin,
  Search,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { relationshipCta } from "@/lib/connections/relationship-label";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { OneLocationService } from "@/lib/one-location/service";
import type {
  OneLocationNearbyAttendee,
  OneLocationNearbyPlaceSuggestion,
  OneLocationNearbyPresenceState,
  PlainLocationPoint,
} from "@/lib/one-location/types";
import { isNative } from "@/lib/capacitor/platform";
import { ROUTES } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils";

const DURATIONS = [
  { value: 30 as const, label: "30 min" },
  { value: 60 as const, label: "1 hour" },
  { value: 120 as const, label: "2 hours" },
];

const MAX_NEARBY_LOCATION_ACCURACY_METERS = 100;
const EMPTY_NEARBY_STATE: OneLocationNearbyPresenceState = {
  presence: null,
  attendees: [],
};

type LocationRecovery = "app-settings" | "location-settings" | null;

function distanceLabel(distanceMeters?: number | null): string {
  if (
    typeof distanceMeters !== "number" ||
    !Number.isFinite(distanceMeters) ||
    distanceMeters < 0
  ) {
    return "Nearby";
  }
  if (distanceMeters < 1_000) return `${Math.max(1, Math.round(distanceMeters))} m`;
  return `${(distanceMeters / 1_000).toFixed(1)} km`;
}

function hasCheckInAccuracy(point: PlainLocationPoint): boolean {
  return (
    typeof point.accuracyM === "number" &&
    Number.isFinite(point.accuracyM) &&
    point.accuracyM >= 0 &&
    point.accuracyM <= MAX_NEARBY_LOCATION_ACCURACY_METERS
  );
}

function timeLeftLabel(expiresAt: string): string {
  const remainingMs = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "Ending now";
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m left` : `${hours}h left`;
}

function initials(label: string): string {
  return (
    label
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0] || "")
      .join("")
      .toUpperCase() || "?"
  );
}

function NearbyPersonRow({
  attendee,
  busy,
  interactionDisabled,
  onConnect,
  onRespond,
}: {
  attendee: OneLocationNearbyAttendee;
  busy: boolean;
  interactionDisabled: boolean;
  onConnect: () => void;
  onRespond: () => void;
}) {
  const cta = relationshipCta(attendee.relationship);
  const connectionUnavailable =
    cta.action === "connect" && !attendee.canConnect;
  const buttonLabel = connectionUnavailable
    ? "Not accepting requests"
    : cta.label;
  const accessibleLabel =
    connectionUnavailable
      ? `${attendee.displayName} is not accepting connection requests`
      : cta.action === "respond"
      ? `Respond to ${attendee.displayName}'s connection request`
      : `${cta.label} with ${attendee.displayName}`;
  return (
    <li className="flex min-h-14 items-center gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--app-accent-surface-strong)] text-xs font-semibold text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]"
        aria-hidden="true"
      >
        {initials(attendee.displayName)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">
          {attendee.displayName}
        </span>
        <span className="block text-xs text-muted-foreground">
          Checked in nearby
        </span>
      </span>
      <Button
        type="button"
        size="sm"
        className="shrink-0"
        variant={cta.action === "connect" ? "default" : "secondary"}
        aria-label={accessibleLabel}
        disabled={
          interactionDisabled ||
          cta.disabled ||
          connectionUnavailable
        }
        onClick={cta.action === "respond" ? onRespond : onConnect}
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="sr-only">{cta.label}</span>
          </>
        ) : (
          buttonLabel
        )}
      </Button>
    </li>
  );
}

export function NearbyCheckInSheet({
  open,
  ownerId,
  vaultOwnerToken,
  captureCurrentPosition,
  onOpenChange,
  onStateChange,
}: {
  open: boolean;
  ownerId: string | null;
  vaultOwnerToken: string | null;
  captureCurrentPosition: () => Promise<PlainLocationPoint>;
  onOpenChange: (open: boolean) => void;
  onStateChange?: (state: OneLocationNearbyPresenceState) => void;
}) {
  const router = useRouter();
  const ownerEpochRef = useRef(0);
  const requestGenerationRef = useRef(0);
  const presenceReadGenerationRef = useRef(0);
  const presenceMutationGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  const searchGenerationRef = useRef(0);
  const [point, setPoint] = useState<PlainLocationPoint | null>(null);
  const [automaticPlaces, setAutomaticPlaces] = useState<
    OneLocationNearbyPlaceSuggestion[]
  >([]);
  const [places, setPlaces] = useState<OneLocationNearbyPlaceSuggestion[]>([]);
  const [selectedPlaceId, setSelectedPlaceId] = useState("");
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [loadingPresence, setLoadingPresence] = useState(false);
  const [state, setState] =
    useState<OneLocationNearbyPresenceState>(EMPTY_NEARBY_STATE);
  const [durationMinutes, setDurationMinutes] = useState<30 | 60 | 120>(60);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [allowConnectionRequests, setAllowConnectionRequests] = useState(false);
  const [busy, setBusy] = useState<"check-in" | "checkout" | string | null>(
    null,
  );
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationRecovery, setLocationRecovery] =
    useState<LocationRecovery>(null);
  const [presenceLoadError, setPresenceLoadError] = useState<string | null>(
    null,
  );
  const [placesError, setPlacesError] = useState<string | null>(null);

  const publishState = useCallback(
    (next: OneLocationNearbyPresenceState) => {
      setState(next);
      onStateChange?.(next);
    },
    [onStateChange],
  );

  const loadPresence = useCallback(
    async (
      background = false,
      expectedOwnerEpoch = ownerEpochRef.current,
    ): Promise<OneLocationNearbyPresenceState | null> => {
      if (!ownerId || !vaultOwnerToken || mutationInFlightRef.current) {
        return null;
      }
      const ownerToken = vaultOwnerToken;
      const generation = ++presenceReadGenerationRef.current;
      if (!background) {
        setLoadingPresence(true);
        setPresenceLoadError(null);
      }
      try {
        const next = await OneLocationService.getNearbyPresence({
          vaultOwnerToken: ownerToken,
        });
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          presenceReadGenerationRef.current !== generation
        ) {
          return null;
        }
        publishState(next);
        return next;
      } catch {
        if (
          !background &&
          ownerEpochRef.current === expectedOwnerEpoch &&
          presenceReadGenerationRef.current === generation
        ) {
          const message =
            "Nearby check-in could not be loaded. Check your connection and retry.";
          setPresenceLoadError(message);
          toast.error(message);
        }
        return null;
      } finally {
        if (
          !background &&
          ownerEpochRef.current === expectedOwnerEpoch &&
          presenceReadGenerationRef.current === generation
        ) {
          setLoadingPresence(false);
        }
      }
    },
    [ownerId, publishState, vaultOwnerToken],
  );

  const loadPlaces = useCallback(
    async (
      nextPoint: PlainLocationPoint,
      generation: number,
      expectedOwnerEpoch: number,
    ) => {
      if (!ownerId || !vaultOwnerToken) return;
      const ownerToken = vaultOwnerToken;
      setPlacesError(null);
      try {
        const suggestions = await OneLocationService.nearbyPlaces({
          vaultOwnerToken: ownerToken,
          lat: nextPoint.latitude,
          lng: nextPoint.longitude,
        });
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          requestGenerationRef.current !== generation
        ) {
          return;
        }
        setAutomaticPlaces(suggestions);
        setPlaces(suggestions);
        setSelectedPlaceId((current) =>
          suggestions.some((place) => place.placeId === current)
            ? current
            : (suggestions[0]?.placeId ?? ""),
        );
        if (suggestions.length === 0) {
          setPlacesError("No nearby places found. Search for the place instead.");
        }
      } catch (error) {
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          requestGenerationRef.current !== generation
        ) {
          return;
        }
        setAutomaticPlaces([]);
        setPlaces([]);
        setSelectedPlaceId("");
        setPlacesError(OneLocationService.placesSearchErrorMessage(error));
      }
    },
    [ownerId, vaultOwnerToken],
  );

  const captureAndLoadPlaces = useCallback(async () => {
    if (!ownerId || !vaultOwnerToken) return;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const generation = ++requestGenerationRef.current;
    setCapturing(true);
    setLocationError(null);
    setLocationRecovery(null);
    setPresenceLoadError(null);
    setPlacesError(null);
    try {
      let permission: Awaited<
        ReturnType<typeof OneLocationService.getPermissionState>
      > | null = null;
      try {
        permission = await OneLocationService.getPermissionState();
      } catch {
        // The actual one-shot capture remains authoritative if a platform
        // cannot report permission state separately.
      }
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        requestGenerationRef.current !== generation
      ) {
        return;
      }
      if (permission?.state === "granted" && permission.precise === false) {
        setPoint(null);
        setLocationRecovery(isNative() ? "app-settings" : null);
        setLocationError(
          "Precise location is off. Enable it before checking in nearby.",
        );
        return;
      }
      if (
        permission?.state === "denied" ||
        permission?.state === "restricted"
      ) {
        setPoint(null);
        setLocationRecovery(isNative() ? "app-settings" : null);
        setLocationError(
          isNative()
            ? "Location access is off. Allow it in app settings and try again."
            : "Location access is off. Allow it in your browser's site settings and try again.",
        );
        return;
      }
      if (
        permission?.state === "unavailable" &&
        permission.locationServicesEnabled === false
      ) {
        setPoint(null);
        setLocationRecovery(isNative() ? "location-settings" : null);
        setLocationError(
          isNative()
            ? "Location services are off. Turn them on and try again."
            : "Location is unavailable in this browser.",
        );
        return;
      }

      const nextPoint = await captureCurrentPosition();
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        requestGenerationRef.current !== generation
      ) {
        return;
      }
      try {
        const settledPermission =
          await OneLocationService.getPermissionState();
        if (
          ownerEpochRef.current !== expectedOwnerEpoch ||
          requestGenerationRef.current !== generation
        ) {
          return;
        }
        if (
          settledPermission.state === "granted" &&
          settledPermission.precise === false
        ) {
          setPoint(null);
          setLocationRecovery(isNative() ? "app-settings" : null);
          setLocationError(
            "Precise location is off. Enable it before checking in nearby.",
          );
          return;
        }
      } catch {
        // Accuracy below remains the fail-closed quality gate when permission
        // precision cannot be queried separately.
      }
      if (!hasCheckInAccuracy(nextPoint)) {
        setPoint(null);
        setLocationRecovery(isNative() ? "app-settings" : null);
        setLocationError(
          "This location is too approximate. Move to an open area or turn on precise location, then try again.",
        );
        return;
      }
      setPoint(nextPoint);
      await loadPlaces(nextPoint, generation, expectedOwnerEpoch);
    } catch {
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        requestGenerationRef.current !== generation
      ) {
        return;
      }
      setPoint(null);
      setAutomaticPlaces([]);
      setPlaces([]);
      setSelectedPlaceId("");
      setLocationRecovery(isNative() ? "app-settings" : null);
      setLocationError(
        "We couldn't get a fresh location. Turn on location access and try again.",
      );
    } finally {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        requestGenerationRef.current === generation
      ) {
        setCapturing(false);
      }
    }
  }, [captureCurrentPosition, loadPlaces, ownerId, vaultOwnerToken]);

  useEffect(() => {
    ownerEpochRef.current += 1;
    requestGenerationRef.current += 1;
    presenceReadGenerationRef.current += 1;
    presenceMutationGenerationRef.current += 1;
    mutationInFlightRef.current = false;
    searchGenerationRef.current += 1;
    setPoint(null);
    setAutomaticPlaces([]);
    setPlaces([]);
    setSelectedPlaceId("");
    setSearch("");
    setSearching(false);
    setCapturing(false);
    setLoadingPresence(false);
    setConsentAccepted(false);
    setAllowConnectionRequests(false);
    setDurationMinutes(60);
    setBusy(null);
    setLocationError(null);
    setLocationRecovery(null);
    setPresenceLoadError(null);
    setPlacesError(null);
    publishState(EMPTY_NEARBY_STATE);
    return () => {
      requestGenerationRef.current += 1;
      presenceReadGenerationRef.current += 1;
      presenceMutationGenerationRef.current += 1;
      mutationInFlightRef.current = false;
      searchGenerationRef.current += 1;
    };
  }, [ownerId, publishState, vaultOwnerToken]);

  useEffect(() => {
    if (!ownerId || !vaultOwnerToken) return;
    const expectedOwnerEpoch = ownerEpochRef.current;
    if (open) {
      requestGenerationRef.current += 1;
      searchGenerationRef.current += 1;
      setPoint(null);
      setAutomaticPlaces([]);
      setPlaces([]);
      setSelectedPlaceId("");
      setSearch("");
      setSearching(false);
      setConsentAccepted(false);
      setAllowConnectionRequests(false);
      setDurationMinutes(60);
      setLocationError(null);
      setLocationRecovery(null);
      setPresenceLoadError(null);
      setPlacesError(null);
    }
    void loadPresence(!open, expectedOwnerEpoch).then((next) => {
      if (
        !open ||
        next === null ||
        next.presence ||
        ownerEpochRef.current !== expectedOwnerEpoch
      ) {
        return;
      }
      void captureAndLoadPlaces();
    });
    return () => {
      requestGenerationRef.current += 1;
      presenceReadGenerationRef.current += 1;
      searchGenerationRef.current += 1;
    };
  }, [
    captureAndLoadPlaces,
    loadPresence,
    open,
    ownerId,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!state.presence || !ownerId || !vaultOwnerToken) return;
    const expectedOwnerEpoch = ownerEpochRef.current;
    let inFlight = false;
    const poll = async () => {
      if (
        document.visibilityState !== "visible" ||
        inFlight ||
        mutationInFlightRef.current
      ) {
        return;
      }
      inFlight = true;
      try {
        const next = await loadPresence(true, expectedOwnerEpoch);
        if (
          open &&
          next !== null &&
          !next.presence &&
          ownerEpochRef.current === expectedOwnerEpoch
        ) {
          void captureAndLoadPlaces();
        }
      } finally {
        inFlight = false;
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    const removeLifecycleListener =
      appInteractionCoordinator.subscribeLifecycle(() => {
        if (
          appInteractionCoordinator.getLifecycleSnapshot().state === "active"
        ) {
          void poll();
          return;
        }
        presenceReadGenerationRef.current += 1;
        requestGenerationRef.current += 1;
        searchGenerationRef.current += 1;
      });
    const timer = window.setInterval(() => void poll(), 15_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      removeLifecycleListener();
    };
  }, [
    captureAndLoadPlaces,
    loadPresence,
    open,
    ownerId,
    state.presence,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (!open || state.presence || !locationRecovery) return;
    return appInteractionCoordinator.subscribeLifecycle(() => {
      if (
        appInteractionCoordinator.getLifecycleSnapshot().state === "active"
      ) {
        void captureAndLoadPlaces();
      }
    });
  }, [captureAndLoadPlaces, locationRecovery, open, state.presence]);

  useEffect(() => {
    const query = search.trim();
    if (!open || !ownerId || !vaultOwnerToken || !point) return;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const ownerToken = vaultOwnerToken;
    const generation = ++searchGenerationRef.current;
    if (query.length < 2) {
      setSearching(false);
      setPlaces(automaticPlaces);
      setSelectedPlaceId((current) =>
        automaticPlaces.some((place) => place.placeId === current)
          ? current
          : (automaticPlaces[0]?.placeId ?? ""),
      );
      return;
    }
    const timer = window.setTimeout(() => {
      setSearching(true);
      setPlacesError(null);
      void OneLocationService.placesAutocomplete({
        vaultOwnerToken: ownerToken,
        input: query,
        lat: point.latitude,
        lng: point.longitude,
      })
        .then((suggestions) => {
          if (
            ownerEpochRef.current !== expectedOwnerEpoch ||
            searchGenerationRef.current !== generation
          ) {
            return;
          }
          setPlaces(suggestions);
          setSelectedPlaceId((current) =>
            suggestions.some((place) => place.placeId === current)
              ? current
              : (suggestions[0]?.placeId ?? ""),
          );
          if (suggestions.length === 0) {
            setPlacesError("No matching places found.");
          }
        })
        .catch((error) => {
          if (
            ownerEpochRef.current !== expectedOwnerEpoch ||
            searchGenerationRef.current !== generation
          ) {
            return;
          }
          setPlaces([]);
          setSelectedPlaceId("");
          setPlacesError(OneLocationService.placesSearchErrorMessage(error));
        })
        .finally(() => {
          if (
            ownerEpochRef.current === expectedOwnerEpoch &&
            searchGenerationRef.current === generation
          ) {
            setSearching(false);
          }
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [automaticPlaces, open, ownerId, point, search, vaultOwnerToken]);

  const selectedPlace = useMemo(
    () => places.find((place) => place.placeId === selectedPlaceId) ?? null,
    [places, selectedPlaceId],
  );

  const retryPresenceLoad = async () => {
    if (!open || !ownerId || !vaultOwnerToken) return;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const next = await loadPresence(false, expectedOwnerEpoch);
    if (
      next === null ||
      next.presence ||
      ownerEpochRef.current !== expectedOwnerEpoch
    ) {
      return;
    }
    void captureAndLoadPlaces();
  };

  const checkIn = async () => {
    if (
      !ownerId ||
      !vaultOwnerToken ||
      !point ||
      !selectedPlace ||
      !consentAccepted
    ) {
      return;
    }
    if (mutationInFlightRef.current) return;
    const ownerToken = vaultOwnerToken;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const generation = ++presenceMutationGenerationRef.current;
    presenceReadGenerationRef.current += 1;
    mutationInFlightRef.current = true;
    setBusy("check-in");
    try {
      const capturedAge = Date.now() - Date.parse(point.capturedAt);
      const freshPoint =
        Number.isFinite(capturedAge) && capturedAge <= 60_000
          ? point
          : await captureCurrentPosition();
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      if (!hasCheckInAccuracy(freshPoint)) {
        setPoint(null);
        setLocationRecovery(isNative() ? "app-settings" : null);
        setLocationError(
          "This location is too approximate. Move to an open area or turn on precise location, then try again.",
        );
        toast.error("A more precise location is needed before check-in.");
        return;
      }
      setPoint(freshPoint);
      const next = await OneLocationService.checkInNearby({
        vaultOwnerToken: ownerToken,
        placeId: selectedPlace.placeId,
        point: freshPoint,
        durationMinutes,
        consentAccepted: true,
        allowConnectionRequests,
      });
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      publishState(next);
      setPoint(null);
      setAutomaticPlaces([]);
      setPlaces([]);
      setSelectedPlaceId("");
      setSearch("");
      toast.success("You're checked in nearby.");
    } catch (error) {
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      const details = OneLocationService.nearbyCheckInErrorDetails(error);
      if (details.retryLocation) {
        setPoint(null);
        setLocationError(details.message);
        setLocationRecovery(
          details.openAppSettings && isNative() ? "app-settings" : null,
        );
      } else if (
        details.message.toLowerCase().includes("closer place")
      ) {
        setPlacesError(details.message);
      }
      toast.error(details.message);
    } finally {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        mutationInFlightRef.current = false;
        setBusy(null);
      }
    }
  };

  const checkout = async () => {
    if (!ownerId || !vaultOwnerToken || mutationInFlightRef.current) return;
    const ownerToken = vaultOwnerToken;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const generation = ++presenceMutationGenerationRef.current;
    presenceReadGenerationRef.current += 1;
    mutationInFlightRef.current = true;
    setBusy("checkout");
    try {
      const next = await OneLocationService.checkoutNearby({
        vaultOwnerToken: ownerToken,
      });
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      publishState(next);
      setConsentAccepted(false);
      setAllowConnectionRequests(false);
      toast.success("You checked out.");
      void captureAndLoadPlaces();
    } catch {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        toast.error(
          "Checkout didn't complete. You may still be visible—please try again.",
        );
      }
    } finally {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        mutationInFlightRef.current = false;
        setBusy(null);
      }
    }
  };

  const connect = async (attendee: OneLocationNearbyAttendee) => {
    if (
      !ownerId ||
      !vaultOwnerToken ||
      busy !== null ||
      mutationInFlightRef.current
    ) {
      return;
    }
    const ownerToken = vaultOwnerToken;
    const expectedOwnerEpoch = ownerEpochRef.current;
    const generation = ++presenceMutationGenerationRef.current;
    presenceReadGenerationRef.current += 1;
    mutationInFlightRef.current = true;
    const key = `connect:${attendee.participantAlias}`;
    setBusy(key);
    try {
      const result = await OneLocationService.requestNearbyConnection({
        vaultOwnerToken: ownerToken,
        participantAlias: attendee.participantAlias,
      });
      if (
        ownerEpochRef.current !== expectedOwnerEpoch ||
        presenceMutationGenerationRef.current !== generation
      ) {
        return;
      }
      setState((current) => {
        const next = {
          ...current,
          attendees: current.attendees.map((item) =>
            item.participantAlias === attendee.participantAlias
              ? { ...item, relationship: result.relationship }
              : item,
          ),
        };
        onStateChange?.(next);
        return next;
      });
      toast.success("Connection request sent.");
    } catch {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        toast.error(
          "That person may no longer be nearby. Refreshing the list.",
        );
        setBusy(null);
        mutationInFlightRef.current = false;
        void loadPresence(true, expectedOwnerEpoch);
      }
    } finally {
      if (
        ownerEpochRef.current === expectedOwnerEpoch &&
        presenceMutationGenerationRef.current === generation
      ) {
        mutationInFlightRef.current = false;
        setBusy(null);
      }
    }
  };

  const openRecoverySettings = async () => {
    if (!locationRecovery || busy !== null) return;
    setBusy("settings");
    try {
      if (locationRecovery === "location-settings") {
        await OneLocationService.openLocationSettings();
      } else {
        await OneLocationService.openAppSettings();
      }
    } catch {
      toast.error("Settings could not be opened. Please open them manually.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet modal open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        dragDismiss={false}
        showDragHandle={false}
        className="gap-0 overflow-hidden px-0 pb-[max(1rem,env(safe-area-inset-bottom))] md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none md:w-[26rem] md:rounded-none md:rounded-l-[var(--app-card-radius-feature)] md:border-l md:border-t-0 md:data-[state=closed]:slide-out-to-right md:data-[state=open]:slide-in-from-right"
        data-testid="one-location-nearby-check-in-sheet"
      >
        <SheetHeader className="border-b border-border/60 px-5 pb-4 text-left">
          <div className="flex items-center gap-2 pr-10">
            <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--app-accent-surface-strong)] text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]">
              <UsersRound className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle>Check in nearby</SheetTitle>
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  Preview
                </span>
              </div>
              <SheetDescription>
                UAT simulation for opted-in people within 500 metres.
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {state.presence
              ? `Nearby check-in active. ${state.attendees.length} ${
                  state.attendees.length === 1 ? "person" : "people"
                } nearby.`
              : "Nearby check-in is not active."}
          </p>
          {loadingPresence && !state.presence ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Checking your current status…
            </div>
          ) : null}

          {presenceLoadError && !state.presence ? (
            <div
              className="mb-4 rounded-2xl border border-destructive/20 bg-destructive/10 p-3"
              role="alert"
            >
              <p className="text-sm text-destructive">{presenceLoadError}</p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="mt-2"
                disabled={loadingPresence}
                onClick={() => void retryPresenceLoad()}
              >
                {loadingPresence ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Retry status
              </Button>
            </div>
          ) : null}

          {loadingPresence && !state.presence ? null : state.presence ? (
            <div className="space-y-4" data-testid="nearby-presence-active">
              <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">You’re visible nearby</p>
                    <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                      {state.presence.placeLabel || "Your selected place"} ·{" "}
                      {state.presence.radiusMeters} m radius ·{" "}
                      {timeLeftLabel(state.presence.expiresAt)}
                    </p>
                  </div>
                </div>
              </section>

              <section aria-labelledby="nearby-people-title">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <h2 id="nearby-people-title" className="font-semibold">
                      People nearby
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Only active, opted-in One users appear here.
                    </p>
                  </div>
                  <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">
                    {state.attendees.length}
                  </span>
                </div>
                {state.attendees.length ? (
                  <ul className="mt-2" data-testid="nearby-attendee-roster">
                    {state.attendees.map((attendee) => (
                      <NearbyPersonRow
                        key={attendee.participantAlias}
                        attendee={attendee}
                        busy={busy === `connect:${attendee.participantAlias}`}
                        interactionDisabled={busy !== null}
                        onConnect={() => void connect(attendee)}
                        onRespond={() =>
                          router.push(
                            buildConsentCenterHref("pending", {
                              from: `${ROUTES.ONE_LOCATION_MAP}?action=check-in`,
                            }),
                          )
                        }
                      />
                    ))}
                  </ul>
                ) : (
                  <div className="mt-3 rounded-2xl bg-muted/70 px-4 py-5 text-center">
                    <UsersRound className="mx-auto h-5 w-5 text-muted-foreground" />
                    <p className="mt-2 text-sm font-medium">
                      No one else is checked in nearby yet
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      We’ll refresh automatically while your check-in is active.
                    </p>
                  </div>
                )}
              </section>

              <Button
                type="button"
                variant="destructive"
                className="w-full"
                disabled={busy !== null}
                onClick={() => void checkout()}
              >
                {busy === "checkout" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Check out now
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Nearby people appear as a list. Their precise locations are
                never pinned on your map.
              </p>
            </div>
          ) : (
            <div className="space-y-5" data-testid="nearby-presence-setup">
              <section>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">Choose your place</h2>
                    <p className="text-sm text-muted-foreground">
                      The nearest result is selected for you.
                    </p>
                  </div>
                  {capturing ? (
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  ) : null}
                </div>

                {locationError ? (
                  <div className="mt-3 rounded-2xl border border-destructive/20 bg-destructive/10 p-3">
                    <p className="text-sm text-destructive">{locationError}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={capturing || busy === "settings"}
                        onClick={() => void captureAndLoadPlaces()}
                      >
                        {capturing ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        Try location again
                      </Button>
                      {locationRecovery && isNative() ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy === "settings"}
                          onClick={() => void openRecoverySettings()}
                        >
                          {busy === "settings" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : null}
                          Open settings
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <>
                    <label className="relative mt-3 block">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <span className="sr-only">Search for another place</span>
                      <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        disabled={!point}
                        placeholder="Search for another place"
                        className="h-11 rounded-full pl-9"
                      />
                      {searching ? (
                        <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                      ) : null}
                    </label>

                    <div
                      className="mt-3 space-y-2"
                      role="radiogroup"
                      aria-label="Nearby places"
                    >
                      {places.map((place) => {
                        const selected = place.placeId === selectedPlaceId;
                        return (
                          <button
                            key={place.placeId}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={cn(
                              "flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors",
                              selected
                                ? "border-[var(--app-accent)] bg-[var(--app-accent-surface)]"
                                : "border-border/60 bg-muted/50 hover:bg-muted",
                            )}
                            onClick={() => setSelectedPlaceId(place.placeId)}
                          >
                            <MapPin className="h-4 w-4 shrink-0 text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]" />
                            <span className="min-w-0 flex-1 break-words text-sm font-medium leading-5">
                              {place.text}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {distanceLabel(place.distanceMeters)}
                            </span>
                            {selected ? (
                              <Check className="h-4 w-4 shrink-0 text-[var(--app-accent-deep)] dark:text-[var(--app-accent-bright)]" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                    {placesError ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {placesError}
                      </p>
                    ) : null}
                  </>
                )}
              </section>

              <section>
                <div className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4 text-muted-foreground" />
                  <h2 className="font-semibold">Stay visible for</h2>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {DURATIONS.map((duration) => (
                    <Button
                      key={duration.value}
                      type="button"
                      variant={
                        durationMinutes === duration.value
                          ? "default"
                          : "secondary"
                      }
                      aria-pressed={durationMinutes === duration.value}
                      onClick={() => setDurationMinutes(duration.value)}
                    >
                      {duration.label}
                    </Button>
                  ))}
                </div>
              </section>

              <section className="space-y-3 rounded-2xl border border-border/60 p-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox
                    className="mt-0.5"
                    checked={consentAccepted}
                    onCheckedChange={(checked) =>
                      setConsentAccepted(checked === true)
                    }
                  />
                  <span>
                    <span className="block text-sm font-semibold">
                      Let nearby checked-in users see me
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      Your current point is sent once to Google to suggest nearby
                      places; searching may send it again to improve results.
                      Hussh does not store the raw GPS fix, and nearby people
                      never receive it. If you check in, they see your name only.
                      Closing the app does not check you out.
                    </span>
                  </span>
                </label>

                <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-3">
                  <div>
                    <p className="text-sm font-semibold">
                      Allow connection requests
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Off by default. You can still connect with others.
                    </p>
                  </div>
                  <Switch
                    checked={allowConnectionRequests}
                    onCheckedChange={setAllowConnectionRequests}
                    aria-label="Allow nearby connection requests"
                  />
                </div>
              </section>

              <Button
                type="button"
                className="h-12 w-full"
                disabled={
                  busy !== null ||
                  capturing ||
                  !point ||
                  !selectedPlace ||
                  !consentAccepted
                }
                onClick={() => void checkIn()}
              >
                {busy === "check-in" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UsersRound className="h-4 w-4" />
                )}
                Check in and see people
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

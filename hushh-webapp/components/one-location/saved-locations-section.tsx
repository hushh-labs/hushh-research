"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Briefcase,
  ChevronRight,
  Home,
  Loader2,
  MapPin,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { SaveLocationModal } from "@/components/one-location/onboarding/save-location-modal";
import type { PickedLocation } from "@/components/one-location/onboarding/location-picker-map";
import { GOOGLE_MAPS_RENDERER_CONSENT_VERSION } from "@/lib/one-location/map-renderer-consent";
import { useAuth } from "@/lib/firebase/auth-context";
import {
  addSavedLocation,
  duplicateSavedLocationMessage,
  DuplicateSavedLocationError,
  findDuplicateSavedLocation,
  loadSavedLocations,
  removeSavedLocation,
  sortSavedLocationsForDisplay,
  type SavedLocation,
  type SavedLocationCategory,
  updateSavedLocation,
  updateSavedLocationAddress,
} from "@/lib/one-location/saved-locations";
import {
  buildSavedLocationAddress,
  inferPostalCode,
  type SavedLocationAddressDetails,
} from "@/lib/one-location/saved-location-address";

import { readOneLocationControlState } from "@/lib/one-location/location-control-state";
import { OneLocationService } from "@/lib/one-location/service";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import { useOneLocationControlState } from "@/lib/one-location/use-location-control-state";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

function CategoryIcon({ category }: { category: SavedLocationCategory }) {
  const Icon =
    category === "home" ? Home : category === "work" ? Briefcase : MapPin;
  return (
    <span
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[color:var(--app-icon-tile-foreground)] text-white"
      data-testid={`saved-location-icon-${category}`}
      data-icon-tone="neutral-graphite"
      aria-hidden="true"
    >
      <Icon className="h-4 w-4" strokeWidth={1.8} />
    </span>
  );
}

export function SavedLocationsSection() {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const userId = user?.uid ?? null;
  const locationControl = useOneLocationControlState(userId);
  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // One row open at a time: this is a short list a person scans, not a set of
  // panels they compare, and several open rows push the rest off the screen.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [repairingId, setRepairingId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [saveLocationModalOpen, setSaveLocationModalOpen] = useState(false);
  const [saveLocationPoint, setSaveLocationPoint] =
    useState<PlainLocationPoint | null>(null);
  const [saveLocationAddress, setSaveLocationAddress] = useState<string | null>(
    null,
  );
  const [saveLocationAddressLoading, setSaveLocationAddressLoading] =
    useState(false);
  const [saveLocationSaving, setSaveLocationSaving] = useState(false);
  // When set, the modal is editing an existing saved place (Settings edit flow)
  // instead of adding a new one. Holds the id + pre-fill values for the modal.
  const [editingLocation, setEditingLocation] = useState<SavedLocation | null>(
    null,
  );
  const [rendererDisclosureAccepted, setRendererDisclosureAccepted] =
    useState(false);

  const vaultSessionRef = useRef({ userId, vaultKey, vaultOwnerToken });
  const captureRequestIdRef = useRef(0);
  const addressResolutionIdRef = useRef(0);

  // Keep a "latest session" ref so async callbacks can detect when the vault
  // session changed mid-flight. Updated in an effect (not during render) to
  // satisfy the react-hooks/refs rule.
  useEffect(() => {
    vaultSessionRef.current = { userId, vaultKey, vaultOwnerToken };
  }, [userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    let cancelled = false;
    setRendererDisclosureAccepted(false);
    if (!vaultOwnerToken) return () => undefined;

    void OneLocationService.getMapState(vaultOwnerToken)
      .then((state) => {
        if (cancelled) return;
        setRendererDisclosureAccepted(
          state.preferences.rendererConsentVersion ===
            GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
        );
      })
      .catch(() => {
        // Fail closed: show the disclosure again when canonical state cannot
        // be read instead of assuming a prior acceptance.
      });

    return () => {
      cancelled = true;
    };
  }, [vaultOwnerToken]);

  const hasVaultAccess = Boolean(
    isVaultUnlocked && vaultKey && vaultOwnerToken,
  );
  const isCurrentVaultSession = useCallback(
    (session: {
      userId: string | null;
      vaultKey: string | null;
      vaultOwnerToken: string | null;
    }) => {
      const current = vaultSessionRef.current;
      return (
        current.userId === session.userId &&
        current.vaultKey === session.vaultKey &&
        current.vaultOwnerToken === session.vaultOwnerToken
      );
    },
    [],
  );

  const reload = useCallback(async () => {
    if (!userId) {
      setLocations([]);
      setLoadedUserId(null);
      setLoadError(null);
      return;
    }
    if (!vaultKey || !vaultOwnerToken) {
      setLocations([]);
      setLoadedUserId(userId);
      setLoadError(null);
      return;
    }

    setLoading(true);
    setLoadError(null);
    const session = { userId, vaultKey, vaultOwnerToken };
    try {
      const list = await loadSavedLocations({
        userId,
        vaultKey,
        vaultOwnerToken,
      });
      if (!isCurrentVaultSession(session)) return;
      setLocations(sortSavedLocationsForDisplay(list));
    } catch {
      if (!isCurrentVaultSession(session)) return;
      setLocations([]);
      setLoadError("Saved locations could not be loaded. Try again.");
    } finally {
      if (isCurrentVaultSession(session)) {
        setLoadedUserId(userId);
        setLoading(false);
      }
    }
  }, [isCurrentVaultSession, userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (hasVaultAccess) return;
    captureRequestIdRef.current += 1;
    addressResolutionIdRef.current += 1;
    setLocations([]);
    setSaveLocationModalOpen(false);
    setSaveLocationPoint(null);
    setSaveLocationAddress(null);
    setSaveLocationAddressLoading(false);
    setSaveLocationSaving(false);
    setCapturing(false);
    setRemovingId(null);
    setRepairingId(null);
    setLoading(false);
  }, [hasVaultAccess]);

  useEffect(() => {
    if (!locationControl.paused) return;
    captureRequestIdRef.current += 1;
    addressResolutionIdRef.current += 1;
    setCapturing(false);
    setSaveLocationModalOpen(false);
    setSaveLocationPoint(null);
    setSaveLocationAddress(null);
    setSaveLocationAddressLoading(false);
  }, [locationControl.paused]);

  const handleAdd = useCallback(async () => {
    if (!userId || !vaultKey || !vaultOwnerToken || capturing) {
      if (!hasVaultAccess) {
        toast.error("Unlock your vault before adding a saved location.");
      }
      return;
    }
    if (readOneLocationControlState(userId).paused) {
      toast.error("Resume Location before adding a saved place.");
      return;
    }

    addressResolutionIdRef.current += 1;
    setCapturing(true);
    const captureRequestId = captureRequestIdRef.current + 1;
    captureRequestIdRef.current = captureRequestId;
    const session = { userId, vaultKey, vaultOwnerToken };
    try {
      // Saving a place records where the user is standing right now — a fix
      // from the last few seconds says the same thing and costs nothing.
      const point = await OneLocationService.captureCurrentPosition({
        fresh: true,
      });
      if (
        captureRequestIdRef.current !== captureRequestId ||
        !isCurrentVaultSession(session) ||
        readOneLocationControlState(userId).paused
      ) {
        return;
      }
      setSaveLocationPoint(point);
      setSaveLocationAddress(null);
      setSaveLocationAddressLoading(true);
      setSaveLocationModalOpen(true);
      const addressResolutionId = addressResolutionIdRef.current + 1;
      addressResolutionIdRef.current = addressResolutionId;

      try {
        const place = await OneLocationService.reverseGeocode({
          vaultOwnerToken,
          lat: point.latitude,
          lng: point.longitude,
        });
        if (
          captureRequestIdRef.current !== captureRequestId ||
          addressResolutionIdRef.current !== addressResolutionId ||
          !isCurrentVaultSession(session) ||
          readOneLocationControlState(userId).paused
        ) {
          return;
        }
        setSaveLocationAddress(
          (place.formattedAddress || place.name || "").trim() || null,
        );
      } catch {
        if (
          captureRequestIdRef.current !== captureRequestId ||
          addressResolutionIdRef.current !== addressResolutionId ||
          !isCurrentVaultSession(session)
        ) {
          return;
        }
        setSaveLocationAddress(null);
      } finally {
        if (
          captureRequestIdRef.current === captureRequestId &&
          addressResolutionIdRef.current === addressResolutionId &&
          isCurrentVaultSession(session)
        ) {
          setSaveLocationAddressLoading(false);
        }
      }
    } catch {
      if (
        captureRequestIdRef.current !== captureRequestId ||
        !isCurrentVaultSession(session)
      ) {
        return;
      }
      toast.error("Check location permission and try again.");
    } finally {
      if (
        captureRequestIdRef.current === captureRequestId &&
        isCurrentVaultSession(session)
      ) {
        setCapturing(false);
      }
    }
  }, [
    capturing,
    hasVaultAccess,
    isCurrentVaultSession,
    userId,
    vaultKey,
    vaultOwnerToken,
  ]);

  const handleSave = useCallback(
    async (
      category: SavedLocationCategory,
      label: string,
      details?: SavedLocationAddressDetails,
      addressLine?: string | null,
    ) => {
      if (!userId || !vaultKey || !vaultOwnerToken || !saveLocationPoint) {
        toast.error("Unlock your vault and capture the location again.");
        return;
      }

      // Compose from the Address field the person just confirmed, NOT from
      // this component's `saveLocationAddress`. On an edit the latter holds
      // the previously composed line, so folding the details in again
      // prepended them to a string that already began with them -- "Flat 5C,
      // Flat 4B, Blue gate building, ..." growing on every save until it hit
      // the 300-character ceiling. The base is stored alongside so the next
      // edit rebuilds from parts instead of from the result.
      const baseAddress =
        addressLine === undefined ? saveLocationAddress : addressLine;
      const composedAddress = details
        ? buildSavedLocationAddress(baseAddress, details)
        : baseAddress;

      const editing = editingLocation;
      // Only guard against a *different* saved place occupying the same spot.
      // When editing, re-saving the same place must not trip the duplicate gate.
      const duplicate = findDuplicateSavedLocation(
        editing
          ? locations.filter((location) => location.id !== editing.id)
          : locations,
        saveLocationPoint,
      );
      if (duplicate) {
        toast.error(duplicateSavedLocationMessage(duplicate));
        return;
      }

      setSaveLocationSaving(true);
      const session = { userId, vaultKey, vaultOwnerToken };
      try {
        const input = {
          category,
          label,
          latitude: saveLocationPoint.latitude,
          longitude: saveLocationPoint.longitude,
          address: composedAddress,
          addressBase: baseAddress,
          addressDetails: details ?? null,
        };
        const next = editing
          ? await updateSavedLocation({
              context: { userId, vaultKey, vaultOwnerToken },
              id: editing.id,
              input,
            })
          : await addSavedLocation({
              context: { userId, vaultKey, vaultOwnerToken },
              input,
            });
        if (!isCurrentVaultSession(session)) return;
        addressResolutionIdRef.current += 1;
        setLocations(sortSavedLocationsForDisplay(next));
        setSaveLocationModalOpen(false);
        setSaveLocationPoint(null);
        setEditingLocation(null);
        toast.success(
          editing ? "Location updated." : "Location saved securely.",
        );
      } catch (error) {
        if (!isCurrentVaultSession(session)) return;
        toast.error(
          error instanceof DuplicateSavedLocationError
            ? error.message
            : "Could not save this location. Please try again.",
        );
      } finally {
        if (isCurrentVaultSession(session)) {
          setSaveLocationSaving(false);
        }
      }
    },
    [
      editingLocation,
      saveLocationAddress,
      saveLocationPoint,
      locations,
      isCurrentVaultSession,
      userId,
      vaultKey,
      vaultOwnerToken,
    ],
  );

  // Open the same add/pin/details flow pre-filled to EDIT an existing place.
  const handleEditSavedLocation = useCallback(
    (location: SavedLocation) => {
      if (!hasVaultAccess) {
        toast.error("Unlock your vault before editing a saved location.");
        return;
      }
      addressResolutionIdRef.current += 1;
      captureRequestIdRef.current += 1;
      setEditingLocation(location);
      setSaveLocationPoint({
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyM: null,
        capturedAt: new Date().toISOString(),
        sourcePlatform: "web",
      });
      // The street address on its own where it was recorded. Places saved
      // before that was kept fall back to their composed line, which is the
      // closest thing they have to a base and is at least editable.
      setSaveLocationAddress(location.addressBase ?? location.address ?? null);
      setSaveLocationAddressLoading(false);
      setSaveLocationModalOpen(true);
    },
    [hasVaultAccess],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      if (!userId || !vaultKey || !vaultOwnerToken || removingId) return;
      setRemovingId(id);
      const session = { userId, vaultKey, vaultOwnerToken };
      try {
        const next = await removeSavedLocation({
          context: { userId, vaultKey, vaultOwnerToken },
          id,
        });
        if (!isCurrentVaultSession(session)) return;
        setLocations(sortSavedLocationsForDisplay(next));
        toast.success("Saved location removed.");
      } catch {
        if (!isCurrentVaultSession(session)) return;
        toast.error("Could not remove this location. Please try again.");
      } finally {
        if (isCurrentVaultSession(session)) {
          setRemovingId(null);
        }
      }
    },
    [isCurrentVaultSession, removingId, userId, vaultKey, vaultOwnerToken],
  );

  const handleRepairAddress = useCallback(
    async (location: SavedLocation) => {
      if (!userId || !vaultKey || !vaultOwnerToken || repairingId) return;
      setRepairingId(location.id);
      const session = { userId, vaultKey, vaultOwnerToken };
      try {
        const place = await OneLocationService.reverseGeocode({
          vaultOwnerToken,
          lat: location.latitude,
          lng: location.longitude,
        });
        if (!isCurrentVaultSession(session)) return;
        const address = (place.formattedAddress || place.name || "").trim();
        if (!address) {
          toast.error("No street address was found for this location.");
          return;
        }
        const next = await updateSavedLocationAddress({
          context: { userId, vaultKey, vaultOwnerToken },
          id: location.id,
          address,
        });
        if (!isCurrentVaultSession(session)) return;
        setLocations(sortSavedLocationsForDisplay(next));
        toast.success("Address updated.");
      } catch {
        if (!isCurrentVaultSession(session)) return;
        toast.error("Could not find the address. Please try again.");
      } finally {
        if (isCurrentVaultSession(session)) {
          setRepairingId(null);
        }
      }
    },
    [isCurrentVaultSession, repairingId, userId, vaultKey, vaultOwnerToken],
  );

  // Drag-to-pin confirm: adopt the owner-confirmed coordinate and address,
  // replacing the coarse GPS fix for the Settings "Add place" flow.
  const handlePickExactSavedLocation = useCallback((picked: PickedLocation) => {
    addressResolutionIdRef.current += 1;
    setSaveLocationPoint((current) => ({
      latitude: picked.latitude,
      longitude: picked.longitude,
      accuracyM: null,
      capturedAt: new Date().toISOString(),
      sourcePlatform: current?.sourcePlatform ?? "web",
    }));
    setSaveLocationAddress(picked.address);
    setSaveLocationAddressLoading(false);
  }, []);

  // "Locate me" inside the map picker — re-centre on a current fix.
  const locateMeForSavedLocation = useCallback(async () => {
    try {
      const point = await OneLocationService.captureCurrentPosition({
        fresh: true,
      });
      return { latitude: point.latitude, longitude: point.longitude };
    } catch {
      return null;
    }
  }, []);

  // Reverse-geocode wrapper the map picker calls on every settle.
  const reverseGeocodeForSavedLocation = useCallback(
    async (lat: number, lng: number): Promise<string | null> => {
      if (!vaultOwnerToken) return null;
      try {
        const place = await OneLocationService.reverseGeocode({
          vaultOwnerToken,
          lat,
          lng,
        });
        return place.formattedAddress || place.name || null;
      } catch {
        return null;
      }
    },
    [vaultOwnerToken],
  );

  const acceptSavedLocationMapRenderer = useCallback(async () => {
    if (!vaultOwnerToken) {
      throw new Error("Unlock your vault before opening Google Maps.");
    }
    const next = await OneLocationService.updateMapPreferences({
      vaultOwnerToken,
      rendererConsentVersion: GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
    });
    setRendererDisclosureAccepted(
      next.rendererConsentVersion === GOOGLE_MAPS_RENDERER_CONSENT_VERSION,
    );
  }, [vaultOwnerToken]);

  if (!userId || loadedUserId !== userId) return null;

  return (
    <>
      <section
        aria-label="Saved Locations"
        className="w-full min-w-0"
        data-testid="settings-saved-locations"
      >
        <div className="mb-2 flex items-baseline justify-between gap-3 px-[6px]">
          <p className="text-[13px] font-normal leading-[18px] text-[color:var(--app-secondary-label)]">
            Places
          </p>
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={!hasVaultAccess || locationControl.paused || capturing}
            className="press-scale relative inline-flex h-auto min-h-0 items-center gap-1.5 rounded-none px-0 text-[15px] font-normal leading-5 text-[color:var(--app-accent)] transition-opacity after:absolute after:-inset-x-3 after:-inset-y-3 after:content-[''] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {capturing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            Add place
          </button>
        </div>

        <div className="overflow-hidden rounded-[16px] bg-[color:var(--app-primary-surface)] shadow-none">
          {!hasVaultAccess ? (
            <div className="flex min-h-[72px] items-center gap-3 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[color:var(--app-icon-tile-foreground)] text-white">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-[17px] font-normal leading-[22px] text-foreground">
                  Unlock your vault to view saved places
                </p>
                <p className="mt-0.5 text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
                  Exact locations stay encrypted and are available only while
                  your vault is unlocked.
                </p>
              </div>
            </div>
          ) : loading ? (
            <div
              className="flex min-h-[58px] items-center gap-3 p-3.5 text-[15px] leading-5 text-muted-foreground"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading saved places…
            </div>
          ) : loadError ? (
            <div className="flex min-h-[58px] items-center justify-between gap-3 p-3.5">
              <p className="text-[15px] leading-5 text-[color:var(--app-destructive)]">
                {loadError}
              </p>
              <button
                type="button"
                onClick={() => void reload()}
                className="rounded-full px-3 py-1.5 text-[13px] font-semibold text-[color:var(--app-accent)]"
              >
                Retry
              </button>
            </div>
          ) : locations.length === 0 ? (
            <div className="flex min-h-[110px] items-center justify-center p-5 text-center sm:min-h-[119px]">
              <div>
                <p className="text-[17px] font-semibold leading-[22px] tracking-[-0.3px] text-[color:var(--app-secondary-label)]">
                  No places yet
                </p>
                <p className="sr-only">
                  Add Home, Work, or another place to see it here.
                </p>
              </div>
            </div>
          ) : (
            locations.map((location, index) => {
              const expanded = expandedId === location.id;
              return (
                <div
                  key={location.id}
                  className={cn(
                    index > 0 && "border-t border-[color:var(--app-separator)]",
                  )}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedId((current) =>
                        current === location.id ? null : location.id,
                      )
                    }
                    aria-expanded={expanded}
                    className="press-scale flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left"
                  >
                    <CategoryIcon category={location.category} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[17px] font-normal leading-[22px] text-foreground">
                        {location.label}
                      </p>
                      <p className="mt-0.5 truncate text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
                        {location.address || "Address unavailable"}
                      </p>
                    </div>
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-[color:var(--app-tertiary-label)] transition-transform duration-200"
                      strokeWidth={1.9}
                      aria-hidden
                    />
                  </button>

                  {expanded ? (
                    <div className="flex items-center gap-2 px-4 pb-3 pl-[60px]">
                      {!location.address ? (
                        <button
                          type="button"
                          onClick={() => void handleRepairAddress(location)}
                          disabled={repairingId !== null}
                          className="press-scale inline-flex h-9 items-center gap-1.5 rounded-full bg-[color:var(--app-accent)]/12 px-3 text-[13px] font-semibold text-[color:var(--app-accent)] disabled:opacity-45"
                        >
                          <RefreshCw
                            className={cn(
                              "h-[15px] w-[15px]",
                              repairingId === location.id && "animate-spin",
                            )}
                            strokeWidth={2}
                            aria-hidden
                          />
                          Find address
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => handleEditSavedLocation(location)}
                        disabled={
                          removingId !== null ||
                          repairingId !== null ||
                          capturing ||
                          locationControl.paused
                        }
                        className="press-scale inline-flex h-9 items-center gap-1.5 rounded-full bg-foreground/[0.05] px-3 text-[13px] font-semibold text-foreground disabled:opacity-45"
                      >
                        <Pencil
                          className="h-[15px] w-[15px]"
                          strokeWidth={2}
                          aria-hidden
                        />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRemove(location.id)}
                        disabled={removingId !== null}
                        className="press-scale inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold text-[color:var(--app-destructive)] transition-colors hover:bg-[color:var(--app-destructive)]/10 disabled:opacity-45"
                      >
                        {removingId === location.id ? (
                          <Loader2
                            className="h-[15px] w-[15px] animate-spin"
                            aria-hidden
                          />
                        ) : (
                          <Trash2
                            className="h-[15px] w-[15px]"
                            strokeWidth={2}
                            aria-hidden
                          />
                        )}
                        Remove
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </section>

      <SaveLocationModal
        open={saveLocationModalOpen}
        address={saveLocationAddress}
        loadingAddress={saveLocationAddressLoading}
        saving={saveLocationSaving}
        mapInitial={
          saveLocationPoint
            ? {
                latitude: saveLocationPoint.latitude,
                longitude: saveLocationPoint.longitude,
              }
            : null
        }
        reverseGeocode={reverseGeocodeForSavedLocation}
        onLocateMe={locateMeForSavedLocation}
        onPickExactLocation={handlePickExactSavedLocation}
        rendererDisclosureAccepted={rendererDisclosureAccepted}
        onAcceptRendererDisclosure={acceptSavedLocationMapRenderer}
        collectAddressDetails
        startWithMapPicker
        initialCategory={editingLocation?.category ?? null}
        // Excluding the place being edited: its own label is still free to it.
        existingLocations={
          editingLocation
            ? locations.filter((location) => location.id !== editingLocation.id)
            : locations
        }

        initialCustomLabel={
          editingLocation?.category === "other" ? editingLocation.label : null
        }
        // What the person actually typed last time. This used to hand back an
        // empty houseOrFlat on every edit, which the modal required before it
        // would enable its own button -- so "Update location" was permanently
        // dead on a screen that gave no reason.
        initialDetails={
          editingLocation
            ? (editingLocation.addressDetails ?? {
                houseOrFlat: "",
                buildingColor: "",
                landmark: "",
                postalCode: inferPostalCode(editingLocation.address),
              })
            : null
        }
        saveLabel={editingLocation ? "Update location" : "Save location"}
        onSave={(category, label, details, addressLine) =>
          void handleSave(category, label, details, addressLine)
        }
        onSkip={() => {
          if (saveLocationSaving) return;
          addressResolutionIdRef.current += 1;
          setSaveLocationModalOpen(false);
          setSaveLocationPoint(null);
          setSaveLocationAddress(null);
          setSaveLocationAddressLoading(false);
          setEditingLocation(null);
        }}
      />
    </>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Briefcase,
  Home,
  Loader2,
  MapPin,
  Plus,
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
  updateSavedLocationAddress,
} from "@/lib/one-location/saved-locations";
import { readOneLocationControlState } from "@/lib/one-location/location-control-state";
import { OneLocationService } from "@/lib/one-location/service";
import type { PlainLocationPoint } from "@/lib/one-location/types";
import { useOneLocationControlState } from "@/lib/one-location/use-location-control-state";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

function CategoryIcon({ category }: { category: SavedLocationCategory }) {
  const Icon =
    category === "home" ? Home : category === "work" ? Briefcase : MapPin;
  const tone =
    category === "home"
      ? "bg-[#e7f0fd] text-[#087ff5] dark:bg-[#087ff5]/15"
      : category === "work"
        ? "bg-[#eef1f5] text-[#5b6472] dark:bg-white/10 dark:text-white/70"
        : "bg-[#e5f4ea] text-[#2ea44f] dark:bg-emerald-400/15";
  return (
    <span
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
        tone,
      )}
      aria-hidden="true"
    >
      <Icon className="h-5 w-5" strokeWidth={2.1} />
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
      const point = await OneLocationService.captureCurrentPosition();
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
      toast.error(
        "We could not read your current location. Check location permission and try again.",
      );
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
    async (category: SavedLocationCategory, label: string) => {
      if (!userId || !vaultKey || !vaultOwnerToken || !saveLocationPoint) {
        toast.error("Unlock your vault and capture the location again.");
        return;
      }

      const duplicate = findDuplicateSavedLocation(
        locations,
        saveLocationPoint,
      );
      if (duplicate) {
        toast.error(duplicateSavedLocationMessage(duplicate));
        return;
      }

      setSaveLocationSaving(true);
      const session = { userId, vaultKey, vaultOwnerToken };
      try {
        const next = await addSavedLocation({
          context: { userId, vaultKey, vaultOwnerToken },
          input: {
            category,
            label,
            latitude: saveLocationPoint.latitude,
            longitude: saveLocationPoint.longitude,
            address: saveLocationAddress,
          },
        });
        if (!isCurrentVaultSession(session)) return;
        addressResolutionIdRef.current += 1;
        setLocations(sortSavedLocationsForDisplay(next));
        setSaveLocationModalOpen(false);
        setSaveLocationPoint(null);
        toast.success("Location saved securely.");
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
      saveLocationAddress,
      saveLocationPoint,
      locations,
      isCurrentVaultSession,
      userId,
      vaultKey,
      vaultOwnerToken,
    ],
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

  // "Locate me" inside the map picker — re-center on a fresh GPS fix.
  const locateMeForSavedLocation = useCallback(async () => {
    try {
      const point = await OneLocationService.captureCurrentPosition();
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
        <div className="mb-2.5 flex items-center justify-between gap-3 px-1">
          <p className="text-[12px] font-bold uppercase tracking-[0.6px] text-black/40 dark:text-muted-foreground">
            Saved Locations
          </p>
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={!hasVaultAccess || locationControl.paused || capturing}
            className="press-scale inline-flex h-8 items-center gap-1.5 rounded-full bg-[color:var(--app-accent-tint,#e7f0fd)] px-3 text-[12px] font-bold text-[color:var(--app-accent-deep,#0b62c4)] transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
          >
            {capturing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden />
            )}
            Add place
          </button>
        </div>

        <div className="overflow-hidden rounded-2xl bg-white shadow-[0_2px_10px_rgba(0,0,0,0.05)] dark:bg-[color:var(--app-card-surface-default-solid)]">
          {!hasVaultAccess ? (
            <div className="flex items-center gap-3.5 p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#eef1f5] text-[#8b93a1] dark:bg-white/10">
                <ShieldCheck className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-[#1c1c2e] dark:text-foreground">
                  Unlock your vault to view saved places
                </p>
                <p className="mt-0.5 text-[13px] leading-[1.4] text-black/50 dark:text-muted-foreground">
                  Exact locations stay encrypted and are available only while
                  your vault is unlocked.
                </p>
              </div>
            </div>
          ) : loading ? (
            <div
              className="flex items-center gap-3 p-4 text-[13px] text-black/50 dark:text-muted-foreground"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading saved places…
            </div>
          ) : loadError ? (
            <div className="flex items-center justify-between gap-3 p-4">
              <p className="text-[13px] text-[#b42318] dark:text-red-300">
                {loadError}
              </p>
              <button
                type="button"
                onClick={() => void reload()}
                className="rounded-full px-3 py-1.5 text-[12px] font-bold text-[color:var(--app-accent,#087ff5)]"
              >
                Retry
              </button>
            </div>
          ) : locations.length === 0 ? (
            <div className="flex items-center gap-3.5 p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#eef1f5] text-[#8b93a1] dark:bg-white/10">
                <MapPin className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-[#1c1c2e] dark:text-foreground">
                  No saved places yet
                </p>
                <p className="mt-0.5 text-[13px] leading-[1.4] text-black/50 dark:text-muted-foreground">
                  Add Home, Work, or another place to see it here.
                </p>
              </div>
            </div>
          ) : (
            locations.map((location, index) => (
              <div
                key={location.id}
                className={cn(
                  "flex items-center gap-3.5 p-4",
                  index > 0 &&
                    "border-t border-black/[0.06] dark:border-white/10",
                )}
              >
                <CategoryIcon category={location.category} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-[#1c1c2e] dark:text-foreground">
                    {location.label}
                  </p>
                  <p className="mt-0.5 truncate text-[13px] text-black/50 dark:text-muted-foreground">
                    {location.address || "Address unavailable"}
                  </p>
                </div>
                {!location.address ? (
                  <button
                    type="button"
                    aria-label={`Find address for ${location.label}`}
                    title="Find address"
                    onClick={() => void handleRepairAddress(location)}
                    disabled={repairingId !== null}
                    className="press-scale flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#8b93a1] transition-colors hover:bg-black/[0.05] hover:text-[#087ff5] disabled:opacity-45 dark:text-muted-foreground"
                  >
                    <RefreshCw
                      className={cn(
                        "h-[17px] w-[17px]",
                        repairingId === location.id && "animate-spin",
                      )}
                      strokeWidth={2}
                    />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove ${location.label}`}
                  onClick={() => void handleRemove(location.id)}
                  disabled={removingId !== null}
                  className="press-scale flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#8b93a1] transition-colors hover:bg-[#ff3b30]/10 hover:text-[#ff3b30] disabled:opacity-45 dark:text-muted-foreground"
                >
                  {removingId === location.id ? (
                    <Loader2 className="h-[18px] w-[18px] animate-spin" />
                  ) : (
                    <Trash2 className="h-[18px] w-[18px]" strokeWidth={2} />
                  )}
                </button>
              </div>
            ))
          )}
        </div>
        {hasVaultAccess ? (
          <p className="mt-2 px-1 text-[11px] leading-[1.45] text-black/40 dark:text-muted-foreground">
            {locationControl.paused
              ? "Resume Location before capturing another saved place."
              : "Saved places are encrypted in your vault and shared only when you explicitly approve location access."}
          </p>
        ) : null}
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
        onSave={(category, label) => void handleSave(category, label)}
        onSkip={() => {
          if (saveLocationSaving) return;
          addressResolutionIdRef.current += 1;
          setSaveLocationModalOpen(false);
          setSaveLocationPoint(null);
          setSaveLocationAddress(null);
          setSaveLocationAddressLoading(false);
        }}
      />
    </>
  );
}

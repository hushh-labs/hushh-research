"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Briefcase, Home, MapPin, Trash2 } from "lucide-react";

import { useAuth } from "@/lib/firebase/auth-context";
import { OneLocationService } from "@/lib/one-location/service";
import { cn } from "@/lib/utils";
import {
  loadSavedLocations,
  removeSavedLocation,
  sortSavedLocationsForDisplay,
  type SavedLocation,
  type SavedLocationCategory,
  updateSavedLocationAddress,
} from "@/lib/one-location/saved-locations";
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

/**
 * SavedLocationsSection — Settings surface listing the places the user tagged
 * during Location onboarding (Home / Work / Other). Reads from the device-local
 * saved-locations store and lets the user remove any entry. Fully self-contained
 * and responsive; renders nothing until the user is known.
 */
export function SavedLocationsSection() {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  const userId = user?.uid ?? null;
  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const addressAttemptsRef = useRef(new Set<string>());

  const reload = useCallback(async () => {
    if (!userId) {
      setLocations([]);
      setLoadedUserId(null);
      return;
    }
    const list = await loadSavedLocations(userId);
    setLocations(sortSavedLocationsForDisplay(list));
    setLoadedUserId(userId);
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    addressAttemptsRef.current.clear();
  }, [userId, vaultOwnerToken]);

  useEffect(() => {
    if (loadedUserId !== userId || !userId || !vaultOwnerToken) return;
    const unresolved = locations.filter((location) => {
      const attemptKey = `${userId}:${location.id}:${location.latitude}:${location.longitude}`;
      return !location.address?.trim() && !addressAttemptsRef.current.has(attemptKey);
    });
    if (unresolved.length === 0) return;

    for (const location of unresolved) {
      addressAttemptsRef.current.add(
        `${userId}:${location.id}:${location.latitude}:${location.longitude}`,
      );
    }

    let cancelled = false;
    void (async () => {
      let repairedLocations = locations;
      for (const location of unresolved) {
        if (cancelled) return;
        try {
          const place = await OneLocationService.reverseGeocode({
            vaultOwnerToken,
            lat: location.latitude,
            lng: location.longitude,
          });
          if (cancelled) return;
          const address = (
            place.formattedAddress ||
            place.name ||
            ""
          ).trim();
          if (!address) continue;

          repairedLocations = await updateSavedLocationAddress(
            userId,
            location.id,
            address,
          );
          const savedLocationStillExists = repairedLocations.some(
            (savedLocation) => savedLocation.id === location.id,
          );
          if (!savedLocationStillExists || cancelled) continue;
          void OneLocationService.saveSavedPlace({
            vaultOwnerToken,
            category: location.category,
            label: location.label,
            latitude: location.latitude,
            longitude: location.longitude,
            address,
          }).catch(() => {
            // Device-local repair remains useful if backend persistence fails.
          });
        } catch {
          // Best-effort repair. The UI keeps the coordinate private.
        }
      }
      if (!cancelled) {
        setLocations(sortSavedLocationsForDisplay(repairedLocations));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadedUserId, locations, userId, vaultOwnerToken]);

  const handleRemove = useCallback(
    async (id: string) => {
      if (!userId) return;
      const next = await removeSavedLocation(userId, id);
      setLocations(sortSavedLocationsForDisplay(next));
    },
    [userId],
  );

  if (!userId || loadedUserId !== userId) return null;

  return (
    <section
      aria-label="Saved Locations"
      className="w-full min-w-0"
      data-testid="settings-saved-locations"
    >
      <p className="mb-2.5 px-1 text-[12px] font-bold uppercase tracking-[0.6px] text-black/40 dark:text-muted-foreground">
        Saved Locations
      </p>
      <div className="overflow-hidden rounded-2xl bg-white shadow-[0_2px_10px_rgba(0,0,0,0.05)] dark:bg-[color:var(--app-card-surface-default-solid)]">
        {locations.length === 0 ? (
          <div className="flex items-center gap-3.5 p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#eef1f5] text-[#8b93a1] dark:bg-white/10">
              <MapPin className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-[15px] font-semibold text-[#1c1c2e] dark:text-foreground">
                No saved places yet
              </p>
              <p className="mt-0.5 text-[13px] leading-[1.4] text-black/50 dark:text-muted-foreground">
                Tag your Home, Work, or other spots during Location setup and
                they will appear here.
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
              <button
                type="button"
                aria-label={`Remove ${location.label}`}
                onClick={() => void handleRemove(location.id)}
                className="press-scale flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#8b93a1] transition-colors hover:bg-[#ff3b30]/10 hover:text-[#ff3b30] dark:text-muted-foreground"
              >
                <Trash2 className="h-[18px] w-[18px]" strokeWidth={2} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

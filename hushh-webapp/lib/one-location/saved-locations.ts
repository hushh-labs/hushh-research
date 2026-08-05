"use client";

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { buildPersonalKnowledgeModelStructureArtifacts } from "@/lib/personal-knowledge-model/manifest";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { haversineMeters } from "@/lib/one-location/marker-interpolation";

export const LOCATION_PKM_DOMAIN = "location";

const SAVED_PLACES_KEY = "saved_places";
const SAVED_PLACES_SCHEMA_VERSION = 1;
const MAX_LABEL_LENGTH = 40;
const MAX_ADDRESS_LENGTH = 300;
export const SAVED_LOCATION_DUPLICATE_RADIUS_METERS = 25;

export type SavedLocationCategory = "home" | "work" | "other";

const SAVED_LOCATION_CATEGORY_PRIORITY: Record<SavedLocationCategory, number> = {
  home: 0,
  work: 1,
  other: 2,
};

export type SavedLocation = {
  id: string;
  category: SavedLocationCategory;
  label: string;
  latitude: number;
  longitude: number;
  address?: string | null;
  savedAt: string;
};

export type SavedLocationVaultContext = {
  userId: string;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
};

export class DuplicateSavedLocationError extends Error {
  readonly code = "duplicate_saved_location";
  readonly existingCategory: SavedLocationCategory;
  readonly existingLabel: string;

  constructor(existingLocation: SavedLocation) {
    super(duplicateSavedLocationMessage(existingLocation));
    this.name = "DuplicateSavedLocationError";
    this.existingCategory = existingLocation.category;
    this.existingLabel = duplicateLocationLabel(existingLocation);
  }
}

type SavedPlacesEnvelope = {
  schema_version: number;
  locations: SavedLocation[];
  updated_at: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isValidLocation(value: unknown): value is SavedLocation {
  if (!value || typeof value !== "object") return false;
  const location = value as Record<string, unknown>;
  return (
    typeof location.id === "string" &&
    location.id.length > 0 &&
    (location.category === "home" ||
      location.category === "work" ||
      location.category === "other") &&
    typeof location.label === "string" &&
    location.label.length > 0 &&
    typeof location.latitude === "number" &&
    Number.isFinite(location.latitude) &&
    location.latitude >= -90 &&
    location.latitude <= 90 &&
    typeof location.longitude === "number" &&
    Number.isFinite(location.longitude) &&
    location.longitude >= -180 &&
    location.longitude <= 180 &&
    (location.address === undefined ||
      location.address === null ||
      typeof location.address === "string") &&
    typeof location.savedAt === "string" &&
    Number.isFinite(Date.parse(location.savedAt))
  );
}

function locationsFromDomain(
  domainData: Record<string, unknown> | null | undefined,
): SavedLocation[] {
  const savedPlaces = asRecord(domainData?.[SAVED_PLACES_KEY]);
  const locations = savedPlaces.locations;
  if (!Array.isArray(locations)) return [];
  return locations.filter(isValidLocation);
}

function requireUnlockedVault(
  context: SavedLocationVaultContext,
): asserts context is SavedLocationVaultContext & {
  vaultKey: string;
  vaultOwnerToken: string;
} {
  if (!context.userId || !context.vaultKey || !context.vaultOwnerToken) {
    throw new Error("Unlock your vault before managing saved locations.");
  }
}

function cleanText(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  const cleaned = String(value || "").trim().slice(0, maxLength);
  return cleaned || null;
}

function generateId(category: SavedLocationCategory): string {
  if (category === "home" || category === "work") return category;
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `other-${randomId}`;
  return `other-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function savedPlacesEnvelope(
  locations: SavedLocation[],
  updatedAt: string,
): SavedPlacesEnvelope {
  return {
    schema_version: SAVED_PLACES_SCHEMA_VERSION,
    locations,
    updated_at: updatedAt,
  };
}

async function mutateSavedLocations(params: {
  context: SavedLocationVaultContext;
  source: string;
  mutate: (locations: SavedLocation[]) => SavedLocation[];
}): Promise<SavedLocation[]> {
  requireUnlockedVault(params.context);
  let persistedLocations: SavedLocation[] = [];

  const result = await PkmWriteCoordinator.saveMergedDomain({
    userId: params.context.userId,
    domain: LOCATION_PKM_DOMAIN,
    vaultKey: params.context.vaultKey,
    vaultOwnerToken: params.context.vaultOwnerToken,
    confirmation: {
      confirmedByUser: true,
      surface: "web",
      source: params.source,
    },
    build: (writeContext) => {
      const updatedAt = new Date().toISOString();
      persistedLocations = params.mutate(
        locationsFromDomain(writeContext.currentDomainData),
      );
      const domainData = {
        ...writeContext.currentDomainData,
        [SAVED_PLACES_KEY]: savedPlacesEnvelope(
          persistedLocations,
          updatedAt,
        ),
      };
      const { manifest } = buildPersonalKnowledgeModelStructureArtifacts({
        domain: LOCATION_PKM_DOMAIN,
        domainData,
        previousManifest: writeContext.currentManifest,
      });
      return {
        domainData,
        manifest,
        scopePath: SAVED_PLACES_KEY,
        // Exact places remain inside encrypted PKM. The readable projection
        // contains only non-sensitive inventory metadata.
        summary: {
          saved_places_configured: persistedLocations.length > 0,
          saved_places_count: persistedLocations.length,
        },
      };
    },
  });

  if (!result.success) {
    throw new Error(result.message || "Could not save locations to your vault.");
  }
  return persistedLocations;
}

/** Default display label for a category. */
export function defaultLabelForCategory(
  category: SavedLocationCategory,
): string {
  if (category === "home") return "Home";
  if (category === "work") return "Work";
  return "Other";
}

function duplicateLocationLabel(location: SavedLocation): string {
  if (location.category !== "other") {
    return defaultLabelForCategory(location.category);
  }
  const label = cleanText(location.label, MAX_LABEL_LENGTH);
  return label && label.toLowerCase() !== "other"
    ? `${label} (Other)`
    : "Other";
}

export function duplicateSavedLocationMessage(location: SavedLocation): string {
  return `This place is already saved as ${duplicateLocationLabel(location)}. Choose a different place or remove it first.`;
}

/** Find the preferred saved point representing the same physical place. */
export function findDuplicateSavedLocation(
  existing: SavedLocation[],
  candidate: Pick<SavedLocation, "latitude" | "longitude">,
): SavedLocation | null {
  return (
    existing
      .filter(
        (location) =>
          haversineMeters(
            { lat: location.latitude, lng: location.longitude },
            { lat: candidate.latitude, lng: candidate.longitude },
          ) <= SAVED_LOCATION_DUPLICATE_RADIUS_METERS,
      )
      .sort((left, right) => {
        const categoryOrder =
          SAVED_LOCATION_CATEGORY_PRIORITY[left.category] -
          SAVED_LOCATION_CATEGORY_PRIORITY[right.category];
        if (categoryOrder !== 0) return categoryOrder;
        const labelOrder = left.label.localeCompare(right.label);
        return labelOrder !== 0 ? labelOrder : left.id.localeCompare(right.id);
      })[0] ?? null
  );
}

/** Read saved places from the encrypted Location PKM domain. */
export async function loadSavedLocations(
  context: SavedLocationVaultContext,
): Promise<SavedLocation[]> {
  requireUnlockedVault(context);
  const resourceParams = {
    userId: context.userId,
    domain: LOCATION_PKM_DOMAIN,
    vaultKey: context.vaultKey,
    vaultOwnerToken: context.vaultOwnerToken,
  };
  const snapshot = await PkmDomainResourceService.getStaleFirst({
    ...resourceParams,
    backgroundRefresh: false,
  });
  if (!snapshot || snapshot.audit.source === "network") {
    return locationsFromDomain(snapshot?.data);
  }

  // Prefer fresh cross-device truth, but retain the encrypted device snapshot
  // when the user is offline.
  const refreshed = await PkmDomainResourceService.refresh(
    resourceParams,
  ).catch(() => null);
  return locationsFromDomain(refreshed?.data ?? snapshot.data);
}

/**
 * Add or replace a saved place in encrypted PKM. Home and Work are singletons,
 * and one physical place can exist under only one category.
 */
export async function addSavedLocation(params: {
  context: SavedLocationVaultContext;
  input: {
    category: SavedLocationCategory;
    label?: string | null;
    latitude: number;
    longitude: number;
    address?: string | null;
  };
}): Promise<SavedLocation[]> {
  const { input } = params;
  if (
    !Number.isFinite(input.latitude) ||
    input.latitude < -90 ||
    input.latitude > 90 ||
    !Number.isFinite(input.longitude) ||
    input.longitude < -180 ||
    input.longitude > 180
  ) {
    throw new Error("The captured location is invalid. Try again.");
  }

  const label =
    cleanText(input.label, MAX_LABEL_LENGTH) ||
    defaultLabelForCategory(input.category);
  const entry: SavedLocation = {
    id: generateId(input.category),
    category: input.category,
    label,
    latitude: input.latitude,
    longitude: input.longitude,
    address: cleanText(input.address, MAX_ADDRESS_LENGTH),
    savedAt: new Date().toISOString(),
  };

  let duplicateLocation: SavedLocation | null = null;

  const locations = await mutateSavedLocations({
    context: params.context,
    source: "one_location_saved_place_confirm",
    mutate: (existing) => {
      const duplicate = findDuplicateSavedLocation(existing, entry);
      duplicateLocation = duplicate;
      if (duplicate) {
        return existing;
      }
      if (input.category === "home" || input.category === "work") {
        return [
          entry,
          ...existing.filter(
            (location) => location.category !== input.category,
          ),
        ];
      }
      return [...existing, entry];
    },
  });
  if (duplicateLocation) {
    throw new DuplicateSavedLocationError(duplicateLocation);
  }
  return locations;
}

/**
 * Update an existing saved place in place — its category, label, address, and
 * (optionally) its pinned coordinate. Home and Work stay singletons, and the
 * duplicate check excludes the entry being edited so re-saving the same place
 * does not falsely trip the "already saved" guard. Used by the Settings edit
 * flow so a place can be added OR updated with the same pin + details screens.
 */
export async function updateSavedLocation(params: {
  context: SavedLocationVaultContext;
  id: string;
  input: {
    category: SavedLocationCategory;
    label?: string | null;
    latitude: number;
    longitude: number;
    address?: string | null;
  };
}): Promise<SavedLocation[]> {
  const { id, input } = params;
  if (!id) {
    throw new Error("This saved place could not be identified.");
  }
  if (
    !Number.isFinite(input.latitude) ||
    input.latitude < -90 ||
    input.latitude > 90 ||
    !Number.isFinite(input.longitude) ||
    input.longitude < -180 ||
    input.longitude > 180
  ) {
    throw new Error("The captured location is invalid. Try again.");
  }

  const label =
    cleanText(input.label, MAX_LABEL_LENGTH) ||
    defaultLabelForCategory(input.category);
  // Home/Work use fixed ids; keep the existing id for "other" so identity and
  // ordering are preserved across an edit.
  const nextId =
    input.category === "home" || input.category === "work"
      ? input.category
      : id;
  const entry: SavedLocation = {
    id: nextId,
    category: input.category,
    label,
    latitude: input.latitude,
    longitude: input.longitude,
    address: cleanText(input.address, MAX_ADDRESS_LENGTH),
    savedAt: new Date().toISOString(),
  };

  let duplicateLocation: SavedLocation | null = null;

  const locations = await mutateSavedLocations({
    context: params.context,
    source: "one_location_saved_place_edit_confirm",
    mutate: (existing) => {
      // Drop the entry being edited (by its old id and its new id) so the
      // duplicate check below never matches the place against itself.
      const withoutSelf = existing.filter(
        (location) => location.id !== id && location.id !== nextId,
      );
      const duplicate = findDuplicateSavedLocation(withoutSelf, entry);
      duplicateLocation = duplicate;
      if (duplicate) {
        return existing;
      }
      if (input.category === "home" || input.category === "work") {
        return [
          entry,
          ...withoutSelf.filter(
            (location) => location.category !== input.category,
          ),
        ];
      }
      return [...withoutSelf, entry];
    },
  });
  if (duplicateLocation) {
    throw new DuplicateSavedLocationError(duplicateLocation);
  }
  return locations;
}

/** Remove a saved place from encrypted PKM. */
export async function removeSavedLocation(params: {
  context: SavedLocationVaultContext;
  id: string;
}): Promise<SavedLocation[]> {

  return mutateSavedLocations({
    context: params.context,
    source: "one_location_saved_place_remove_confirm",
    mutate: (existing) =>
      existing.filter((location) => location.id !== params.id),
  });
}

/** Fill or replace a friendly address without changing the saved point. */
export async function updateSavedLocationAddress(params: {
  context: SavedLocationVaultContext;
  id: string;
  address: string;
}): Promise<SavedLocation[]> {
  const address = cleanText(params.address, MAX_ADDRESS_LENGTH);
  if (!params.id || !address) return loadSavedLocations(params.context);
  return mutateSavedLocations({
    context: params.context,
    source: "one_location_saved_place_address_repair",
    mutate: (existing) =>
      existing.map((location) =>
        location.id === params.id ? { ...location, address } : location,
      ),
  });
}

/** Order for display: Home first, then Work, then Others by most recent. */
export function sortSavedLocationsForDisplay(
  locations: SavedLocation[],
): SavedLocation[] {
  const weight = (category: SavedLocationCategory): number => {
    if (category === "home") return 0;
    if (category === "work") return 1;
    return 2;
  };
  return [...locations].sort((a, b) => {
    const byCategory = weight(a.category) - weight(b.category);
    if (byCategory !== 0) return byCategory;
    return (b.savedAt || "").localeCompare(a.savedAt || "");
  });
}

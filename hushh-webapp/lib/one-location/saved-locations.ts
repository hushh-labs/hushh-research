/**
 * Saved Locations — lightweight, per-user personal knowledge (PKM) store for the
 * places a user tells us matter to them (Home / Work / Other). Captured once,
 * with consent, during Location onboarding right after they grant access, and
 * surfaced later under Settings → Saved Locations.
 *
 * Storage is device-local (localStorage), keyed by userId, mirroring the
 * existing `drive-recents.ts` pattern. This keeps the flow offline-safe and adds
 * no backend, crypto, or consent surface. Coordinates + an optional
 * human-readable address are stored so Settings can show a friendly label.
 */

export type SavedLocationCategory = "home" | "work" | "other";

export type SavedLocation = {
  /** Stable id (category for home/work; generated for "other"). */
  id: string;
  category: SavedLocationCategory;
  /** Display label, e.g. "Home", "Work", or a user-typed name for "other". */
  label: string;
  latitude: number;
  longitude: number;
  /** Optional reverse-geocoded address for display. */
  address?: string | null;
  /** ISO timestamp of when it was saved. */
  savedAt: string;
};

const STORAGE_VERSION = "v1";

function storageKey(userId: string): string {
  return `hushh.one-location.saved-locations.${STORAGE_VERSION}.${userId}`;
}

function readStore(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isValidLocation(value: unknown): value is SavedLocation {
  if (!value || typeof value !== "object") return false;
  const loc = value as Record<string, unknown>;
  return (
    typeof loc.id === "string" &&
    (loc.category === "home" ||
      loc.category === "work" ||
      loc.category === "other") &&
    typeof loc.label === "string" &&
    typeof loc.latitude === "number" &&
    Number.isFinite(loc.latitude) &&
    typeof loc.longitude === "number" &&
    Number.isFinite(loc.longitude) &&
    typeof loc.savedAt === "string"
  );
}

/** Default display label for a category. */
export function defaultLabelForCategory(category: SavedLocationCategory): string {
  if (category === "home") return "Home";
  if (category === "work") return "Work";
  return "Other";
}

/** Load all saved locations for a user (newest-relevant order: home, work, others). */
export async function loadSavedLocations(
  userId: string,
): Promise<SavedLocation[]> {
  const store = readStore();
  if (!store || !userId) return [];
  try {
    const raw = store.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidLocation);
  } catch {
    return [];
  }
}

function persist(userId: string, locations: SavedLocation[]): void {
  const store = readStore();
  if (!store || !userId) return;
  try {
    store.setItem(storageKey(userId), JSON.stringify(locations));
  } catch {
    // best-effort; saved locations are non-critical convenience data
  }
}

function generateId(category: SavedLocationCategory): string {
  if (category === "home" || category === "work") return category;
  const random = Math.random().toString(36).slice(2, 8);
  return `other-${Date.now().toString(36)}-${random}`;
}

/**
 * Add (or replace) a saved location. Home and Work are singletons — saving a new
 * one replaces the existing entry of that category. "Other" entries are additive
 * but de-duplicated by a near-identical coordinate + label match.
 */
export async function addSavedLocation(
  userId: string,
  input: {
    category: SavedLocationCategory;
    label?: string | null;
    latitude: number;
    longitude: number;
    address?: string | null;
  },
): Promise<SavedLocation[]> {
  const store = readStore();
  if (!store || !userId) return [];
  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude)) {
    return loadSavedLocations(userId);
  }

  const existing = await loadSavedLocations(userId);
  const label =
    String(input.label || "").trim() || defaultLabelForCategory(input.category);

  const entry: SavedLocation = {
    id: generateId(input.category),
    category: input.category,
    label,
    latitude: input.latitude,
    longitude: input.longitude,
    address: input.address ? String(input.address).trim() : null,
    savedAt: new Date().toISOString(),
  };

  let next: SavedLocation[];
  if (input.category === "home" || input.category === "work") {
    // Singleton categories: drop any prior entry of the same category.
    next = [entry, ...existing.filter((l) => l.category !== input.category)];
  } else {
    // "Other": de-dupe by coordinate proximity + same label.
    const deduped = existing.filter(
      (l) =>
        !(
          l.category === "other" &&
          l.label.trim().toLowerCase() === label.toLowerCase() &&
          Math.abs(l.latitude - entry.latitude) < 1e-4 &&
          Math.abs(l.longitude - entry.longitude) < 1e-4
        ),
    );
    next = [...deduped, entry];
  }

  persist(userId, next);
  return next;
}

/** Remove a saved location by id. Returns the updated list. */
export async function removeSavedLocation(
  userId: string,
  id: string,
): Promise<SavedLocation[]> {
  const store = readStore();
  if (!store || !userId) return [];
  const existing = await loadSavedLocations(userId);
  const next = existing.filter((l) => l.id !== id);
  persist(userId, next);
  return next;
}

/** Fill or replace the friendly address without changing the saved place. */
export async function updateSavedLocationAddress(
  userId: string,
  id: string,
  address: string,
): Promise<SavedLocation[]> {
  const store = readStore();
  const cleanAddress = String(address || "").trim();
  if (!store || !userId || !id || !cleanAddress) {
    return loadSavedLocations(userId);
  }
  const existing = await loadSavedLocations(userId);
  const next = existing.map((location) =>
    location.id === id ? { ...location, address: cleanAddress } : location,
  );
  persist(userId, next);
  return next;
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

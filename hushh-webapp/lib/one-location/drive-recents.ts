import type { DriveDestination } from "@/lib/one-location/types";

const MAX_RECENTS = 5;

function storageKey(userId: string): string {
  return `hushh.one-location.drive-recents.${userId}`;
}

function keyOf(destination: DriveDestination): string {
  return (destination.placeId || destination.label || "").trim().toLowerCase();
}

function readStore(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export async function loadRecentDestinations(
  userId: string,
): Promise<DriveDestination[]> {
  const store = readStore();
  if (!store || !userId) return [];
  try {
    const raw = store.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DriveDestination[];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

export async function addRecentDestination(
  userId: string,
  destination: DriveDestination,
): Promise<void> {
  const store = readStore();
  if (!store || !userId) return;
  const existing = await loadRecentDestinations(userId);
  const deduped = existing.filter((item) => keyOf(item) !== keyOf(destination));
  const next = [destination, ...deduped].slice(0, MAX_RECENTS);
  try {
    store.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    // best-effort; recents are non-critical
  }
}

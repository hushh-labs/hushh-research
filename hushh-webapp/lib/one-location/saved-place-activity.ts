import { splitCheckInPlaceLabel } from "@/lib/one-location/check-in-place-label";
import { recordLiveActivity, type LiveActivityOrigin } from "@/lib/pkm/live-activity/live-activity-journal";

type SavedPlaceIdentity = Readonly<{ id: string; label: string; category?: string; address?: string | null; addressBase?: string | null }>;

const CATEGORY_LABELS: Readonly<Record<string, string>> = { home: "Home", work: "Work" };
const fold = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}]+/gu, " ").trim();

/**
 * A name with a number that is just the start of one of the place's own
 * addresses ("742 Evergreen Terrace", "Flat 4B, Sunshine Society") is a street
 * or flat address, not a name. A premise name an address merely opens with
 * ("Phoenix Marketcity, Viman Nagar") stays. Best effort: a place with no
 * stored address has nothing to compare against. A prefix, not containment,
 * so "Park" survives.
 */
function repeatsPlaceAddress(name: string, addresses: readonly (string | null | undefined)[]): boolean {
  const folded = fold(name);
  if (!/\p{N}/u.test(folded)) return false;
  return addresses.some((address) => Boolean(address) && fold(address as string).startsWith(folded));
}

/**
 * The owner's name for the place; a combined "name, address" label keeps only
 * the name, and a name that repeats the place's composed or bare street
 * address (saved from a check-in, or typed as the name) is left out.
 */
function placeLabel(place: SavedPlaceIdentity): string | null {
  const category = place.category ? CATEGORY_LABELS[place.category] : undefined;
  if (category) return category;
  const name = splitCheckInPlaceLabel(place.label).name;
  if (!fold(name)) return null;
  return repeatsPlaceAddress(name, [place.address, place.addressBase]) ? null : name;
}

/** A venue's public name for a check-in, unless it only repeats the venue's own street address. */
export function venueActivityLabel(name: string | null | undefined, address: string | null | undefined): string | null {
  return name && fold(name) && !repeatsPlaceAddress(name, [address]) ? name : null;
}

/**
 * Journal one committed saved-places write. A write that adds places is a
 * save (replacing Home or Work is part of that save); otherwise every place
 * that left the list was removed. Edits are never passed here, so a category
 * change, which replaces Home or Work under a new id, is not journaled.
 */
export function recordSavedPlaceChanges(
  previous: readonly SavedPlaceIdentity[],
  next: readonly SavedPlaceIdentity[],
  origin: LiveActivityOrigin,
): void {
  const before = new Set(previous.map((place) => place.id));
  const added = next.filter((place) => !before.has(place.id));
  if (added.length > 0) {
    for (const place of added) recordLiveActivity({ kind: "place_saved", label: placeLabel(place) }, origin);
    return;
  }
  const after = new Set(next.map((place) => place.id));
  for (const place of previous) {
    if (!after.has(place.id)) recordLiveActivity({ kind: "place_removed", label: placeLabel(place) }, origin);
  }
}

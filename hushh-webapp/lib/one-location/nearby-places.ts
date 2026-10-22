export type OneLocationNearbyPlaceCategory =
  | "all"
  | "food_drink"
  | "cafes"
  | "health"
  | "shopping_services"
  | "hotels_stays"
  | "other_stays"
  | "education"
  | "outdoors_landmarks"
  | "transit"
  | "worship"
  | "civic"
  // The catch-all. A real venue that belongs to none of the above, plus every
  // venue Google names but does not describe -- so a row is never reachable
  // from "All" alone.
  | "other";

export type OneLocationNearbyPlaceSuggestion = {
  placeId: string;
  /** Compatibility label used by autocomplete and older provider responses. */
  text: string;
  name?: string | null;
  address?: string | null;
  primaryType?: string | null;
  category?: string | null;
  /** Present for strict nearby results; generic autocomplete does not return it. */
  distanceMeters?: number | null;
  /**
   * The venue's public point. Present on nearby results so the map can pin the
   * place the owner is choosing separately from where they are standing.
   * Autocomplete does not return it; the sheet resolves it on selection.
   */
  latitude?: number | null;
  longitude?: number | null;
  /**
   * Category chips this place belongs to. Lets the drawer filter the merged
   * nearby sweep locally instead of re-querying per chip and re-truncating.
   */
  categories?: OneLocationNearbyPlaceCategory[] | null;
};

export type OneLocationNearbyPlacesRequest = {
  vaultOwnerToken: string;
  lat: number;
  lng: number;
  category?: OneLocationNearbyPlaceCategory;
};

export type OneLocationNearbyPlacesResult = OneLocationNearbyPlaceSuggestion[] & {
  discoveryIncomplete?: boolean;
};

export type NearbyPlacesResponse = {
  suggestions?: OneLocationNearbyPlaceSuggestion[];
  discoveryIncomplete?: boolean;
};

export function normalizeNearbyPlaceResponse(response: NearbyPlacesResponse): OneLocationNearbyPlacesResult {
  return Object.assign([...(response.suggestions ?? [])], {
    discoveryIncomplete: response.discoveryIncomplete === true,
  });
}

/**
 * Chip labels only. The `value` on each row is the backend category and is
 * untouched — a chip narrows the already-loaded sweep locally, so nothing here
 * reaches a server.
 *
 * Short labels keep every category reachable in the phone's horizontal scroller.
 */
export const PLACE_CATEGORIES: Array<{
  value: OneLocationNearbyPlaceCategory;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "food_drink", label: "Food" },
  { value: "cafes", label: "Café" },
  { value: "health", label: "Health" },
  { value: "shopping_services", label: "Shops" },
  { value: "hotels_stays", label: "Hotels" },
  { value: "other_stays", label: "Stays" },
  { value: "education", label: "Education" },
  // "Leisure", not "Outdoors": this chip owns cinemas, nightclubs, museums,
  // stadiums and event venues as well as parks, and half of those are indoors.
  { value: "outdoors_landmarks", label: "Leisure" },
  { value: "transit", label: "Transit" },
  // Reachable for the first time. A temple, a mosque, a police station and a
  // government office matched no category at all, so they showed under "All"
  // and disappeared the moment any chip was tapped -- in a pilgrimage city, a
  // bigger hole than the one that was reported.
  { value: "worship", label: "Worship" },
  { value: "civic", label: "Civic" },
  // Last, and never empty by construction. Anything the taxonomy cannot place
  // lands here rather than nowhere, which is what makes "no place is skipped" a
  // property of the list rather than a hope.
  { value: "other", label: "More" },
];

export const NEARBY_RADIUS_METERS = 500;

export function normalizeAutomaticPlaces(
  suggestions: OneLocationNearbyPlaceSuggestion[],
): OneLocationNearbyPlaceSuggestion[] {
  const seen = new Set<string>();
  return suggestions
    .filter((place) => {
      if (!place.placeId || seen.has(place.placeId)) return false;
      if (
        typeof place.distanceMeters !== "number" ||
        !Number.isFinite(place.distanceMeters) ||
        place.distanceMeters < 0 ||
        place.distanceMeters > NEARBY_RADIUS_METERS
      ) {
        return false;
      }
      seen.add(place.placeId);
      return true;
    })
    .sort((left, right) => {
      const distance =
        Number(left.distanceMeters) - Number(right.distanceMeters);
      if (distance !== 0) return distance;
      return (left.name || left.text).localeCompare(right.name || right.text);
    });
}

/**
 * Narrow the merged sweep to one chip locally.
 *
 * The backend returns every category in one pass, so filtering here keeps the
 * full set intact. Re-querying per chip used to re-apply the provider's
 * 20-result cap, which is how a second hotel behind the first could vanish when
 * the owner tapped "Hotels".
 */
export function placesInCategory(
  places: OneLocationNearbyPlaceSuggestion[],
  category: OneLocationNearbyPlaceCategory,
): OneLocationNearbyPlaceSuggestion[] {
  if (category === "all") return places;
  return places.filter((place) =>
    // A row with no categories at all belongs to "More". The backend classifies
    // exhaustively and never sends an empty list, but a response cached before
    // that shipped still can -- and a row that answers no chip is a row the
    // person can see under "All" and then never find again.
    (place.categories?.length ? place.categories : ["other"]).includes(
      category,
    ),
  );
}


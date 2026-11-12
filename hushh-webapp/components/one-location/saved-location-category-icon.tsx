"use client";

import {
  Bank, Bed, Briefcase, Buildings, Church, Coffee, FirstAid,
  ForkKnife, GraduationCap, House, MapPin, ShoppingBag, Train, Tree,
  type Icon,
} from "@phosphor-icons/react";
import type { SavedLocation } from "@/lib/one-location/saved-locations";
import { normalizeCheckedInPlaceCategory, type CheckedInPlaceCategory } from "@/lib/one-location/nearby-places";
import { cn } from "@/lib/utils";

type CategoryPresentation = { Icon: Icon; background: string; symbol: string; color: string };

const CHECK_IN_CATEGORIES: Record<CheckedInPlaceCategory, CategoryPresentation> = {
  food_drink: { Icon: ForkKnife, background: "var(--app-warning)", symbol: "fork.knife", color: "#ff9500" },
  cafes: { Icon: Coffee, background: "#a2845e", symbol: "cup.and.saucer", color: "#a2845e" },
  health: { Icon: FirstAid, background: "var(--app-destructive)", symbol: "cross.case", color: "#ff3b30" },
  shopping_services: { Icon: ShoppingBag, background: "var(--app-warning)", symbol: "bag", color: "#ff9500" },
  hotels_stays: { Icon: Bed, background: "#af52de", symbol: "bed.double", color: "#af52de" },
  other_stays: { Icon: Buildings, background: "#5856d6", symbol: "building.2", color: "#5856d6" },
  education: { Icon: GraduationCap, background: "var(--app-accent)", symbol: "graduationcap", color: "#007aff" },
  outdoors_landmarks: { Icon: Tree, background: "var(--app-success)", symbol: "tree", color: "#34c759" },
  transit: { Icon: Train, background: "var(--app-accent)", symbol: "tram", color: "#007aff" },
  worship: { Icon: Church, background: "#af52de", symbol: "building.columns", color: "#af52de" },
  civic: { Icon: Bank, background: "#636366", symbol: "building.columns", color: "#636366" },
  other: { Icon: MapPin, background: "var(--app-accent)", symbol: "mappin", color: "#007aff" },
};

export function savedLocationCategoryPresentation(location: Pick<SavedLocation, "category" | "placeCategory" | "savedFrom">) {
  if (location.category === "home") {
    return { Icon: House, background: "var(--app-accent)", symbol: "house", color: "#007aff" };
  }
  if (location.category === "work") {
    return { Icon: Briefcase, background: "var(--app-warning)", symbol: "briefcase", color: "#ff9500" };
  }
  const placeCategory = normalizeCheckedInPlaceCategory(location.placeCategory);
  if (placeCategory || location.savedFrom === "check_in") return CHECK_IN_CATEGORIES[placeCategory ?? "other"];
  return { Icon: MapPin, background: "transparent", symbol: "mappin", color: "#007aff" };
}

export function SavedLocationCategoryIcon({ location }: { location: Pick<SavedLocation, "category" | "placeCategory" | "savedFrom"> }) {
  const { Icon, background } = savedLocationCategoryPresentation(location);
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]",
        background === "transparent" ? "text-[color:var(--app-accent-deep)]" : "text-white",
      )}
      style={{ backgroundColor: background }}
      data-testid={`saved-location-icon-${location.category}`}
      data-place-category={normalizeCheckedInPlaceCategory(location.placeCategory) ?? undefined}
      aria-hidden="true"
    >
      <Icon className="h-4 w-4" weight="regular" aria-hidden="true" />
    </span>
  );
}

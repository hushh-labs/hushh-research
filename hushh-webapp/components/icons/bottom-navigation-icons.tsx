"use client";

import { type ComponentType } from "react";
import definitions from "./bottom-navigation-icons.json";
import {
  MessageCircle, Grid2x2, Compass, Newspaper, Search,
  type CanonicalIconProps,
} from "./legacy-ui-icons";

// Presentation only. Routes, order and actions remain in app-bottom-nav.ts.
export type BottomNavigationIconKey = keyof typeof definitions;
const glyphs: Record<string, ComponentType<CanonicalIconProps>> = {
  ChatCircle: MessageCircle, SquaresFour: Grid2x2, Compass, Newspaper,
  MagnifyingGlass: Search,
};

function variant(glyph: string, weight: string): ComponentType<CanonicalIconProps> {
  const Glyph = glyphs[glyph];
  if (!Glyph || (weight !== "duotone" && weight !== "regular" && weight !== "fill")) {
    throw new Error("Invalid bottom navigation icon definition");
  }
  const AdmittedGlyph = Glyph;
  const admittedWeight: CanonicalIconProps["weight"] = weight;
  function NavigationIcon(props: CanonicalIconProps) {
    return <AdmittedGlyph {...props} weight={admittedWeight} />;
  }
  return NavigationIcon;
}

export const BOTTOM_NAVIGATION_ICONS = Object.fromEntries(
  Object.entries(definitions).map(([key, definition]) => [key, {
    icon: variant(definition.glyph, definition.weight),
    activeIcon: variant(definition.glyph, definition.selectedWeight),
  }]),
) as Record<BottomNavigationIconKey, {
  icon: ComponentType<CanonicalIconProps>;
  activeIcon?: ComponentType<CanonicalIconProps>;
}>;

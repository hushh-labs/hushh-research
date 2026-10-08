import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Phosphor from "@phosphor-icons/react/ssr";

// Node-only projection used by the existing asset generator, never a runtime
// download or a second glyph source. Keep official paths and the full viewBox.
export function renderNavigationArtwork({ glyph, weight, selectedWeight }, selected) {
  const Icon = Phosphor[glyph];
  const variant = selected ? selectedWeight : weight;
  if (!Icon || !["duotone", "regular", "fill"].includes(variant)) {
    throw new Error("Invalid bottom navigation icon definition");
  }
  return renderToStaticMarkup(createElement(Icon, {
    weight: variant, color: "#000000", size: 256,
  }));
}

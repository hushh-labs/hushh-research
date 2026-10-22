import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLACE_CATEGORIES } from "@/lib/one-location/nearby-places";

/**
 * The chip row, and the two ways it can quietly stop being true.
 *
 * Reported from Prayagraj: tapping "Hotels" listed a lounge, a construction firm
 * and two lodges. Most of that fix is server-side, but two client properties
 * decide whether it is visible at all.
 */
describe("the nearby place chips", () => {
  const layoutSpecSource = readFileSync(
    path.resolve(
      __dirname,
      "../../../..",
      "e2e/one-location-check-in-panel.layout.spec.ts",
    ),
    "utf8",
  );

  /** The labels the component actually ships, read out of its own table. */
  function shippedLabels(): string[] {
    return PLACE_CATEGORIES.map(category => category.label);
  }

  it("offers a chip for every category the backend can return", () => {
    // The backend classifies exhaustively over Google's Table A and can answer
    // with any of these. A category with no chip is a set of places that shows
    // under "All" and is unreachable the moment anything is tapped — which is
    // how temples, mosques and police stations were invisible.
    const values = PLACE_CATEGORIES.map(category => category.value);
    expect(values).toEqual([
      "all",
      "food_drink",
      "cafes",
      "health",
      "shopping_services",
      "hotels_stays",
      "other_stays",
      "education",
      "outdoors_landmarks",
      "transit",
      "worship",
      "civic",
      "other",
    ]);
  });

  it("keeps the layout spec's replica of the labels honest", () => {
    // `one-location-check-in-panel.layout.spec.ts` cannot import a React module,
    // so it hand-copies these labels to measure the row. A copy that falls
    // behind does not fail — it passes, having measured a row the app no longer
    // ships. This is the only thing that notices.
    const replica = layoutSpecSource.slice(
      layoutSpecSource.indexOf("const CATEGORY_LABELS"),
      layoutSpecSource.indexOf("const LONGEST_PLACE"),
    );
    const replicated = [...replica.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(replicated).toEqual(shippedLabels());
  });

  it("never says 'Outdoors' about a cinema", () => {
    // The chip owns entertainment, culture, sport and nature. Half of that is
    // indoors, so the label says what the chip is for rather than where it is.
    expect(shippedLabels()).toContain("Leisure");
    expect(shippedLabels()).not.toContain("Outdoors");
  });
});

import { describe, expect, it } from "vitest";

import {
  buildSavedLocationAddress,
  type SavedLocationAddressDetails,
} from "@/lib/one-location/saved-location-address";

/**
 * Editing a saved place and saving it again.
 *
 * The saved `address` is a single composed line, so the only question that
 * matters on a re-save is which string the entrance details get folded into.
 * Fold them into the previous *result* and they end up in front of themselves,
 * a little further every time. Fold them into the *base* -- the street address
 * on its own, which is why it is now stored -- and the second save produces
 * exactly what the first one did.
 */

const BASE = "Kartavya Path, New Delhi, Delhi";

const DETAILS: SavedLocationAddressDetails = {
  houseOrFlat: "Flat 4B, Tower 2",
  buildingColor: "Blue gate",
  landmark: "Opposite City Mall",
  postalCode: "110001",
};

describe("re-saving an edited place", () => {
  it("produces the same line every time when composed from the base", () => {
    const first = buildSavedLocationAddress(BASE, DETAILS);
    const second = buildSavedLocationAddress(BASE, DETAILS);
    const third = buildSavedLocationAddress(BASE, DETAILS);

    expect(second).toBe(first);
    expect(third).toBe(first);
    // No "building" or "Near" prefix here: the helpers only add those when
    // the text does not already carry the word ("gate", "Opposite").
    expect(first).toBe(
      "Flat 4B, Tower 2, Blue gate, Opposite City Mall, Kartavya Path, New Delhi, Delhi, 110001",
    );
  });

  it("grows without bound when composed from its own output", () => {
    // The old behaviour, kept as a test so the regression is named rather than
    // merely avoided. The edit flow passed the previously COMPOSED address as
    // the base, so each save prepended the entrance details again.
    const first = buildSavedLocationAddress(BASE, DETAILS) ?? "";
    const second = buildSavedLocationAddress(first, {
      ...DETAILS,
      houseOrFlat: "Flat 5C",
    });

    expect(second).toContain("Flat 5C");
    expect(second).toContain("Flat 4B, Tower 2");
    expect((second ?? "").length).toBeGreaterThan(first.length);
  });

  it("changes only what the person changed", () => {
    const before = buildSavedLocationAddress(BASE, DETAILS);
    const after = buildSavedLocationAddress(BASE, {
      ...DETAILS,
      houseOrFlat: "Flat 5C",
    });

    expect(after).toBe(
      "Flat 5C, Blue gate, Opposite City Mall, Kartavya Path, New Delhi, Delhi, 110001",
    );
    expect(after).not.toBe(before);
    expect(after).not.toContain("Flat 4B");
  });

  it("carries a corrected address line straight through", () => {
    // What the Address field is for: the pin resolved to the wrong side of the
    // building, and the person typed the right one over it.
    const corrected = buildSavedLocationAddress(
      "Gate 3, Rear entrance, New Delhi",
      DETAILS,
    );

    expect(corrected).toContain("Gate 3, Rear entrance, New Delhi");
    expect(corrected).not.toContain("Kartavya Path");
  });

  it("still saves something usable when only the address is given", () => {
    // House, flat and postal code no longer block a save, so composing with
    // empty details has to produce the address rather than nothing.
    expect(
      buildSavedLocationAddress(BASE, {
        houseOrFlat: "",
        buildingColor: "",
        landmark: "",
        postalCode: "",
      }),
    ).toBe(BASE);
  });
});

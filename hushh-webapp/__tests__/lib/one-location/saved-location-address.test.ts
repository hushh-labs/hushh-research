import { describe, expect, it } from "vitest";

import {
  buildSavedLocationAddress,
  inferPostalCode,
  isValidPostalCode,
  normalizeSavedLocationAddressDetails,
} from "@/lib/one-location/saved-location-address";

describe("saved location address helpers", () => {
  it("infers common Indian and US postal-code shapes", () => {
    expect(inferPostalCode("New Delhi, Delhi 110001, India")).toBe("110001");
    expect(inferPostalCode("Seattle, WA 98101-1234, USA")).toBe("98101-1234");
    expect(inferPostalCode("Address without a postal code")).toBe("");
  });

  it("accepts global alphanumeric postal codes and rejects unsafe shapes", () => {
    expect(isValidPostalCode("560001")).toBe(true);
    expect(isValidPostalCode("SW1A 1AA")).toBe(true);
    expect(isValidPostalCode("98101-1234")).toBe(true);
    expect(isValidPostalCode("!")).toBe(false);
    expect(isValidPostalCode("12")).toBe(false);
  });

  it("normalizes owner-entered details before persistence", () => {
    expect(
      normalizeSavedLocationAddressDetails({
        houseOrFlat: "  Flat   4B  ",
        buildingColor: "  Blue   gate ",
        landmark: " Opposite   City Mall ",
        postalCode: " 110001 ",
      }),
    ).toEqual({
      houseOrFlat: "Flat 4B",
      buildingColor: "Blue gate",
      landmark: "Opposite City Mall",
      postalCode: "110001",
    });
  });

  it("composes details into the encrypted address without repeating postal code", () => {
    expect(
      buildSavedLocationAddress(
        "Kartavya Path, New Delhi, Delhi 110001, India",
        {
          houseOrFlat: "Flat 4B, Tower 2",
          buildingColor: "Blue",
          landmark: "City Mall",
          postalCode: "110001",
        },
      ),
    ).toBe(
      "Flat 4B, Tower 2, Blue building, Near City Mall, Kartavya Path, New Delhi, Delhi 110001, India",
    );
  });

  it("returns null instead of persisting an empty address", () => {
    expect(
      buildSavedLocationAddress(null, {
        houseOrFlat: "",
        buildingColor: "",
        landmark: "",
        postalCode: "",
      }),
    ).toBeNull();
  });

  it("keeps the required entrance and postal code within the address limit", () => {
    const address = buildSavedLocationAddress("A".repeat(300), {
      houseOrFlat: "Flat 4B, Tower 2",
      buildingColor: "Blue gate",
      landmark: "Opposite a very long landmark near the main road",
      postalCode: "110001",
    });

    expect(address).toHaveLength(300);
    expect(address).toMatch(/^Flat 4B, Tower 2/);
    expect(address).toMatch(/, 110001$/);
  });
});

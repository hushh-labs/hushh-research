import { describe, expect, it } from "vitest";

import {
  inferHouseOrFlat,
  inferSavedLocationAddressDetails,
} from "@/lib/one-location/saved-location-address";

/**
 * Splitting a detected address across the form's own fields.
 *
 * The bar for prefilling is higher than for leaving a field empty: people
 * trust a filled field and stop reading it, so a wrong guess here ships a
 * wrong address. Every test below that expects "" is the function declining
 * to guess.
 */

describe("pulling a house number out of a detected address", () => {
  it("takes a compact house or plot designator", () => {
    expect(
      inferHouseOrFlat("B-284/3, Rd Number 1, New Delhi, Delhi 110074, India"),
    ).toBe("B-284/3");
    expect(inferHouseOrFlat("42, Baker Street, London")).toBe("42");
    expect(inferHouseOrFlat("A-12, Sector 5, Noida")).toBe("A-12");
  });

  it("takes a segment that names itself, spaces and all", () => {
    expect(inferHouseOrFlat("Flat 4B, Tower 2, Bengaluru")).toBe("Flat 4B");
    expect(inferHouseOrFlat("Plot 22, Industrial Area, Pune")).toBe("Plot 22");
    expect(inferHouseOrFlat("No. 7, Church Street, Bengaluru")).toBe("No. 7");
  });

  it("declines a street that merely carries a number", () => {
    // "12 MG Road" is where the building is, not which door is yours. Putting
    // it in House-flat would be confidently wrong.
    expect(inferHouseOrFlat("12 MG Road, Bengaluru, Karnataka 560001")).toBe("");
    expect(inferHouseOrFlat("1600 Pennsylvania Avenue NW, Washington")).toBe("");
  });

  it("declines a first segment with no number in it at all", () => {
    expect(inferHouseOrFlat("Kartavya Path, New Delhi, Delhi 110001")).toBe("");
    expect(inferHouseOrFlat("Hushh Office, Bengaluru, Karnataka, India")).toBe(
      "",
    );
  });

  it("declines nothing, empties, and a segment too long to be a door", () => {
    expect(inferHouseOrFlat(null)).toBe("");
    expect(inferHouseOrFlat(undefined)).toBe("");
    expect(inferHouseOrFlat("")).toBe("");
    expect(inferHouseOrFlat(`${"x".repeat(90)}1`)).toBe("");
  });
});

describe("what a detected address can fill on its own", () => {
  it("answers house number and postal code together", () => {
    expect(
      inferSavedLocationAddressDetails(
        "B-284/3, Rd Number 1, Chhatarpur, New Delhi, Delhi 110074, India",
      ),
    ).toEqual({ houseOrFlat: "B-284/3", postalCode: "110074" });
  });

  it("answers only what is there", () => {
    // Building colour and landmark are never inferred: an address does not
    // carry them, and only the person standing there knows.
    expect(
      inferSavedLocationAddressDetails("Kartavya Path, New Delhi, Delhi 110001"),
    ).toEqual({ houseOrFlat: "", postalCode: "110001" });
    expect(inferSavedLocationAddressDetails("Somewhere, Nowhere")).toEqual({
      houseOrFlat: "",
      postalCode: "",
    });
  });
});

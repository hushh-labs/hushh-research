import { describe, expect, it } from "vitest";

import {
  buildSavedLocationAddress,
  EMPTY_SAVED_LOCATION_ADDRESS_DETAILS,
  inferHouseOrFlat,
  inferPostalCode,
  inferSavedLocationAddressDetails,
  isPlusCode,
  stripPlusCodeSegment,
} from "@/lib/one-location/saved-location-address";

/**
 * Every case below is a way the entrance form could be prefilled with the
 * wrong thing, or with nothing, on an address that plainly carried the
 * answer. The reported symptom was always the same sentence -- "the address
 * is not populating" -- so they are grouped by what actually went wrong.
 */
describe("prefilling the entrance form from a detected address", () => {
  describe("plus codes are coordinates, not addresses", () => {
    it("recognises short and full Open Location Codes", () => {
      expect(isPlusCode("FVJ7+JR2")).toBe(true);
      expect(isPlusCode("7JVW52GR+2V")).toBe(true);
      expect(isPlusCode("  fvj7+jr2 ")).toBe(true);
      expect(isPlusCode("B-284/3")).toBe(false);
      expect(isPlusCode("Flat 4B")).toBe(false);
      expect(isPlusCode("")).toBe(false);
    });

    it("never offers a plus code as a house number", () => {
      // It has no spaces and it carries digits, so the old shape rule took it
      // and wrote a coordinate into "House, flat, floor or block".
      expect(
        inferHouseOrFlat(
          "FVJ7+JR2, Teliarganj, Prayagraj, Uttar Pradesh 211004, India",
        ),
      ).toBe("");
      expect(
        inferSavedLocationAddressDetails(
          "FVJ7+JR2, Teliarganj, Prayagraj, Uttar Pradesh 211004, India",
        ),
      ).toEqual({ houseOrFlat: "", postalCode: "211004" });
    });

    it("drops the plus code from the line that is shown and saved", () => {
      expect(
        stripPlusCodeSegment(
          "FVJ7+JR2, Teliarganj, Prayagraj, Uttar Pradesh 211004, India",
        ),
      ).toBe("Teliarganj, Prayagraj, Uttar Pradesh 211004, India");
      expect(
        buildSavedLocationAddress(
          "FVJ7+JR2, Teliarganj, Prayagraj, Uttar Pradesh 211004, India",
          EMPTY_SAVED_LOCATION_ADDRESS_DETAILS,
        ),
      ).toBe("Teliarganj, Prayagraj, Uttar Pradesh 211004, India");
    });

    it("keeps a plus code that is the only thing Google returned", () => {
      // A coordinate in disguise still beats a blank line.
      expect(stripPlusCodeSegment("FVJ7+JR2")).toBe("FVJ7+JR2");
    });

    it("still finds the house number hiding behind a plus code", () => {
      expect(
        inferSavedLocationAddressDetails(
          "FVJ7+JR2, Qtr. No.- 123/2, Saraswati Vihar, Prayagraj 211004, India",
        ),
      ).toEqual({ houseOrFlat: "Qtr. No.- 123/2", postalCode: "211004" });
    });

    it("leaves an ordinary address untouched", () => {
      const address = "B-284/3, Rd Number 1, New Delhi, Delhi 110074, India";
      expect(stripPlusCodeSegment(address)).toBe(address);
      expect(stripPlusCodeSegment(null)).toBeNull();
      expect(stripPlusCodeSegment("   ")).toBeNull();
    });
  });

  describe("house designators people actually write", () => {
    it("reads the Indian forms the old rule threw away", () => {
      // Each of these has a space, so the old rule required the segment to
      // name itself -- and it only knew flat/plot/house/apt/no/#/door/shop/
      // unit/block. "Qtr. No.- 123/2" is a real address off a real pin.
      expect(inferHouseOrFlat("Qtr. No.- 123/2, Old Cantt, Prayagraj")).toBe(
        "Qtr. No.- 123/2",
      );
      expect(inferHouseOrFlat("H. No. 45, Sector 12, Noida")).toBe(
        "H. No. 45",
      );
      expect(inferHouseOrFlat("D No 12-3-45, Vijayawada")).toBe("D No 12-3-45");
      expect(inferHouseOrFlat("Quarter 8B, Railway Colony")).toBe("Quarter 8B");
      expect(inferHouseOrFlat("Room 210, Hostel C")).toBe("Room 210");
      expect(inferHouseOrFlat("Suite 900, Market Street")).toBe("Suite 900");
    });

    it("keeps the forms that already worked", () => {
      expect(inferHouseOrFlat("B-284/3, Rd Number 1, New Delhi")).toBe(
        "B-284/3",
      );
      expect(inferHouseOrFlat("Flat 4B, Tower 2, Pune")).toBe("Flat 4B");
      expect(inferHouseOrFlat("42, Some Lane, Chennai")).toBe("42");
    });

    it("still refuses a street that merely carries a number", () => {
      // A wrong prefill is worse than an empty one: people trust prefilled
      // fields and stop reading them.
      expect(inferHouseOrFlat("12 MG Road, Bengaluru")).toBe("");
      expect(inferHouseOrFlat("Kartavya Path, New Delhi")).toBe("");
      expect(inferHouseOrFlat("Rd Number 1, Chhatarpur")).toBe("");
      expect(inferHouseOrFlat("")).toBe("");
      expect(inferHouseOrFlat(null)).toBe("");
    });
  });

  describe("postal codes outside the 5- and 6-digit world", () => {
    it("keeps finding Indian and US codes first", () => {
      expect(inferPostalCode("New Delhi, Delhi 110001, India")).toBe("110001");
      expect(inferPostalCode("Seattle, WA 98101-1234, USA")).toBe("98101-1234");
    });

    it("finds UK, Canadian and Dutch codes it used to miss", () => {
      // isValidPostalCode has always ACCEPTED these. Nothing ever detected
      // them, so anyone outside India or the US got an empty field on an
      // address that plainly carried one.
      expect(inferPostalCode("10 Downing St, London SW1A 2AA, UK")).toBe(
        "SW1A 2AA",
      );
      expect(inferPostalCode("Ottawa, ON K1A 0B1, Canada")).toBe("K1A 0B1");
      expect(inferPostalCode("Dam 1, 1012 JS Amsterdam, Netherlands")).toBe(
        "1012 JS",
      );
    });

    it("takes a bare four-digit code only from the tail of the address", () => {
      expect(inferPostalCode("12 Pitt St, Sydney NSW, 2000")).toBe("2000");
      // A road number at the head is not a postal code.
      expect(inferPostalCode("2000 Marine Drive, Mumbai, Maharashtra")).toBe(
        "",
      );
      expect(inferPostalCode("Address without a postal code")).toBe("");
      expect(inferPostalCode(null)).toBe("");
    });
  });

  describe("what the dropped address line cost", () => {
    const details = {
      houseOrFlat: "Qtr. No.- 123/2",
      buildingColor: "",
      landmark: "",
      postalCode: "211004",
    };

    it("saves the whole line when the modal's address reaches the composer", () => {
      expect(
        buildSavedLocationAddress(
          "Qtr. No.- 123/2, Saraswati Vihar, Old Cantt, Teliarganj, Prayagraj, Uttar Pradesh 211004, India",
          details,
        ),
      ).toBe(
        "Qtr. No.- 123/2, Saraswati Vihar, Old Cantt, Teliarganj, Prayagraj, Uttar Pradesh 211004, India",
      );
    });

    it("saves only fragments when it does not", () => {
      // This is what root setup persisted for every pre-vault save: the modal
      // passed the address line, the onboarding call site dropped it, and the
      // state it used instead is null until a vault token exists.
      expect(buildSavedLocationAddress(null, details)).toBe(
        "Qtr. No.- 123/2, 211004",
      );
    });
  });
});

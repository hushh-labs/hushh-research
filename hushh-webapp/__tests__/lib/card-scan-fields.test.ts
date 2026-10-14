import { describe, expect, it } from "vitest";
import { parseCardScan } from "@/lib/wallet/card-scan-fields";
describe("local card scan parsing", () => {
  it("extracts a validated number and explicit details only", () => {
    expect(parseCardScan("DEMO\n4242 4242 4242 4242\n12/30\nCARDHOLDER\nAlex Sample\n123"))
      .toEqual({ pan: "4242424242424242", expiry: "12/30", cardholderName: "Alex Sample" });
  });
  it("rejects invalid, truncated and ambiguous numbers", () => {
    for (const text of ["4242424242424243", "424242424242424200000", "4242424242424242\n5555555555554444", "no card"]) expect(parseCardScan(text)).toBeNull();
  });
  it("leaves ambiguous expiry and unlabelled names for manual entry", () => {
    expect(parseCardScan("4242424242424242\nAlex Sample\n12/30 11/29" )).toEqual({ pan: "4242424242424242" });
  });
  it("reads printed names and uses the expiry label rather than the issue date", () => {
    expect(parseCardScan("VISA\n4242 4242 4242 4242\nVALID FROM 11/24\nVALID THRU 12/30\nALEX SAMPLE"))
      .toEqual({ pan: "4242424242424242", expiry: "12/30", cardholderName: "ALEX SAMPLE" });
    expect(parseCardScan("3782 822463 10005\n12/30\nName on card: Alex Sample"))
      .toEqual({ pan: "378282246310005", expiry: "12/30", cardholderName: "Alex Sample" });
  });
  it("does not turn card marketing or ambiguous printed names into a holder", () => {
    for (const suffix of ["WORLD ELITE\nTEST BANK", "ALEX SAMPLE\nJAMIE SAMPLE"]) {
      expect(parseCardScan(`4242 4242 4242 4242\n12/30\n${suffix}`))
        .toEqual({ pan: "4242424242424242", expiry: "12/30" });
    }
  });
});

it("accepts OCR whitespace and four number groups split across lines", () => {
  expect(parseCardScan("4242  4242\t4242\u00a04242")).toEqual({ pan: "4242424242424242" });
  expect(parseCardScan("4242\n4242\n4242\n4242\n12/30")).toEqual({ pan: "4242424242424242", expiry: "12/30" });
});

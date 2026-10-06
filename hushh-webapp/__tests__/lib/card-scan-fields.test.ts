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
});

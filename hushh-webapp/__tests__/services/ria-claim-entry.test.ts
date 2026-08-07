import { describe, expect, it } from "vitest";

import {
  buildRiaClaimRoute,
  isClaimableLookupOutcome,
  toNanpDigits,
} from "@/lib/ria/ria-claim-entry";

const firm = { crd: 283040, name: "OLYMPUS PEAKS FINANCIAL, LLC" } as never;

describe("recognising an adviser from the number they typed at sign-up", () => {
  it("claims on every outcome where the SEC has something at the number", () => {
    for (const outcome of [
      "single_person",
      "few_candidates",
      "large_firm",
      "ambiguous_firm",
    ]) {
      expect(
        isClaimableLookupOutcome({ outcome, firm, firms: [] }),
        `${outcome} should route to claim`,
      ).toBe(true);
    }
  });

  it("stays out of the way when the number is not an adviser's", () => {
    // The overwhelming majority of sign-ups: normal people. They must never be
    // detoured into a claim screen.
    expect(isClaimableLookupOutcome({ outcome: "no_match", firm: null, firms: [] })).toBe(false);
    expect(isClaimableLookupOutcome({ outcome: "invalid_phone", firm: null, firms: [] })).toBe(false);
    expect(isClaimableLookupOutcome(null)).toBe(false);
  });

  it("does not route to a claim screen it cannot render", () => {
    // A claimable outcome with no firm attached would render an empty screen.
    expect(isClaimableLookupOutcome({ outcome: "single_person", firm: null, firms: [] })).toBe(false);
  });

  it("accepts an ambiguous outcome carried only by the firms list", () => {
    expect(
      isClaimableLookupOutcome({
        outcome: "ambiguous_firm",
        firm: null,
        firms: [{ crd: 159042, name: "PENSERRA CAPITAL MANAGEMENT LLC" } as never],
      }),
    ).toBe(true);
  });

  it("normalises whatever shape the verified number arrives in", () => {
    expect(toNanpDigits("+18015663510")).toBe("8015663510");
    expect(toNanpDigits("(801) 566-3510")).toBe("8015663510");
    expect(toNanpDigits("18015663510")).toBe("8015663510");
    expect(toNanpDigits("+44 20 7946 0958")).toBe("");
    expect(toNanpDigits(null)).toBe("");
  });

  it("carries the number and the original destination into the claim route", () => {
    expect(buildRiaClaimRoute("+18015663510")).toBe("/ria/claim?phone=8015663510");
    expect(buildRiaClaimRoute("+18015663510", { returnTo: "/one/setup" })).toBe(
      "/ria/claim?phone=8015663510&return_to=%2Fone%2Fsetup",
    );
  });
});

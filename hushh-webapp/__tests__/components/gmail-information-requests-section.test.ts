import { describe, expect, it } from "vitest";

import { isExactDraftCandidate } from "@/components/gmail/gmail-information-requests-section";
import { projectDomainDataForScope } from "@/lib/personal-knowledge-model/manifest";

describe("personal Gmail information-request scope boundary", () => {
  it("accepts only one manifest-backed exact leaf segment", () => {
    expect(
      isExactDraftCandidate({
        scope: "attr.identity.address.postal_code",
        domain: "identity",
        label: "Postal code",
        segment_ids: ["address"],
      }),
    ).toBe(true);
  });

  it("projects an approved nested leaf without sibling private values", () => {
    const projected = projectDomainDataForScope({
      domain: "identity",
      scope: "attr.identity.address.postal_code",
      approvedPaths: ["address.postal_code"],
      domainData: {
        address: {
          postal_code: "10001",
          street: "1 Private Street",
          city: "New York",
        },
        passport_number: "private-passport-number",
      },
    });

    expect(projected).toEqual({
      identity: { address: { postal_code: "10001" } },
    });
  });

  it("rejects broad, malformed, and unbound scope candidates before PKM access", () => {
    expect(
      isExactDraftCandidate({
        scope: "attr.identity.*",
        domain: "identity",
        label: "Identity",
        segment_ids: ["identity"],
      }),
    ).toBe(false);
    expect(
      isExactDraftCandidate({
        scope: "attr.identity.address.postal_code",
        domain: "identity",
        label: "Postal code",
        segment_ids: [],
      }),
    ).toBe(false);
    expect(
      isExactDraftCandidate({
        scope: "attr.identity.address.*",
        domain: "identity",
        label: "Address",
        segment_ids: ["address"],
      }),
    ).toBe(false);
  });
});

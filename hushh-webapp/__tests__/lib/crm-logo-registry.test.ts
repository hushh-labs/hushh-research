import { describe, expect, it } from "vitest";

import { resolveCrmLogoAsset } from "@/lib/branding/crm-logo-registry";

describe("CRM logo registry", () => {
  it("resolves customer marks from public CRM registry metadata", () => {
    expect(
      resolveCrmLogoAsset({ customerDisplayName: "Chase" }),
    ).toMatchObject({ src: "/brand/chase-logo.svg", alt: "Chase logo" });
    expect(
      resolveCrmLogoAsset({ customerDisplayName: "Macy's" }),
    ).toMatchObject({ src: "/brand/macys-logo.svg", alt: "Macy's logo" });
  });

  it("does not infer a customer mark from unrecognized CRM metadata", () => {
    expect(resolveCrmLogoAsset({ displayName: "Example CRM" })).toBeNull();
  });
});

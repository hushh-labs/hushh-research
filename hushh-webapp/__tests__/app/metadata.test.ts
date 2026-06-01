import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "geist-sans" }),
  Geist_Mono: () => ({ variable: "geist-mono" }),
  Inter: () => ({ variable: "inter" }),
}));

import { metadata as rootMetadata } from "../../app/layout";
import { metadata as consentsMetadata } from "../../app/consents/layout";
import { metadata as kaiMetadata } from "../../app/kai/layout";
import { metadata as loginMetadata } from "../../app/login/layout";
import { metadata as marketplaceMetadata } from "../../app/marketplace/layout";
import { metadata as profileMetadata } from "../../app/profile/layout";
import { metadata as kycMetadata } from "../../app/one/kyc/layout";

describe("App Metadata", () => {
  it("defines a root title template and default", () => {
    expect(rootMetadata.title).toEqual({
      default: "One | Your Personal Agent",
      template: "%s · Hussh",
    });
  });

  it("defines descriptive titles for primary routes", () => {
    expect(consentsMetadata.title).toBe("Consents");
    expect(kaiMetadata.title).toBe("Kai");
    expect(loginMetadata.title).toBe("Sign in");
    expect(marketplaceMetadata.title).toBe("Marketplace");
    expect(profileMetadata.title).toBe("Profile");
  });

  it("preserves existing kyc metadata", () => {
    expect(kycMetadata.title).toBe("Email");
    expect(kycMetadata.description).toBeTruthy();
  });
});

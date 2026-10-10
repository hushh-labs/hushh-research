import { describe, expect, it } from "vitest";

import { normalizePublicWalletCard } from "@/components/wallet-card/public-card-view";

const PHOTO = `data:image/png;base64,${"QUJD".repeat(8)}`;

function avatarOf(avatarUrl: string) {
  return normalizePublicWalletCard({ fullName: "Ada Lovelace", avatarUrl })?.avatarUrl ?? null;
}

describe("visitor photo", () => {
  it("shows an https photo and an uploaded image data URL untouched", () => {
    expect(avatarOf("https://cdn.example.com/a.jpg")).toBe("https://cdn.example.com/a.jpg");
    expect(avatarOf(PHOTO)).toBe(PHOTO);
  });

  it("drops anything that is not a bounded raster image or https link", () => {
    for (const unsafe of [
      "data:image/svg+xml;base64,QUJDRA==",
      "data:text/html;base64,QUJDRA==",
      "javascript:alert(1)",
      "http://cdn.example.com/a.jpg",
      `data:image/png;base64,${"A".repeat(420_000)}`,
    ]) {
      expect(avatarOf(unsafe)).toBeNull();
    }
  });
});

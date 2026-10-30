import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { buildVCard, normalizePublicWalletCard, PublicWalletCardView, publicProfileQrUrl } from "@/components/wallet-card/public-card-view";

it("shows the supplied contact details and uses them in the downloaded contact", () => {
  const card = normalizePublicWalletCard({ fullName: "Ada Lovelace", email: "ada@example.com", phone: "+1 202 555 0142" });
  expect(card).not.toBeNull();
  const html = renderToStaticMarkup(createElement(PublicWalletCardView, { card: card!, embedded: true }));
  expect(html).toContain("ada@example.com</span>");
  expect(html).toContain(`${card!.phone}</span>`);
  expect(html).toContain('href="mailto:ada@example.com"');
  expect(html).toContain('data-testid="visitor-profile-card"');
  expect(html).toContain('aria-label="Hushh profile badge"');
  expect(html).not.toContain('Verified by Hushh');
  const contact = buildVCard(card!);
  expect(contact).toContain("ada@example.com");
  expect(contact).toContain("Ada Lovelace");
});

it("integrates only an authorized-shaped profile link and preserves visitor-only details", () => {
  const card = normalizePublicWalletCard({ fullName: "Ada", summary: "Engineer", skills: ["Design"], organisation: "Example" })!;
  const url = "https://one.hushh.ai/c/abcdefghijklmnop";
  expect(publicProfileQrUrl(url)).toBe(url);
  for (const value of ["javascript:alert(1)", "https://example.com/private", `${url}?private=1`, "https://user:pass@one.hushh.ai/c/abcdefghijklmnop"]) expect(publicProfileQrUrl(value)).toBeNull();
  const html = renderToStaticMarkup(createElement(PublicWalletCardView, { card, profileUrl: url }));
  expect(html).toContain('aria-label="Profile QR code"');
  expect(html).toContain("Engineer");
  expect(html).toContain("Design");
  expect(html).not.toContain("mailto:");
});

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

it("shows Hussh branding and contact details without an extra QR card", () => {
  const card = normalizePublicWalletCard({ fullName: "Ada Lovelace", email: "ada@example.com" })!;
  const html = renderToStaticMarkup(createElement(PublicWalletCardView, { card, embedded: true }));
  expect(html).toContain('aria-label="Hushh profile badge"');
  expect(html).toContain('href="mailto:ada@example.com"');
  expect(html).not.toContain('data-testid="wallet-card-pass-preview"');
  expect(html).not.toContain("Scan to open");
  expect(html).not.toContain("Verified");
  expect(html).not.toContain("Save contact");
});

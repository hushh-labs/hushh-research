import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "geist-sans" }),
  Geist_Mono: () => ({ variable: "geist-mono" }),
  Inter: () => ({ variable: "inter" }),
}));

import { metadata } from "@/app/layout";

describe("root layout metadata", () => {
  it("keeps the canonical Hussh One title and base URL", () => {
    expect(metadata.title).toBe("Hussh One | Your Private Agent");
    expect(metadata.metadataBase?.toString()).toBe("https://one.hussh.si/");
  });

  it("publishes OpenGraph and Twitter image metadata", () => {
    expect(metadata.openGraph?.siteName).toBe("Hussh");
    expect(metadata.openGraph?.url).toBe("https://one.hussh.si");
    expect(metadata.twitter?.card).toBe("summary_large_image");
    expect(metadata.twitter?.images).toEqual(["/quiet-emoji-icon.png"]);
  });
});

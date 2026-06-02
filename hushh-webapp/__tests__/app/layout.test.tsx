import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "geist-sans" }),
  Geist_Mono: () => ({ variable: "geist-mono" }),
  Inter: () => ({ variable: "inter" }),
}));

import { metadata } from "@/app/layout";

describe("root layout metadata", () => {
  it("keeps the canonical One title and base URL", () => {
    expect(metadata.title).toBe("One | Your Personal Agent");
    expect(metadata.metadataBase?.toString()).toBe("https://hushh.ai/");
  });

  it("publishes OpenGraph and Twitter image metadata", () => {
    expect(metadata.openGraph?.siteName).toBe("Hussh");
    expect(metadata.openGraph?.url).toBe("https://hushh.ai");
    expect(metadata.twitter?.card).toBe("summary_large_image");
    expect(metadata.twitter?.images).toEqual(["/quiet-emoji-icon.png"]);
  });
});

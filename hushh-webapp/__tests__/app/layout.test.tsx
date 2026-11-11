import { Children, isValidElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "geist-sans" }),
  Geist_Mono: () => ({ variable: "geist-mono" }),
  Inter: () => ({ variable: "inter" }),
}));

import { metadata } from "@/app/layout";

function scriptIn(tree: unknown, id: string): Record<string, unknown> | undefined {
  if (!isValidElement<Record<string, unknown>>(tree)) return undefined;
  if (tree.props.id === id) return tree.props;
  for (const child of Children.toArray(tree.props.children as React.ReactNode)) {
    const found = scriptIn(child, id);
    if (found) return found;
  }
  return undefined;
}

describe("root layout metadata", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it("keeps the canonical Hussh One title and base URL", () => {
    expect(metadata.title).toBe("Hussh One | Agent One");
    expect(metadata.metadataBase?.toString()).toBe("https://one.hussh.si/");
  });

  it("publishes OpenGraph and Twitter image metadata", () => {
    expect(metadata.openGraph?.siteName).toBe("Hussh");
    expect(metadata.openGraph?.url).toBe("https://one.hussh.si");
    expect(metadata.twitter?.card).toBe("summary_large_image");
    expect(metadata.twitter?.images).toEqual(["/quiet-emoji-icon.png"]);
  });

  it.each(["G-H1KGXGZTCF", ""])("configures protected defaults before loaders with measurement ID '%s'", async (measurementId) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CAPACITOR_BUILD", "false");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", measurementId);
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-ABC1234");
    vi.resetModules();
    const { default: RootLayout } = await import("@/app/layout");
    const tree = RootLayout({ children: null });
    const base = scriptIn(tree, "ga-base");
    expect(base?.strategy).toBe("beforeInteractive");
    expect(scriptIn(tree, measurementId ? "ga-loader" : "gtm-base")?.strategy).toBe("afterInteractive");
    const gtag = vi.fn();
    const location = "https://one.hussh.si/one/documents/open?ref=synthetic-ref#private";
    const html = (base?.dangerouslySetInnerHTML as { __html: string }).__html;
    new Function("window", "document", html)({ location: { href: location }, gtag }, { referrer: location });
    expect(gtag).toHaveBeenCalledWith("set", {
      page_location: "https://one.hussh.si/one/documents/open",
      page_referrer: "https://one.hussh.si/one/documents/open",
    });
    if (measurementId) expect(gtag).toHaveBeenCalledWith("config", measurementId, {
      send_page_view: false,
      page_location: "https://one.hussh.si/one/documents/open",
      page_referrer: "https://one.hussh.si/one/documents/open",
    });
    else expect(gtag.mock.calls.some(([command]) => command === "config")).toBe(false);
    if (!measurementId) expect(scriptIn(tree, "ga-loader")).toBeUndefined();
    expect(JSON.stringify(gtag.mock.calls)).not.toContain("synthetic-ref");
  });
});

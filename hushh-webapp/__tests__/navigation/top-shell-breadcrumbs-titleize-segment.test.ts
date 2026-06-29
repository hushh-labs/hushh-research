import { describe, expect, it } from "vitest";

import { resolveTopShellBreadcrumb } from "@/lib/navigation/top-shell-breadcrumbs";

/**
 * Characterization tests for the titleizeSegment fallback labeling path inside
 * resolveTopShellBreadcrumb.
 *
 * Implementation boundaries (top-shell-breadcrumbs.ts):
 *
 *   function titleizeSegment(segment: string): string {
 *     return segment
 *       .split("-")
 *       .filter(Boolean)
 *       .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
 *       .join(" ");
 *   }
 *
 * This is called in the generic /profile/* fallback at the end of
 * resolveTopShellBreadcrumb, reached only when:
 *   1. pathname.startsWith(`${ROUTES.PROFILE}/`) — the pathname is inside /profile/
 *   2. pathname is NOT one of the explicitly named sub-routes:
 *      /profile/pkm, /profile/pkm-agent-lab, /profile/receipts
 *
 * The fallback return shape is:
 *
 *   {
 *     backHref: profilePanelHref("account"),   // "/profile?panel=account"
 *     width: "profile",
 *     items: [
 *       { label: "Profile", href: "/profile?panel=account" },
 *       { label: titleizeSegment(firstSegment) },
 *       ...remainingSegments.map(s => ({ label: titleizeSegment(s) })),
 *     ],
 *   }
 *
 * Why behavior is guaranteed:
 * - split("-") always produces an array; filter(Boolean) removes any empty
 *   strings created by consecutive hyphens.
 * - charAt(0).toUpperCase() + slice(1) uppercases only the first character;
 *   subsequent characters are preserved exactly as they appear in the URL.
 * - join(" ") always uses a single space between capitalized words.
 * - Each URL path segment is processed independently; multi-level paths
 *   produce one label per segment.
 */
describe("resolveTopShellBreadcrumb — titleizeSegment fallback labeling", () => {
  describe("single-word segments", () => {
    it("capitalizes a single lowercase word", () => {
      // "settings".split("-") → ["settings"], map → ["Settings"], join → "Settings"
      const result = resolveTopShellBreadcrumb("/profile/settings");
      expect(result).not.toBeNull();
      expect(result!.items[1]).toEqual({ label: "Settings" });
    });

    it("preserves subsequent characters exactly — only the first char is uppercased", () => {
      // "API" → charAt(0).toUpperCase()="A" + slice(1)="PI" → "API"
      const result = resolveTopShellBreadcrumb("/profile/API");
      expect(result).not.toBeNull();
      expect(result!.items[1]).toEqual({ label: "API" });
    });

    it("capitalizes a single-character segment", () => {
      const result = resolveTopShellBreadcrumb("/profile/x");
      expect(result).not.toBeNull();
      expect(result!.items[1]).toEqual({ label: "X" });
    });
  });

  describe("hyphenated multi-word segments", () => {
    it("capitalizes each hyphen-delimited word independently and joins with a space", () => {
      // "my-custom-page".split("-") → ["my","custom","page"]
      // map → ["My","Custom","Page"], join → "My Custom Page"
      const result = resolveTopShellBreadcrumb("/profile/my-custom-page");
      expect(result).not.toBeNull();
      expect(result!.items[1]).toEqual({ label: "My Custom Page" });
    });

    it("capitalizes a two-word hyphenated segment", () => {
      // "sign-in".split("-") → ["sign","in"] → "Sign In"
      const result = resolveTopShellBreadcrumb("/profile/sign-in");
      expect(result).not.toBeNull();
      expect(result!.items[1]).toEqual({ label: "Sign In" });
    });
  });

  describe("multi-level /profile/* paths", () => {
    it("produces one breadcrumb item per path segment", () => {
      // nestedPath="foo/bar-baz", segments=["foo","bar-baz"]
      // firstSegment="foo" → "Foo", remainingSegments=["bar-baz"] → "Bar Baz"
      const result = resolveTopShellBreadcrumb("/profile/foo/bar-baz");
      expect(result).not.toBeNull();
      expect(result!.items).toHaveLength(3);
      expect(result!.items[1]).toEqual({ label: "Foo" });
      expect(result!.items[2]).toEqual({ label: "Bar Baz" });
    });

    it("titleizes all segments independently at every nesting level", () => {
      const result = resolveTopShellBreadcrumb("/profile/one-section/two-part");
      expect(result).not.toBeNull();
      expect(result!.items[1]).toEqual({ label: "One Section" });
      expect(result!.items[2]).toEqual({ label: "Two Part" });
    });
  });

  describe("fallback breadcrumb structure anchoring", () => {
    it("anchors the first item as Profile with href pointing to /profile?panel=account", () => {
      // profilePanelHref("account") = `${ROUTES.PROFILE}?panel=${encodeURIComponent("account")}`
      //                             = "/profile?panel=account"
      const result = resolveTopShellBreadcrumb("/profile/settings");
      expect(result).not.toBeNull();
      expect(result!.backHref).toBe("/profile?panel=account");
      expect(result!.items[0]).toEqual({
        label: "Profile",
        href: "/profile?panel=account",
      });
    });

    it("sets width to 'profile' for the generic fallback", () => {
      const result = resolveTopShellBreadcrumb("/profile/settings");
      expect(result).not.toBeNull();
      expect(result!.width).toBe("profile");
    });
  });
});
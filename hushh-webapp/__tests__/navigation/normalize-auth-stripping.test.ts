import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

/**
 * Characterization tests for normalizeInternalRouteHref
 * (hushh-webapp/lib/navigation/routes.ts) when the href embeds inline
 * URL-credential blocks (userinfo) such as `user:pass@legal/privacy`.
 *
 * TRUTH-FIRST (verified against the source):
 *   The guard is a pure allow/deny gate over the trimmed string:
 *     const href = String(value ?? "").trim();
 *     if (!href) return null;
 *     if (!href.startsWith("/") || href.startsWith("//")) return null;
 *     if (/[\r\n]/.test(href)) return null;
 *     return href;
 *   It does NOT parse URL authority, does NOT recognize `user:pass@` userinfo,
 *   and does NOT strip credential blocks. There is no `@`, `:`, or userinfo
 *   handling anywhere. Consequences pinned below:
 *     - A rooted href containing a credential-looking block is treated as opaque
 *       path text and returned BYTE-FOR-BYTE (credentials retained, not filtered).
 *     - The deny rules are unchanged by the presence of credentials: a non-rooted
 *       `user:pass@...` is rejected (does not start with `/`), and a
 *       protocol-relative `//user:pass@host/...` is rejected (starts with `//`).
 *   In short: normalizeInternalRouteHref neither flags nor strips inline
 *   credentials — it only enforces trim + single-leading-slash + no-CRLF.
 */

describe("normalizeInternalRouteHref — inline credential blocks are retained, not stripped", () => {
  it("returns a rooted href with an inline user:pass@ block byte-for-byte", () => {
    const href = "/user:pass@legal/privacy";
    expect(normalizeInternalRouteHref(href)).toBe("/user:pass@legal/privacy");
  });

  it("does not strip the credential segment from the path", () => {
    const out = normalizeInternalRouteHref("/user:pass@legal/privacy");
    expect(out).toContain("user:pass@");
    expect(out).toContain("legal/privacy");
  });

  it("retains username-only userinfo (no password) verbatim", () => {
    expect(normalizeInternalRouteHref("/admin@dashboard/settings")).toBe(
      "/admin@dashboard/settings"
    );
  });

  it("retains an empty-credential `@` prefix verbatim", () => {
    expect(normalizeInternalRouteHref("/@legal/privacy")).toBe("/@legal/privacy");
  });

  it("retains multiple `@`/`:` credential-looking tokens verbatim", () => {
    expect(normalizeInternalRouteHref("/a:b@c:d@legal/privacy")).toBe(
      "/a:b@c:d@legal/privacy"
    );
  });

  it("trims whitespace but keeps the inner credential block intact", () => {
    expect(normalizeInternalRouteHref("  /user:pass@legal/privacy  ")).toBe(
      "/user:pass@legal/privacy"
    );
  });

  it("rejects a NON-rooted credentialed href (does not start with `/`)", () => {
    expect(normalizeInternalRouteHref("user:pass@legal/privacy")).toBeNull();
  });

  it("rejects a protocol-relative credentialed href (starts with `//`)", () => {
    expect(
      normalizeInternalRouteHref("//user:pass@evil.example/legal/privacy")
    ).toBeNull();
  });

  it("rejects a credentialed href that contains a newline", () => {
    expect(
      normalizeInternalRouteHref("/user:pass@legal\n/privacy")
    ).toBeNull();
  });

  it("rejects empty/whitespace-only input regardless of credential intent", () => {
    expect(normalizeInternalRouteHref("   ")).toBeNull();
  });
});

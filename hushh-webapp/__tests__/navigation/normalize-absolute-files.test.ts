import { describe, expect, it } from "vitest";

import { normalizeInternalRouteHref } from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref
// (hushh-webapp/lib/navigation/routes.ts) against absolute file-system / file://
// style inputs.
//
// TRUTH-FIRST — LITERAL CONTRACT: normalizeInternalRouteHref is a same-origin
// allow-list guard, NOT a path normalizer. Its full body is:
//
//   const href = String(value ?? "").trim();
//   if (!href) return null;
//   if (!href.startsWith("/") || href.startsWith("//")) return null;
//   if (/[\r\n]/.test(href)) return null;
//   return href;
//
// Consequences for "absolute file" shapes:
//  * It does NO path resolution, NO `..` collapsing, NO drive-letter handling,
//    NO percent-decoding. A surviving value is returned BYTE-FOR-BYTE (post-trim).
//  * `file://...` is rejected because it starts with "f", not "/".
//  * Windows paths like `C:\...` are rejected (start with "C").
//  * `//server/share` (UNC / protocol-relative) is rejected by the explicit
//    `startsWith("//")` guard — treated as EXTERNAL.
//  * A POSIX-absolute string like `/etc/passwd` or `/C:/app/index.html` starts
//    with a single "/" and is therefore treated as a same-origin route and
//    returned VERBATIM. The guard is a scheme/origin gate, not a filesystem
//    safety check — it does not "sanitize" traversal-looking paths.
//
// These tests pin exactly that boundary (external -> null, single-slash -> echo).

describe("normalizeInternalRouteHref — absolute file / file:// inputs", () => {
  it("rejects file:/// URIs (Windows drive) as external -> null", () => {
    expect(normalizeInternalRouteHref("file:///C:/app/index.html")).toBeNull();
  });

  it("rejects POSIX file:/// URIs as external -> null", () => {
    expect(normalizeInternalRouteHref("file:///etc/passwd")).toBeNull();
  });

  it("rejects bare Windows drive paths (C:\\...) as external -> null", () => {
    expect(normalizeInternalRouteHref("C:\\app\\index.html")).toBeNull();
  });

  it("rejects UNC / protocol-relative double-slash paths -> null", () => {
    expect(normalizeInternalRouteHref("//server/share/index.html")).toBeNull();
  });

  it("returns a single-slash POSIX-absolute path verbatim (no fs sanitizing)", () => {
    // Looks like a root system file, but it starts with one "/" so the guard
    // treats it as a same-origin route and echoes it unchanged.
    expect(normalizeInternalRouteHref("/etc/passwd")).toBe("/etc/passwd");
  });

  it("returns a single-slash drive-style path verbatim (no drive parsing)", () => {
    expect(normalizeInternalRouteHref("/C:/app/index.html")).toBe(
      "/C:/app/index.html",
    );
  });

  it("does NOT collapse traversal segments in a surviving single-slash path", () => {
    expect(normalizeInternalRouteHref("/../../etc/passwd")).toBe(
      "/../../etc/passwd",
    );
  });

  it("trims surrounding whitespace before the slash check, then echoes verbatim", () => {
    expect(normalizeInternalRouteHref("   /var/data/report.html   ")).toBe(
      "/var/data/report.html",
    );
  });

  it("rejects a CRLF-bearing absolute path even after trim -> null", () => {
    expect(normalizeInternalRouteHref("/var/data\r\n/report.html")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  normalizeInternalRouteHref,
  resolveInternalRouteHref,
} from "@/lib/navigation/routes";

// Characterization tests for normalizeInternalRouteHref in
// lib/navigation/routes.ts, focused on route hrefs whose raw string content is
// injected with hidden ASCII control characters or terminal NULL bytes
// (e.g. "/dashboard\x00/settings" or "\x01/app").
//
// Truth-first note on the real implementation (routes.ts):
//
//   export function normalizeInternalRouteHref(value) {
//     const href = String(value ?? "").trim();
//     if (!href) return null;
//     if (!href.startsWith("/") || href.startsWith("//")) return null;
//     if (/[\r\n]/.test(href)) return null;
//     return href;
//   }
//
// The ONLY control characters this validator special-cases are carriage return
// (\r, U+000D) and line feed (\n, U+000A). Every other C0 control character is
// treated as ordinary string content. Consequences these tests pin down:
//
//   * A NULL byte (\x00) or other non-newline control byte embedded AFTER a
//     valid leading "/" does NOT trigger rejection. The href is returned
//     verbatim (byte-for-byte) after `.trim()`. This documents a real
//     pass-through boundary, not a sanitization guarantee.
//   * A leading control byte (e.g. \x01) is NOT removed by `.trim()` (which
//     only strips standard whitespace, of which \x01 is not a member). Because
//     the string then does not start with "/", it is rejected via the
//     leading-slash guard — an incidental rejection, not a control-character
//     filter.
//   * \r and \n remain the only control characters that force a null return
//     through the explicit CR/LF guard.
//
// These tests characterize current behavior so any future hardening (e.g.
// adding an explicit control-character rejection) is a deliberate, visible
// contract change rather than a silent drift.

const NUL = "\x00";
const SOH = "\x01"; // start-of-heading, a representative non-newline C0 control

describe("normalizeInternalRouteHref — control character injection bounds", () => {
  it("returns an href with an embedded NULL byte verbatim (no sanitization)", () => {
    // Starts with "/", not "//", and contains no CR/LF, so it passes.
    const input = `/dashboard${NUL}/settings`;
    expect(normalizeInternalRouteHref(input)).toBe(input);
  });

  it("returns an href with an embedded non-newline control byte verbatim", () => {
    const input = `/app${SOH}/inner`;
    expect(normalizeInternalRouteHref(input)).toBe(input);
  });

  it("rejects a leading control byte because it defeats the leading-slash guard", () => {
    // `.trim()` does not strip \x01, so "\x01/app" does not start with "/".
    expect(normalizeInternalRouteHref(`${SOH}/app`)).toBeNull();
  });

  it("rejects a leading NULL byte for the same leading-slash reason", () => {
    expect(normalizeInternalRouteHref(`${NUL}/dashboard`)).toBeNull();
  });

  it("still rejects a carriage return even when combined with a NULL byte", () => {
    // The explicit /[\r\n]/ guard fires regardless of other control bytes.
    expect(normalizeInternalRouteHref(`/app${NUL}\r/settings`)).toBeNull();
  });

  it("still rejects a line feed even when combined with a control byte", () => {
    expect(normalizeInternalRouteHref(`/app${SOH}\n/settings`)).toBeNull();
  });

  it("keeps a trailing NULL byte intact on an otherwise valid href", () => {
    const input = `/one${NUL}`;
    expect(normalizeInternalRouteHref(input)).toBe(input);
  });

  it("resolveInternalRouteHref preserves a NULL-byte href but falls back on a leading control byte", () => {
    const passThrough = `/dashboard${NUL}/settings`;
    expect(resolveInternalRouteHref(passThrough, "/one")).toBe(passThrough);
    // Leading control byte -> null -> caller-supplied fallback.
    expect(resolveInternalRouteHref(`${SOH}/app`, "/one")).toBe("/one");
    // CR/LF-containing input -> null -> fallback.
    expect(resolveInternalRouteHref(`/app${NUL}\r/x`, "/one")).toBe("/one");
  });
});

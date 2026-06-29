import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) when native JavaScript `URL`
// instances are embedded inside payload objects.
//
// TRUTH-FIRST — CURRENT CONTRACT (verified against source):
//
// formatCompleteJson walks objects exclusively via Object.entries(...). All of
// a `URL` instance's accessor properties (href, origin, protocol, hostname,
// host, pathname, search, hash, username, password, port, searchParams) are
// GETTERS DEFINED ON URL.prototype — they are NOT own-enumerable properties.
// Therefore Object.entries(new URL("...")) === [] (an empty array).
//
// CORRECTION TO THE TASK PREMISE: the formatter does NOT "map URL objects
// safely without stripping domain metadata." The opposite is true — because a
// URL exposes zero own-enumerable keys, every piece of domain metadata is
// STRIPPED. A top-level URL value yields only a section header with no field
// lines; a nested URL value yields only a "Label:" line with no children. The
// URL is never serialized via toString(); its href/hostname never appear.
//
// These tests pin that real, existing behavioral boundary so any future change
// that starts surfacing URL metadata is caught as an intentional contract shift.

describe("formatCompleteJson — native URL instances are emptied of own-enumerable keys", () => {
  it("confirms the precondition: URL instances expose no own-enumerable entries", () => {
    const url = new URL("https://user:pass@sub.example.com:8443/a/b?x=1#frag");
    expect(Object.entries(url)).toEqual([]);
    expect(Object.keys(url)).toEqual([]);
  });

  it("does not throw when a URL instance is a top-level section value", () => {
    const url = new URL("https://example.com/path?q=1");
    expect(() => formatCompleteJson({ source: url })).not.toThrow();
  });

  it("emits only the section header and strips all domain metadata (top-level)", () => {
    const url = new URL("https://user:pass@sub.example.com:8443/a/b?x=1#frag");
    const out = formatCompleteJson({ source: url });
    // Object branch: blank line + "--- <Label> ---", then empty entries.
    expect(out).toBe("\n--- Source ---");
    // None of the URL's domain metadata is serialized.
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("https");
    expect(out).not.toContain("8443");
    expect(out).not.toContain("frag");
  });

  it("emits only a 'Label:' line for a nested URL value (no children, no href)", () => {
    const url = new URL("https://api.example.org/v1/resource");
    const out = formatCompleteJson({
      account_metadata: { website: url },
    });
    expect(out).toContain("--- Account Information ---");
    // Nested-object branch prints the humanized key with a trailing colon only.
    expect(out).toContain("  Website:");
    // No nested field lines and no serialized URL text leak through.
    expect(out).not.toContain("api.example.org");
    expect(out).not.toContain("/v1/resource");
  });

  it("never invokes URL.toString(): the href string does not appear in output", () => {
    const href = "https://no-leak.example.net/secret-path?token=abc#h";
    const url = new URL(href);
    const out = formatCompleteJson({ link: url });
    expect(out).not.toContain(href);
    expect(out).not.toContain("no-leak.example.net");
    expect(out).not.toContain("secret-path");
  });

  it("keeps sibling string fields intact while the URL section is emptied", () => {
    const out = formatCompleteJson({
      institution_name: "Acme Bank",
      source: new URL("https://acme.example.com/login"),
    });
    // Top-level scalar still formats normally.
    expect(out).toContain("Institution: Acme Bank");
    // URL section contributes only its header.
    expect(out).toContain("--- Source ---");
    expect(out).not.toContain("acme.example.com");
  });

  it("treats an array of URL instances by element index, surfacing no URL text", () => {
    const out = formatCompleteJson({
      links: [new URL("https://a.example.com"), new URL("https://b.example.com")],
    });
    // Generic array branch announces item count and inspects element values.
    expect(out).toContain("--- Links (2 items) ---");
    // Each URL element has no own-enumerable values, so no domain text leaks.
    expect(out).not.toContain("a.example.com");
    expect(out).not.toContain("b.example.com");
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..", "..");

// Regression guard for #6465: the web build's `generateStaticParams` here
// always returns `[]` (real tokens are never known at build time), so every
// web request falls through to Next's "unlisted dynamic param" fallback path
// -- which disagreed at runtime with the `/one` layout ancestor's own
// `connection()`-forced dynamic rendering (app/one/layout.tsx), throwing
// "Page changed from static to dynamic at runtime, reason: connection" as a
// 500 on real public share links.
//
// A route-segment `dynamic` export can't fix this: Turbopack requires that
// value to be a static string literal ("Next.js can't recognize the exported
// `dynamic` field in route. It needs to be a static string" -- caught by CI
// on the first attempt), so it can't be gated on CAPACITOR_BUILD the way
// generateStaticParams is, and a bare `force-dynamic` breaks Capacitor's
// `output: export` build outright. Calling `connection()` in the page's own
// render, gated exactly like generateStaticParams, is the same mechanism the
// layout already uses successfully for this same problem.
describe("/one/location/view/[token] dynamic rendering", () => {
  it("forces a live web request via connection(), gated off for Capacitor", () => {
    const source = readFileSync(
      path.join(
        repoRoot,
        "app",
        "one",
        "location",
        "view",
        "[token]",
        "page.tsx",
      ),
      "utf8",
    );

    expect(source).toContain('import { connection } from "next/server"');
    expect(source).toContain('process.env.CAPACITOR_BUILD !== "true"');
    expect(source).toContain("await connection()");
    // The literal-string trap this test exists to catch: a `dynamic` export
    // can't be conditional, so it must not be reintroduced here.
    expect(source).not.toMatch(/^\s*export const dynamic\s*=/m);
  });
});

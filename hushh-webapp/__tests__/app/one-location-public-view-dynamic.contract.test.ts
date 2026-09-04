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
// 500 on real public share links. An explicit `dynamic` export removes the
// ambiguity. It must stay gated on CAPACITOR_BUILD exactly like
// `generateStaticParams`: Capacitor's static export needs the opposite,
// a real static page for its one baked-in test token.
describe("/one/location/view/[token] dynamic rendering", () => {
  it("forces a live web request without breaking the Capacitor static export", () => {
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

    expect(source).toContain('process.env.CAPACITOR_BUILD === "true"');
    expect(source).toMatch(/dynamic\s*=\s*\n?\s*process\.env\.CAPACITOR_BUILD/);
    expect(source).toContain('"force-dynamic"');
  });
});

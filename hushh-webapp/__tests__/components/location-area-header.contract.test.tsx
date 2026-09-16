import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The Location header contract, applied to the voice-first area.
 *
 * Every screen under components/location renders INSIDE the app shell: the
 * top bar owns the back control and the breadcrumb, the flow owns only its
 * `TaskFlowHeader`. Structural, so it is checked at the source: a screen can
 * render every control correctly and still be wrong by covering the shell
 * (`fixed inset-0`, a `z-[..]`, `h-[100dvh]`), by drawing a second back
 * arrow, or by hardcoding a dark-only colour that vanishes in light mode.
 *
 * Modelled on __tests__/components/one-location-sos-emergency.contract.test.tsx.
 */

const LOCATION_ROOT = path.resolve(__dirname, "../../components/location");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(tsx?|ts)$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    out.push(full);
  }
  return out.sort();
}

/** Drop comments so a PR number ("#5251") or prose never trips the hex scan. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/** `#abc`, `#aabbcc`, `#aabbccdd` used as a colour (not an id selector or a word). */
const RAW_HEX_COLOR =
  /(?:^|[\s"'`(,:\[])#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})(?![\w-])/gi;

const FILES = listSourceFiles(LOCATION_ROOT);

describe("Location area header contract (components/location/**)", () => {
  it("scans at least the area router and the screens", () => {
    const names = FILES.map((file) => path.relative(LOCATION_ROOT, file));
    expect(names).toContain("location-area.tsx");
    expect(names).toContain("location-home.tsx");
    expect(names).toContain("settings/location-settings.tsx");
    expect(names).toContain("ask/ask-for-location-flow.tsx");
    expect(names).toContain("share/share-location-flow.tsx");
  });

  describe.each(
    FILES.map((file) => [path.relative(LOCATION_ROOT, file), file] as const),
  )("%s", (_name, file) => {
    const raw = fs.readFileSync(file, "utf8");
    const source = stripComments(raw);

    it("renders inside the shell, never over it", () => {
      expect(source).not.toContain("fixed inset-0");
      expect(source).not.toMatch(/\bz-\[/);
      expect(source).not.toContain("h-[100dvh]");
    });

    it("uses theme tokens, never dark-only colours or raw hexes", () => {
      expect(source).not.toMatch(/\btext-white\b/);
      expect(source).not.toMatch(/\bbg-black\b/);
      const hexes = Array.from(source.matchAll(RAW_HEX_COLOR)).map((match) =>
        match[0].trim(),
      );
      expect(hexes).toEqual([]);
    });

    it("draws no in-content back control; the top bar owns back", () => {
      expect(source).not.toContain("ChevronLeft");
      // The onBack prop on TaskFlowHeader exists for non-Location callers.
      expect(source).not.toMatch(/<TaskFlowHeader[\s\S]*?\bonBack=/);
      // Your Map is its own route with its own chrome (see the skill's
      // surface table); every hub flow leaves back to the top bar.
      if (!_name.startsWith("map/")) {
        expect(source).not.toMatch(/aria-label=["']Back/);
      }
    });

    it("keeps keyframes in app/globals.css with the reduced-motion guard", () => {
      expect(source).not.toContain("@keyframes");
      expect(source).not.toContain("<style>");
    });
  });

  it("every TaskFlowHeader title in the area matches a registered breadcrumb label", () => {
    const breadcrumbs = fs.readFileSync(
      path.resolve(__dirname, "../../lib/navigation/top-shell-breadcrumbs.ts"),
      "utf8",
    );
    const labels = new Set(
      Array.from(
        breadcrumbs.matchAll(/^\s*"?([\w-]+)"?:\s*"([^"]+)",?\s*$/gm),
      ).map((match) => match[2]),
    );
    // Hub tabs are headings under the Location PageHeader, not flows with a
    // crumb of their own; Your Map and Location setup are separate routes.
    const exempt = new Set([
      "Now",
      "People",
      "Circles",
      "Links",
      "Your Map",
      "Location setup",
    ]);
    for (const file of FILES) {
      const source = stripComments(fs.readFileSync(file, "utf8"));
      for (const match of source.matchAll(
        /<TaskFlowHeader[^>]*?\btitle="([^"]+)"/g,
      )) {
        const title = match[1];
        if (exempt.has(title) || labels.has(title)) continue;
        expect.fail(
          `${path.relative(LOCATION_ROOT, file)}: TaskFlowHeader title "${title}" is not a breadcrumb label in oneLocationActionLabel()`,
        );
      }
    }
  });
});

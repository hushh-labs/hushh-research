import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { APP_ROUTE_LAYOUT_CONTRACT } from "@/lib/navigation/app-route-layout";

/**
 * A fullscreen flow gets no top spacer from the shell.
 *
 * Standard routes are cleared structurally: `app/providers.tsx` renders
 * `[data-app-shell-top-spacer]` inside the scroll root, so a page cannot start
 * under the header even if it forgets to ask. A `flow` route has no spacer --
 * the shell publishes `--app-fullscreen-flow-content-offset` and the page is
 * expected to consume it. A flow page that consumes nothing paints its first
 * pixel at y=0, directly beneath the fixed top bar, and no unit test notices.
 *
 * So every flow route must NAME the file that owns its clearance, and that file
 * must actually contain one of the two sanctioned ways to consume it. This
 * fails closed: a new flow route with no declaration is a failure, not a
 * silently uncovered screen.
 *
 * The pixel side of the same contract -- that the offset clears the header's
 * fade band and not just its reserved height -- is measured in a real browser
 * by `e2e/app-shell-top-clearance.layout.spec.ts`. JSDOM performs no layout and
 * cannot prove it.
 */

const webappRoot = path.resolve(__dirname, "..", "..");

/**
 * `FullscreenFlowShell` applies `padding-top:
 * var(--app-fullscreen-flow-content-offset)` through `.fullscreen-flow-shell`.
 * `--top-content-pad` is the other sanctioned token: it resolves to the shell's
 * VISUAL height plus a reading gap, so a page padded with it also clears the
 * header. Anything else is a page inventing its own geometry.
 */
const SANCTIONED_CLEARANCE = [
  "FullscreenFlowShell",
  "--app-fullscreen-flow-content-offset",
  "--top-content-pad",
] as const;

const flowRoutes = APP_ROUTE_LAYOUT_CONTRACT.filter(
  (entry) => entry.mode === "flow",
);

describe("fullscreen flow top clearance", () => {
  it("has flow routes to check", () => {
    // Guards against the suite quietly passing because the filter broke.
    expect(flowRoutes.length).toBeGreaterThan(0);
  });

  it.each(flowRoutes.map((entry) => [entry.route, entry] as const))(
    "%s declares the file that clears the top shell",
    (route, entry) => {
      expect(
        entry.shellVerification,
        `${route} is a fullscreen flow, so the shell renders no top spacer for it. Add a shellVerification naming the file that consumes --app-fullscreen-flow-content-offset, or the screen will start underneath the header.`,
      ).toBeTruthy();

      const declared = entry.shellVerification!;
      const absolute = path.join(webappRoot, declared.file);
      expect(
        fs.existsSync(absolute),
        `${route} names ${declared.file}, which does not exist`,
      ).toBe(true);

      const source = fs.readFileSync(absolute, "utf8");
      const used = SANCTIONED_CLEARANCE.filter((token) =>
        source.includes(token),
      );
      expect(
        used,
        `${route} → ${declared.file} consumes none of ${SANCTIONED_CLEARANCE.join(", ")}, so nothing offsets it below the fixed top bar.`,
      ).not.toHaveLength(0);
    },
  );

  it("keeps a flow route from pinning its offset back to the bare reserved height", () => {
    // Two RIA screens used to hard-set the offset to
    // `var(--top-shell-reserved-height)` locally. That is the height the mask
    // is SOLID to, not the height it paints to, so those screens stayed 22px
    // under the header after the shared token was corrected -- which is what
    // "it is fixed on some pages but not others" looked like.
    for (const entry of flowRoutes) {
      const files = new Set<string>();
      if (entry.shellVerification) files.add(entry.shellVerification.file);
      for (const relative of files) {
        const absolute = path.join(webappRoot, relative);
        if (!fs.existsSync(absolute)) continue;
        const source = fs.readFileSync(absolute, "utf8");
        expect(
          source.replace(/\s+/g, " "),
          `${relative} overrides --app-fullscreen-flow-content-offset with the reserved height, which leaves its first line inside the header's fade band.`,
        ).not.toContain(
          '"--app-fullscreen-flow-content-offset": "var(--top-shell-reserved-height)"',
        );
      }
    }
  });
});

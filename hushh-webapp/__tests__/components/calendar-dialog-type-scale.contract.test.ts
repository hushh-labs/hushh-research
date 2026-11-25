import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The production CSS Modules compiler keeps only the first external class of a
 * `composes` chain. `.portal` -> `.scope` -> `scale` therefore renders
 * `portal scope` without `scale`, and a Calendar dialog falls back to the global
 * 17/15/13 scale instead of Connect v14. The Playwright harness bundles CSS
 * differently and cannot see this, so the three Calendar dialogs name Connect's
 * `surface` class directly. A rendered Next measurement is the proof; this
 * contract stops the class from being dropped.
 */
const dialogs: Array<[string, string]> = [
  ["components/calendar/calendar-account-board.tsx", "${styles.detail} ${presentationStyles.portal} ${connectTypography.surface}"],
  ["components/calendar/calendar-booking-dialog.tsx", "${styles.dialog} ${presentationStyles.portal} ${connectTypography.surface}"],
  ["components/calendar/calendar-invitations.tsx", "${presentationStyles.portal} ${connectTypography.surface}"],
];

describe("Calendar dialogs carry the Connect v14 surface", () => {
  it.each(dialogs)("%s names the Connect surface class on its DialogContent", (file, classes) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source).toContain('import connectTypography from "@/lib/morphy-ux/ui/connect-type-scale.module.css"');
    expect(source).toContain(classes);
  });
});

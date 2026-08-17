/**
 * Regenerate e2e/fixtures/feed-needs-you-rows.html from the REAL component.
 *
 * The layout spec beside that fixture measures whether a Feed row's description
 * paints over its timestamp. A hand-written fixture would only ever prove
 * something about the fixture, and a fixture captured once and then left alone
 * goes stale the moment the component changes — which is exactly what happened:
 * the first capture was taken before the fix and kept reporting the old 94px
 * overlap against a component that no longer produced it.
 *
 * So the markup is rendered from `FeedActionableRow` itself, and this script is
 * the one command that refreshes it:
 *
 *   node scripts/testing/capture-feed-needs-you-fixture.mjs
 *
 * Run it whenever feed-actionable-row.tsx or SettingsRow changes shape. The
 * spec asserts geometry; this keeps the geometry it measures honest.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TEST_SOURCE = `
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";

import { FeedActionableRow } from "@/components/feed/feed-actionable-row";

/**
 * The three rows the tester reported, with the widest action label in the set.
 * Row 1 is the reported one; row 2 is a chevron-only row; row 3 is the row that
 * looked fine in a wide screenshot and collides on every phone.
 */
const ROWS = [
  {
    id: "extend",
    title: "JHUMMA KUMARI",
    description: "Requesting 4 hours more of your live location.",
    displayTimestamp: Date.parse("2026-08-17T03:04:00Z"),
    icon: undefined,
    iconTone: "amber",
    actions: [
      { id: "deny", label: "Deny", tone: "neutral", onSelect: () => {} },
      { id: "approve", label: "Approve 4 hours more", tone: "primary", onSelect: () => {} },
    ],
  },
  {
    id: "request",
    title: "Smirthika Dharmalingam",
    description: "Smirthika Dharmalingam wants to see your location through Location.",
    displayTimestamp: Date.parse("2026-08-17T02:34:00Z"),
    iconTone: "amber",
    actions: [],
    chevron: true,
    href: "#",
  },
  {
    id: "checkin",
    title: "Smirthika Dharmalingam",
    description: "Safety check-in",
    displayTimestamp: Date.parse("2026-08-17T02:34:00Z"),
    iconTone: "amber",
    actions: [
      { id: "deny", label: "Deny", tone: "neutral", onSelect: () => {} },
      { id: "approve", label: "Approve 1 hour", tone: "primary", onSelect: () => {} },
    ],
  },
];

it("captures the Needs you rows", () => {
  const html = ROWS.map((item) =>
    renderToStaticMarkup(<FeedActionableRow item={item} />),
  ).join("\\n");
  writeFileSync(
    path.join(process.cwd(), "e2e/fixtures/feed-needs-you-rows.html"),
    '<section aria-label="Needs you" class="bg-accent/[0.03]">\\n' +
      '<div class="divide-y divide-[color:var(--foundation-hairline)]">\\n' +
      html +
      "\\n</div>\\n</section>\\n",
  );
});
`;

const dir = mkdtempSync(path.join(tmpdir(), "feed-fixture-"));
const testFile = path.join(process.cwd(), "__tests__", "__capture-feed-fixture.test.tsx");
writeFileSync(testFile, TEST_SOURCE);
try {
  execFileSync("npx", ["vitest", "run", testFile], { stdio: "inherit" });
  console.log("Wrote e2e/fixtures/feed-needs-you-rows.html from the real component.");
} finally {
  rmSync(testFile, { force: true });
  rmSync(dir, { recursive: true, force: true });
}

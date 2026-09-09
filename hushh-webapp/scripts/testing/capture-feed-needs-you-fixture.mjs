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
import path from "node:path";

const TEST_SOURCE = `
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import { MapPin } from "lucide-react";
import path from "node:path";
import { afterEach, it, vi } from "vitest";

import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import { FeedRow } from "@/components/feed/feed-row";
import { SettingsGroup, SettingsPresentationProvider } from "@/components/app-ui/settings-ui";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";

/**
 * The three rows the tester reported, with the widest action label in the set.
 * Row 1 is the reported one; row 2 is a chevron-only row; row 3 is the row that
 * looked fine in a wide screenshot and collides on every phone.
 */
const ROWS: FeedActionable[] = [
  {
    id: "extend",
    person: { displayName: "JHUMMA KUMARI", photoUrl: null },
    title: "JHUMMA KUMARI",
    description: "Requesting 4 hours more of your live location.",
    displayTimestamp: Date.parse("2026-08-17T03:04:00Z"),
    sortAt: Date.parse("2026-08-17T03:04:00Z"),
    icon: MapPin,
    iconTone: "orange",
    actions: [
      { key: "deny", label: "Deny", tone: "danger", confirm: true, run: () => {} },
      { key: "approve", label: "Approve 4 hours more", tone: "primary", run: () => {} },
    ],
  },
  {
    id: "request",
    person: { displayName: "Smirthika Dharmalingam", photoUrl: "https://example.test/photo.png" },
    title: "Smirthika Dharmalingam",
    description: "Smirthika Dharmalingam wants to see your location through Location.",
    displayTimestamp: Date.parse("2026-08-17T02:34:00Z"),
    sortAt: Date.parse("2026-08-17T02:34:00Z"),
    icon: MapPin,
    iconTone: "orange",
    actions: [],
    chevron: true,
    href: "#",
  },
  {
    id: "checkin",
    onSelect: () => {},
    title: "Smirthika Dharmalingam",
    description: "Safety check-in",
    displayTimestamp: Date.parse("2026-08-17T02:34:00Z"),
    sortAt: Date.parse("2026-08-17T02:34:00Z"),
    icon: MapPin,
    iconTone: "orange",
    actions: [
      { key: "deny", label: "Deny", tone: "danger", confirm: true, run: () => {} },
      { key: "approve", label: "Approve 1 hour", tone: "primary", run: () => {} },
    ],
  },
];

afterEach(() => vi.useRealTimers());

it("captures the Needs you rows", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-17T12:00:00Z"));
  const html = renderToStaticMarkup(
    <SettingsPresentationProvider density="compact">
      <SettingsGroup title="Needs you" separatorInset>
        {ROWS.map((item) => <FeedActionableRow key={item.id} item={item} />)}
      </SettingsGroup>
      <SettingsGroup title="Today" separatorInset>
        {["Manish Malhotra", "Aparna", "Very Long Contact Name Without Truncating Identity"].map((name, index) => (
          <FeedRow key={name} onOpen={() => {}} item={{
            id: String(index + 10), source_domain: "location", event_type: "location_share_created",
            actor_label: name, metadata: { counterpart_label: name, feed_audience: "recipient" },
            read: index === 1, created_at: "2026-08-17T02:34:00Z",
          }} />
        ))}
      </SettingsGroup>
    </SettingsPresentationProvider>,
  );
  writeFileSync(
    path.join(process.cwd(), "e2e/fixtures/feed-needs-you-rows.html"),
    html,
  );
});
`;

const dir = mkdtempSync(
  path.join(process.cwd(), "__tests__", ".feed-fixture-"),
);
const testFile = path.join(dir, "capture-feed-fixture.test.tsx");
const vitestCli = path.join(
  process.cwd(),
  "node_modules",
  "vitest",
  "vitest.mjs",
);
writeFileSync(testFile, TEST_SOURCE);
try {
  execFileSync(process.execPath, [vitestCli, "run", testFile], {
    env: { ...process.env, TZ: "UTC" },
    stdio: "inherit",
  });
  console.log(
    "Wrote e2e/fixtures/feed-needs-you-rows.html from the real component.",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

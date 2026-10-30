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
import { MapPin } from "@/components/icons";
import path from "node:path";
import { afterEach, it, vi } from "vitest";

import { FeedActionableRow } from "@/components/feed/feed-actionable-row";
import { FeedSmsAlertGroup } from "@/components/feed/feed-sms-alert-group";
import { groupFeedSmsAlerts } from "@/lib/feed/feed-sms-grouping";
import { FeedDriveProgressRow } from "@/components/feed/feed-drive-progress-row";
import { FeedRow } from "@/components/feed/feed-row";
import { SettingsGroup, SettingsPresentationProvider } from "@/components/app-ui/settings-ui";
import {
  ownerConsentRequestActionable,
  type FeedActionable,
} from "@/lib/feed/use-feed-actionables";
import { groupPendingConsentRequests } from "@/lib/consent/owner-consent-request";

/**
 * The owner's consent request, built by the same projection the Feed uses: a
 * three-item ask from one person folds into ONE row with Details, Don't allow
 * and Allow. Three inline actions is the widest a Needs you row gets.
 */
const CONSENT_REQUEST_ROW: FeedActionable = ownerConsentRequestActionable(
  groupPendingConsentRequests(
    ["attr.food.preferences.*", "attr.food.dietary_restrictions.*", "attr.travel.preferences.*"].map(
      (scope, index) => ({
        id: "req-" + index,
        request_id: "req-" + index,
        kind: "incoming_request",
        status: "pending",
        action: "REQUESTED",
        scope,
        counterpart_type: "person",
        counterpart_id: "kushal",
        counterpart_label: "Kushal Trivedi",
        reason: "Picking a place for our dinner together",
        issued_at: "1786964640000",
        metadata: { bundle_id: "bundle-dinner", expiry_hours: 168 },
      }),
    ),
  )[0]!,
  {
    allow: async () => true,
    deny: async () => true,
    openDetails: () => {},
    onDecided: () => {},
    sortAt: 1786964640000,
  },
);

/**
 * The three rows the tester reported, with the widest action label in the set.
 * Row 1 is the reported one; row 2 is a chevron-only row; row 3 is the row that
 * looked fine in a wide screenshot and collides on every phone.
 */
const ROWS: FeedActionable[] = [
  CONSENT_REQUEST_ROW,
  {
    id: "extend",
    phoneActions: [{ key: "review", label: "Review", tone: "primary", run: () => {} }],
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
    phoneActions: [{ key: "review", label: "Review", tone: "primary", run: () => {} }],
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
  {
    id: "circle-invite", title: "Priya Nair", description: "Invited you to Family Circle.",
    displayTimestamp: Date.parse("2026-08-17T02:34:00Z"), sortAt: 0,
    icon: MapPin, iconTone: "orange",
    phoneActions: [{ key: "review", label: "Review", tone: "primary", run: () => {} }],
    actions: [
      { key: "decline", label: "Decline", tone: "ghost", confirm: true, run: () => {} },
      { key: "accept", label: "Accept", tone: "primary", run: () => {} },
    ],
  },
  {
    id: "android-connection", title: "A very long connection requester", description: "Wants to connect",
    sortAt: 0, icon: MapPin, iconTone: "orange",
    phoneActions: [
      { key: "report", label: "Report", tone: "danger", confirm: true, run: () => {} },
      { key: "review", label: "Review", tone: "primary", run: () => {} },
    ],
    actions: [
      { key: "report", label: "Report", tone: "danger", confirm: true, run: () => {} },
      { key: "decline", label: "Decline", tone: "ghost", confirm: true, run: () => {} },
      { key: "confirm", label: "Confirm", tone: "primary", run: () => {} },
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
      <SettingsGroup title="Live" separatorInset>
        {groupFeedSmsAlerts([0, 1, 2].map((index) => ({
          id: "sms-emergency:incident-" + index,
          smsEmergency: { senderId: "sms-sender" },
          person: { displayName: "A contact with a very long display name", photoUrl: null },
          title: "A contact with a very long display name",
          description: index === 0 ? "Emergency SMS · Active" : index === 1 ? "Emergency SMS · Revoked" : "Emergency SMS · Expired",
          emphasis: index === 0 ? "emergency" as const : undefined,
          href: index === 0 ? "/one/location?grantId=incident-0&open=1&section=shared" : null,
          chevron: index === 0,
          displayTimestamp: Date.parse("2026-08-17T03:04:00Z") - index * 86400000,
          sortAt: 3 - index,
          icon: MapPin, iconTone: "capability" as const, actions: [],
        }))).map((group) => <FeedSmsAlertGroup key={group.id} group={group} />)}
      </SettingsGroup>
      <SettingsGroup title="In progress" separatorInset>
        <FeedDriveProgressRow item={{ id: "queued", title: "Waiting to start", description: "Request allowed. The Drive search starts soon.", href: "/one/consents", requestedAt: 1786934040000, waiting: true }} />
        <FeedDriveProgressRow item={{ id: "unavailable", title: "Documents unavailable", description: "Estimate $1 · Couldn’t verify documents", href: "/one/consents", requestedAt: 1786934040000 }} />
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
      <SettingsGroup title="Agent outcomes" separatorInset>
        {["drive_share_unconfirmed", "drive_bulk_partial", "mail_mailbox_failed", "calendar_action_failed", "connector_reconnect_required"].map((eventType, index) => (
          <FeedRow key={eventType} onOpen={() => {}} item={{
            id: String(index + 20), source_domain: "connected_systems", event_type: eventType,
            actor_label: "Sample app", metadata: {}, read: false, created_at: "2026-08-17T02:34:00Z",
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

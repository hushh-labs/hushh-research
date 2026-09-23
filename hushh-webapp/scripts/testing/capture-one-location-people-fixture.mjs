/** Capture the real People-row and Circles-summary markup for browser layout QA. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const TEST_SOURCE = `
import { renderToStaticMarkup } from "react-dom/server";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";

import {
  CircleSummaryGroup,
  PersonRow,
} from "@/components/one-location/redesign/location-redesign-hub";

const circles = [
  { id: "a", name: "Family", memberCount: 3, role: "owner" },
  { id: "b", name: "Friends", memberCount: 5, role: "owner" },
  { id: "c", name: "Neighbors", memberCount: 4, role: "owner" },
  { id: "d", name: "Team", memberCount: 6, role: "member" },
] as any;

it("captures production People UI for browser layout checks", () => {
  const html = renderToStaticMarkup(
    <div data-people-fixture className="mx-auto w-full max-w-[768px] space-y-4 px-4 py-6">
      <CircleSummaryGroup
        circles={circles}
        invitationCount={0}
        onOpenCircles={() => {}}
        onOpenInvitations={() => {}}
      />
      <div className="space-y-2" data-people-rows>
        <PersonRow name="Ankit Hussh" subtitle={null} active={false} first onOpen={() => {}} onAsk={() => {}} onShare={() => {}} />
        <PersonRow name="A very long connection name that needs graceful truncation" subtitle="Sharing with you · 42 min left" active={true} first={false} onOpen={() => {}} onAsk={() => {}} onShare={() => {}} />
        <PersonRow name="JHUMMA KUMARI" subtitle="Connected" active={false} first={false} onOpen={() => {}} onAsk={() => {}} onShare={() => {}} shareReady={false} />
      </div>
    </div>,
  );
  writeFileSync(path.join(process.cwd(), "e2e/fixtures/one-location-people-rows.html"), html);
});
`;

const dir = mkdtempSync(path.join(process.cwd(), "__tests__", ".people-fixture-"));
const testFile = path.join(dir, "capture-people-fixture.test.tsx");
const vitestCli = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
writeFileSync(testFile, TEST_SOURCE);
try {
  execFileSync(process.execPath, [vitestCli, "run", testFile], {
    env: { ...process.env, TZ: "UTC" },
    stdio: "inherit",
  });
  console.log("Wrote e2e/fixtures/one-location-people-rows.html from the real components.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

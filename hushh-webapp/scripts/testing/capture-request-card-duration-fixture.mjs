/**
 * Regenerate e2e/fixtures/request-card-duration-rows.html from the REAL
 * component.
 *
 * The layout spec beside that fixture measures the new duration-override
 * picker on RequestCard (the location-request approval card): does it fit
 * without overflow at phone widths, does it keep the Approve/Decline buttons
 * a real touch target, does it visually stack cleanly above them.
 *
 * Run it whenever cards.tsx's RequestCard changes shape:
 *
 *   node scripts/testing/capture-request-card-duration-fixture.mjs
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

import { RequestCard } from "@/components/one-location/redesign/cards";

const DURATION_OPTIONS = [
  { value: "0.25", label: "15 min" },
  { value: "0.5", label: "30 min" },
  { value: "1", label: "1 hour" },
  { value: "3", label: "3 hours" },
  { value: "4", label: "4 hours" },
  { value: "24", label: "24 hours" },
];

const ROWS = [
  {
    id: "with-picker-short-name",
    props: {
      name: "Abdul Rashid",
      promptLine: "Asks to see your location for 3 hours",
      approveLabel: "Approve 3 hours",
      onApprove: () => {},
      onDecline: () => {},
      durationOptions: DURATION_OPTIONS,
      durationSeed: "3",
    },
  },
  {
    // The longest realistic display name this app renders elsewhere
    // (e2e/fixtures/feed-needs-you-rows.html uses the same one), against the
    // widest realistic reason text, to stress the card at 320px.
    id: "with-picker-long-name-and-reason",
    props: {
      name: "Sharuk Khan Abdulrahman",
      promptLine: "Asks to see your location for 24 hours",
      reason: "Meeting a new client near the airport this evening, want you to know where I am the whole time",
      approveLabel: "Approve 24 hours",
      onApprove: () => {},
      onDecline: () => {},
      durationOptions: DURATION_OPTIONS,
      durationSeed: "24",
    },
  },
  {
    // "Until I stop" ask: no picker at all, single-button approval unchanged.
    id: "no-picker-until-stopped",
    props: {
      name: "Abdul Rashid",
      promptLine: "Asks to see your location until you stop",
      approveLabel: "Approve until you stop",
      onApprove: () => {},
      onDecline: () => {},
    },
  },
];

it("captures the RequestCard duration-picker rows", () => {
  const html = ROWS.map(
    (row) =>
      \`<div id="\${row.id}" style="margin-bottom:16px;max-width:400px;">\${renderToStaticMarkup(<RequestCard {...row.props} />)}</div>\`,
  ).join("\\n");
  writeFileSync(
    path.join(process.cwd(), "e2e/fixtures/request-card-duration-rows.html"),
    html + "\\n",
  );
});
`;

const dir = mkdtempSync(path.join(tmpdir(), "request-card-fixture-"));
const testFile = path.join(process.cwd(), "__tests__", "__capture-request-card-fixture.test.tsx");
writeFileSync(testFile, TEST_SOURCE);
try {
  execFileSync("npx", ["vitest", "run", testFile], { stdio: "inherit" });
  console.log("Wrote e2e/fixtures/request-card-duration-rows.html from the real component.");
} finally {
  rmSync(testFile, { force: true });
  rmSync(dir, { recursive: true, force: true });
}

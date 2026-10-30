// The wiring that makes a received share explain itself.
//
// `grantViewErrors` in the Location page was written on every one of the
// five-second poll's outcomes and read by exactly one renderer -- inside the
// retired legacy block, which `USE_LOCATION_REDESIGN` makes unreachable at
// runtime (see the comment above that early return). So the page computed a
// reason for every recipient sitting in front of an empty card, and threw it
// away. That is invisible from the page in isolation: nothing errors, nothing
// warns, the state just goes nowhere.
//
// A source contract rather than a render test for the same reason as
// `one-location-recovery-placement.contract.test.ts`: the hub is an internal of
// a 3000-line module wired to a view model with well over a hundred fields, and
// the page it is fed from is larger still. The behaviour of the card itself is
// covered by `shared-with-me-card.test.tsx`; what is guarded here is the join
// between them, which is the part that was actually missing.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const HUB = path.join(
  process.cwd(),
  "components/one-location/redesign/location-redesign-hub.tsx",
);
const PAGE = path.join(process.cwd(), "app/one/location/page.tsx");

const hubSource = readFileSync(HUB, "utf8");
const pageSource = readFileSync(PAGE, "utf8");

describe("received-share view status reaches the screen", () => {
  it("the page hands its computed statuses to the hub view model", () => {
    // The whole defect in one line. Without it the page keeps computing
    // statuses no one will ever see.
    expect(pageSource).toMatch(/grantViewStatuses:\s*grantViewErrors/);
  });

  it("the hub hands them to the card", () => {
    expect(hubSource).toContain("viewStatus=");
    expect(hubSource).toMatch(/vm\.grantViewStatuses\?\.\[grant\.id\]/);
  });

  it("the status is suppressed once a point is on screen", () => {
    // A decrypted point IS the answer. Leaving "waiting for their first
    // update" underneath a live map contradicts what the person is looking at.
    const index = hubSource.indexOf("viewStatus=");
    const around = hubSource.slice(index, index + 260);
    expect(around).toMatch(/point\s*\?\s*null/);
  });

  it("keeps waiting and blocked as distinct tones", () => {
    // These are not two flavours of the same message. Waiting is a healthy
    // share; blocked needs the owner to act. Collapsing them is what let a
    // normal not-ready-yet state get reported as a failure for months.
    expect(pageSource).toMatch(/tone:\s*"waiting"/);
    expect(pageSource).toMatch(/tone:\s*"blocked"/);
  });

  it("records a reason when an explicit tap fails", () => {
    // A toast disappears. If tapping View is the only way to learn anything,
    // a recipient's only recourse is to tap it again, which is precisely the
    // retry behaviour the receiving side already shows too much of.
    const index = pageSource.indexOf("Could not view this private location");
    expect(index).toBeGreaterThan(-1);
    const around = pageSource.slice(index, index + 600);
    expect(around).toContain("setGrantViewErrors");
    expect(around).toMatch(/tone:\s*"blocked"/);
  });

  it("stays quiet on the background poll", () => {
    // The five-second poll must not paint an alert over content that is about
    // to refresh itself. Only the `!silent` branch may record a status.
    const index = pageSource.indexOf(
      "[OneLocationAgent] Silent location refresh skipped:",
    );
    expect(index).toBeGreaterThan(-1);
    const silentBranch = pageSource.slice(index - 400, index);
    expect(silentBranch).not.toContain("setGrantViewErrors");
  });
});

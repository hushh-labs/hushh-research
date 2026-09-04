import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getKaiActionById } from "@/lib/voice/kai-action-gateway";

/**
 * The hands-free lane has to say the same thing the screen says.
 *
 * Sharing again with somebody who can already see you REPLACES their live
 * share rather than extending it, so a shorter duration ends time that was
 * already given. The confirm step states that and makes the owner agree in a
 * dialog. `location.share_selected` never touches that button — it calls
 * `handleShare` directly — so without its own guard the highest-risk lane on
 * this surface was the one lane that still cut a live share silently.
 *
 * `confirm_required` does not cover it: the runtime's confirmation is built
 * from the action's slots (who, how long), and there is no slot in which to
 * say "and Aarti loses an hour and forty-five minutes". The loss has to be
 * computed by the handler and spoken before the share runs.
 *
 * A source contract rather than a rendered one. Driving this handler for real
 * means mounting a 14k-line client page plus the onboarding action runtime,
 * which tests the mocks more than the rule. What must not silently disappear
 * is the ORDER: the check comes before the share.
 */

const PAGE_SOURCE = fs.readFileSync(
  path.resolve(__dirname, "../..", "app/one/location/page.tsx"),
  "utf8",
);

/** The body of the `location.share_selected` local action handler. */
function shareSelectedHandler(): string {
  const start = PAGE_SOURCE.indexOf(
    'useLocalOnboardingActionHandler("location.share_selected"',
  );
  expect(start).toBeGreaterThan(-1);
  const end = PAGE_SOURCE.indexOf("useLocalOnboardingActionHandler", start + 1);
  return PAGE_SOURCE.slice(start, end > -1 ? end : start + 8000);
}

describe("the spoken share states what it would take away", () => {
  it("keeps the action gated behind a confirmation at all", () => {
    // The precondition for everything below. If this ever became
    // allow_direct, a misheard sentence could end a live share outright.
    expect(getKaiActionById("location.share_selected")?.execution_policy).toBe(
      "confirm_required",
    );
  });

  it("checks for a share it would cut short BEFORE it shares", () => {
    const handler = shareSelectedHandler();
    const check = handler.indexOf("shareReplacementsLosingTime");
    const share = handler.indexOf("await handleShare(");

    expect(check).toBeGreaterThan(-1);
    expect(share).toBeGreaterThan(-1);
    // Order is the whole rule. A check that runs after the request has gone
    // out is a report, not a guard.
    expect(check).toBeLessThan(share);
  });

  it("refuses the first time and names who loses time", () => {
    const handler = shareSelectedHandler();

    // Refuses rather than shares. `blocked` is the shape this surface already
    // uses for "ask me something before I do this".
    expect(handler).toContain('status: "blocked" as const');
    // Says whose time, not just that something would change -- and says it as
    // a sentence for both kinds of live share, since "Aarti can see you for
    // Until you stop" is not one.
    expect(handler).toContain("can see you for ${remaining}");
    expect(handler).toContain("can see you until you stop");
    // And says how to go ahead, so the refusal is not a dead end.
    expect(handler).toMatch(/Say it again to go ahead/);
  });

  it("lets the same ask through on the second try, and never a later one", () => {
    const handler = shareSelectedHandler();

    // The affirmative is the ask itself, remembered as recipients+duration so
    // agreeing to shorten one person's share cannot silently agree to
    // shorten somebody else's.
    expect(handler).toContain("shareReplacementAcknowledgedRef");
    expect(handler).toContain("const replacementKey = ");
    expect(handler).toMatch(/selectedRecipientIds\].sort\(\).join\(","\)/);
    // Spent once used: a later share is a new decision.
    expect(handler).toContain("shareReplacementAcknowledgedRef.current = null");
  });
});

/**
 * The tapped lane's half of the same rule.
 *
 * The dialog and the notice have their own rendered tests, but what those
 * cannot see is whether the confirm step still ROUTES through them. Deleting
 * one line -- restoring `onClick={vm.onConfirmShare}` -- would leave every
 * other test in the suite green while the share posted straight past the
 * warning, which is exactly the state this branch exists to end.
 */
const HUB_SOURCE = fs.readFileSync(
  path.resolve(
    __dirname,
    "../..",
    "components/one-location/redesign/location-redesign-hub.tsx",
  ),
  "utf8",
);

describe("the tapped share cannot post past its own warning", () => {
  it("routes Start sharing through the confirm dialog when time would be lost", () => {
    const cta = HUB_SOURCE.indexOf('data-voice-control-id="one-location-confirm-share"');
    expect(cta).toBeGreaterThan(-1);
    // The handler sits directly above the marker on the same element.
    const button = HUB_SOURCE.slice(Math.max(0, cta - 700), cta);

    expect(button).toContain("shareReplacementRows.length");
    expect(button).toContain("setShareReplacementConfirmOpen(true)");
    // Still the plain post when nothing is at stake -- a warning that gates
    // every share would be a warning nobody reads.
    expect(button).toContain("vm.onConfirmShare()");
    // The bare wiring must not come back.
    expect(HUB_SOURCE).not.toContain("onClick={vm.onConfirmShare}");
  });

  it("computes the rows against a clock resynced on entering the step", () => {
    // The clock starts at flow mount. Somebody who spent ten minutes picking
    // people arrives with a ten-minute-old "now", and the comparison below
    // decides whether a live share is about to be cut short.
    expect(HUB_SOURCE).toContain("shareReplacementsLosingTime");
    const effect = HUB_SOURCE.slice(
      HUB_SOURCE.indexOf('if (step !== "details") return;'),
    ).slice(0, 260);
    expect(effect).toContain("setNowMs(Date.now());");
  });

  it("closes the dialog when there is no longer anything to confirm", () => {
    // Leaving the step, or de-selecting the person whose share was at risk,
    // both make it a question about nothing.
    expect(HUB_SOURCE).toContain("shareReplacementCount");
    expect(HUB_SOURCE).toContain("setShareReplacementConfirmOpen(false)");
  });
});

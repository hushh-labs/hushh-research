// @vitest-environment jsdom
//
// Taking back a location request you sent.
//
// Reported from QA: "maine 2 logo se request location kiya, so status is
// showing asked. should i allow do delete as well -- my concern is if i
// request location to someone, amendment should be allowed??"
//
// It was not. A sent request had two ways out and the asker held neither: the
// owner approves, or the owner denies. A wrong name or a changed mind was
// permanent until the other side happened to answer.
//
// Two surfaces show a sent request, so both are checked here: the person row
// on Request location, and the "Requests sent" list on the hub. The hub's
// flows are internals of a ~3000-line module, so their wiring is asserted as a
// source contract -- the pattern this repo already uses for hub placement --
// while the row's own behaviour is rendered for real.

import { readFileSync } from "node:fs";
import path from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TrustedPersonCard } from "@/components/one-location/redesign/cards";

const HUB = path.join(
  process.cwd(),
  "components/one-location/redesign/location-redesign-hub.tsx",
);
const source = readFileSync(HUB, "utf8");

/** The body of a top-level `function <name>(` declaration. */
function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} not found in the hub`).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("the row for someone you already asked", () => {
  it("announces ending the ask, not ending their access", () => {
    // The same X ends a live share on other rows. Announcing a withdrawal as
    // "remove their access" tells a screen-reader user the opposite of what
    // the button does -- nobody has any access to remove yet.
    render(
      <TrustedPersonCard
        name="Abdul Rashid"
        subtitle="Asked just now, waiting on them"
        tone="pending"
        statusLabel="Asked"
        onRemove={vi.fn()}
        removeAriaLabel="Take back your request to Abdul Rashid"
      />,
    );
    expect(
      screen.getByLabelText("Take back your request to Abdul Rashid"),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/Remove .* access/)).toBeNull();
  });

  it("still says access when the row really is a live share", () => {
    // The default has to survive: most rows carrying this control are shares.
    render(
      <TrustedPersonCard name="Neelesh Meena" onRemove={vi.fn()} />,
    );
    expect(screen.getByLabelText("Remove Neelesh Meena's access")).toBeTruthy();
  });

  it("cannot be fired twice while the first one is still going", () => {
    const onRemove = vi.fn();
    render(
      <TrustedPersonCard
        name="Parth Mawai"
        onRemove={onRemove}
        removeBusy
        removeAriaLabel="Take back your request to Parth Mawai"
      />,
    );
    fireEvent.click(
      screen.getByLabelText("Take back your request to Parth Mawai"),
    );
    expect(onRemove).not.toHaveBeenCalled();
  });
});

describe("Request location wires the take-back to the pending ask", () => {
  const ask = functionBody("AskFlow");

  it("offers it on a row whose request is still unanswered", () => {
    expect(ask).toContain("vm.onWithdrawRequest(pendingRequestId)");
    expect(ask).toContain("const pendingRequestId = status.pendingRequestId");
  });

  it("no longer wires a live grant's X to revoke on this screen", () => {
    // Ending a share you're receiving already has a home: Shared with me's
    // own X calls the same vm.onStopGrant. A second X here was a redundant
    // entry point to the identical action, so Request location's X is now
    // only ever the pending-request withdrawal.
    expect(ask).not.toContain("vm.onStopGrant(activeGrant.id)");
  });

  it("spins on the request being taken back, not on a grant id", () => {
    // A pending request has no grant, so keying its busy state off
    // `revokingGrantId` would leave the button live through the whole call.
    expect(ask).toContain("vm.withdrawingRequestId === pendingRequestId");
  });
});

describe("the Requests sent list", () => {
  it("gives a pending row a way out instead of only naming its state", () => {
    // The trailing slot used to be the bare word "Pending": the state was
    // reported, and there was nothing to do about it.
    expect(source).toContain("Take back");
    expect(source).toContain("vm.onWithdrawRequest(request.id)");
  });

  it("does not put a word beside the button", () => {
    // Measured, not preferred. "Pending" plus the button came to 161px in a
    // `shrink-0` trailing slot, against the shipped Edit/Stop pair's 115px --
    // enough to wrap the person's name onto a second line at 320px and grow
    // the row from 70px to 166px.
    //
    // The sibling contract in e2e/ measures that, but it measures a CAPTURED
    // fixture: re-adding the word here would not change the fixture and would
    // not turn it red. This assertion is what closes that gap, so the two are
    // load-bearing together, not redundant.
    const pendingBranch = source
      .slice(
        source.indexOf('request.status === "pending" ?'),
        source.indexOf("requestStatusWord(request.status)"),
      )
      // The comment explaining the decision says "Pending" itself.
      .replace(/^\s*\/\/.*$/gm, "");
    expect(pendingBranch.trim().length).toBeGreaterThan(0);
    expect(pendingBranch).not.toContain("Pending");
    expect(pendingBranch).not.toContain("MUTED_TEXT");
  });

  it("stops calling a settled request pending", () => {
    // Everything not live read "Pending", so a request the person had already
    // withdrawn still claimed to be waiting on somebody.
    expect(source).toContain("requestStatusWord(request.status)");
    expect(source).toContain('if (status === "cancelled") return "Taken back"');
  });
});

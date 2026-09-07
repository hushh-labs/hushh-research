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
// Two surfaces manage a sent request: the searchable Ask roster and the
// People actions sheet. Both use the same withdrawal callback. The hub's
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
    render(<TrustedPersonCard name="Neelesh Meena" onRemove={vi.fn()} />);
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

describe("Ask for location wires take-back to its searchable roster", () => {
  const ask = functionBody("AskFlow");

  it("offers pending request management on the matching person", () => {
    expect(ask).toContain("showStateActions && pendingRequestId");
    expect(ask).toContain("Take back your request to ${recipientLabel}");
    expect(ask).toContain("vm.onWithdrawRequest(pendingRequestId)");
  });

  it("keeps the live-share revoke on rows that have a grant", () => {
    // One control, two acts, decided by which state the row is in. Losing the
    // grant branch would turn every "stop sharing" into a request withdrawal.
    expect(ask).toContain("vm.onStopGrant(activeGrant.id)");
  });

  it("spins on the request being taken back, not on a grant id", () => {
    // A pending request has no grant, so keying its busy state off
    // `revokingGrantId` would leave the button live through the whole call.
    expect(ask).toContain("vm.withdrawingRequestId === pendingRequestId");
  });
});

describe("People request management", () => {
  const people = functionBody("PeopleHub");
  const actions = functionBody("PersonActionsDialog");

  it("cancels the selected request through the person actions sheet", () => {
    expect(people).toContain("void vm.onWithdrawRequest(selectedPendingRequest.id)");
    expect(people).toContain("onCancelRequest=");
    expect(actions).toContain("onClick={onCancelRequest}");
  });

  it("disables cancellation while the selected request is being withdrawn", () => {
    expect(actions).toContain('title={cancelBusy ? "Cancelling…" : "Cancel request"}');
    expect(actions).toContain("disabled={cancelBusy}");
    expect(actions).toContain("withdrawingRequestId === pendingRequest?.id");
  });

  it("does not present expired cached requests as pending", () => {
    expect(people).toContain("isLocationRequestPending(request, vm.nowMs)");
    expect(people).toContain("[vm.nowMs, vm.requestedByMe]");
    const ask = functionBody("AskFlow");
    expect(ask).toContain("isLocationRequestPending(request, statusNowMs)");
    expect(ask).toContain("[statusNowMs, vm.requestedByMe]");
  });
});

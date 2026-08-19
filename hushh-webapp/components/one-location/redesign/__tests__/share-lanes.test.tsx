// @vitest-environment jsdom
//
// One row per PERSON, one control per SHARE (#5506).
//
// The backend now scopes replacement of a live location share to a lane --
// the emergency one (`shareKind === "sos"`) and everything else -- so a pair
// can hold two live grants at once. Every surface that lists people used to
// equate one grant with one person: the People row bound its single Stop to
// `activeOwnerGrants.find(...)`, which is whichever grant came first, and the
// recipient's "Shared with me" rendered the same name as two separate cards.
//
// Shipping the backend half without this would turn a silent full revoke into
// a silent half revoke, which is the same consent bug wearing a different hat.

import { readFileSync } from "node:fs";
import path from "node:path";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SharedWithMeCard } from "@/components/one-location/redesign/cards";
import { PersonShareLanes } from "@/components/one-location/redesign/share-lanes";
import {
  grantLaneLabel,
  groupGrantsByCounterpart,
} from "@/lib/one-location/grant-lanes";
import type { OneLocationGrant } from "@/lib/one-location/types";

function grant(overrides: Partial<OneLocationGrant> = {}): OneLocationGrant {
  return {
    id: "grant_ordinary",
    ownerUserId: "user_a",
    recipientUserId: "user_b",
    recipientKeyId: "key_b",
    status: "active",
    consentScope: "cap.location.live.view",
    capabilityScopes: ["cap.location.live.view"],
    durationHours: 4,
    createdAt: "2026-08-16T09:30:00.000Z",
    expiresAt: "2026-08-16T13:30:00.000Z",
    shareKind: "share",
    ...overrides,
  };
}

const ordinary = grant();
const sos = grant({
  id: "grant_sos",
  shareKind: "sos",
  durationHours: 8,
  expiresAt: "2026-08-16T18:00:00.000Z",
});

describe("grouping grants by the person on the other end", () => {
  it("puts one person's two shares in ONE group, and names each lane", () => {
    const groups = groupGrantsByCounterpart([sos, ordinary], "owner");

    expect(groups).toHaveLength(1);
    expect(groups[0]?.counterpartUserId).toBe("user_b");
    expect(groups[0]?.grants.map((g) => g.id)).toEqual([
      "grant_sos",
      "grant_ordinary",
    ]);
    expect(groups[0]?.smsGrant?.id).toBe("grant_sos");
    expect(groups[0]?.ordinaryGrant?.id).toBe("grant_ordinary");
    // The caller's order decides what leads, so an existing sort (received
    // grants already float SMS-triggered shares to the top) keeps deciding.
    expect(groups[0]?.primaryGrant.id).toBe("grant_sos");
  });

  it("keeps two different people apart", () => {
    const groups = groupGrantsByCounterpart(
      [ordinary, grant({ id: "to_c", recipientUserId: "user_c" })],
      "owner",
    );
    expect(groups.map((g) => g.counterpartUserId)).toEqual([
      "user_b",
      "user_c",
    ]);
  });

  it("groups the OTHER end when you are the recipient", () => {
    const groups = groupGrantsByCounterpart(
      [
        grant({ id: "from_c", ownerUserId: "user_c" }),
        grant({ id: "from_c_sos", ownerUserId: "user_c", shareKind: "sos" }),
      ],
      "recipient",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.counterpartUserId).toBe("user_c");
  });

  it("never merges two grants that have no counterpart id into one person", () => {
    // A split row is cosmetic. A merged row would wire one person's Stop to
    // another person's share, so the ambiguous case has to over-split.
    const groups = groupGrantsByCounterpart(
      [
        grant({ id: "anon_1", recipientUserId: "" }),
        grant({ id: "anon_2", recipientUserId: "" }),
      ],
      "owner",
    );
    expect(groups).toHaveLength(2);
  });

  it("labels the SMS lane with the copy the recipient's card already uses", () => {
    expect(grantLaneLabel(sos)).toBe("Shared via SMS");
    expect(grantLaneLabel(ordinary)).toBe("Location share");
  });
});

describe("per-share Stop inside a person's row", () => {
  it("stops ONLY its own lane's grant", () => {
    // The whole of #5506, made operable. Stopping the SMS share here is the
    // same grant id through the same revoke the Emergency screen's "Stop
    // sharing" calls, and the ordinary share keeps its own countdown.
    const onStopGrant = vi.fn();
    const [group] = groupGrantsByCounterpart([sos, ordinary], "owner");

    render(
      <PersonShareLanes
        group={group!}
        counterpartName="Rohan Mehta"
        onStopGrant={onStopGrant}
      />,
    );

    const rows = screen.getAllByTestId("one-location-share-lane");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute("data-share-lane"))).toEqual([
      "sos",
      "ordinary",
    ]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Stop the SMS share with Rohan Mehta",
      }),
    );
    expect(onStopGrant).toHaveBeenCalledTimes(1);
    expect(onStopGrant).toHaveBeenCalledWith("grant_sos");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Stop the location share with Rohan Mehta",
      }),
    );
    expect(onStopGrant).toHaveBeenCalledTimes(2);
    expect(onStopGrant).toHaveBeenLastCalledWith("grant_ordinary");
  });

  it("disables only the share actually being revoked", () => {
    const [group] = groupGrantsByCounterpart([sos, ordinary], "owner");
    render(
      <PersonShareLanes
        group={group!}
        counterpartName="Rohan Mehta"
        onStopGrant={vi.fn()}
        revokingGrantId="grant_sos"
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Stop the SMS share with Rohan Mehta",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: "Stop the location share with Rohan Mehta",
      }),
    ).not.toBeDisabled();
  });

  it("offers no Stop at all on the receiving side", () => {
    // A recipient cannot revoke somebody else's grant server-side, so the
    // breakdown they see is the honest list and nothing more.
    const [group] = groupGrantsByCounterpart([sos, ordinary], "recipient");
    render(
      <PersonShareLanes
        group={group!}
        counterpartName="Rohan Mehta"
        formatEndsAt={() => "6:00 PM"}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Stop/ })).toBeNull();
    expect(screen.getAllByText("Access until 6:00 PM")).toHaveLength(2);
  });
});

describe("one card per owner in Shared with me", () => {
  it("carries the SMS badge and both shares behind one name", () => {
    const [group] = groupGrantsByCounterpart([sos, ordinary], "recipient");
    render(
      <SharedWithMeCard
        isSmsTriggered={Boolean(group?.smsGrant)}
        name="Rohan Mehta"
        statusLine="2 live shares"
        onView={vi.fn()}
        shareLanes={
          <div data-testid="one-location-received-share-lanes">
            <PersonShareLanes
              group={group!}
              counterpartName="Rohan Mehta"
              formatEndsAt={(value) =>
                value === sos.expiresAt ? "6:00 PM" : "1:30 PM"
              }
            />
          </div>
        }
      />,
    );

    // ONE name, not two cards for the same person.
    expect(screen.getAllByText("Rohan Mehta")).toHaveLength(1);
    // The badge is the treatment `isSmsTriggeredGrant` already drives here --
    // no new copy was invented for the grouped case. Twice: the card's badge
    // and the lane's own label, and they say the same words on purpose.
    expect(screen.getAllByText("Shared via SMS")).toHaveLength(2);
    // Both underlying shares, each with its OWN expiry. A single folded status
    // line could only ever have been right about one of them.
    expect(screen.getByTestId("one-location-received-share-lanes")).toBeTruthy();
    expect(screen.getAllByTestId("one-location-share-lane")).toHaveLength(2);
    expect(screen.getByText("Access until 6:00 PM")).toBeTruthy();
    expect(screen.getByText("Access until 1:30 PM")).toBeTruthy();
  });

  it("renders no breakdown at all for a single share", () => {
    render(
      <SharedWithMeCard
        isSmsTriggered={false}
        name="Rohan Mehta"
        statusLine="Access until 1:30 PM"
        onView={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("one-location-share-lane")).toBeNull();
    expect(screen.queryByText("Shared via SMS")).toBeNull();
  });
});

// The hub's people list and its detail flows are internals of a ~4000-line
// module, so their wiring is asserted as a source contract -- the pattern this
// repo already uses for hub placement -- while the pieces above are rendered
// for real.
const HUB = path.join(
  process.cwd(),
  "components/one-location/redesign/location-redesign-hub.tsx",
);
const source = readFileSync(HUB, "utf8");

describe("hub wiring", () => {
  it("no longer binds a person's Stop to the FIRST grant it can find", () => {
    // `activeOwnerGrants.find((g) => g.recipientUserId === r.userId)` is the
    // exact shape of the bug: one tap, one grant stopped, the other left live
    // with nothing on screen admitting it exists.
    expect(source).not.toContain("(g) => g.recipientUserId === r.userId");
    expect(source).toContain("ownerGroupsByUserId.get(r.userId)");
  });

  it("renders every people-listing surface from grouped grants", () => {
    // Active shares, People and Shared with me all group first. A surface that
    // went back to mapping the raw grant list would render one person twice.
    expect(source).toContain(
      'groupGrantsByCounterpart(vm.activeOwnerGrants, "owner")',
    );
    expect(source).toContain(
      'groupGrantsByCounterpart(vm.receivedGrants, "recipient")',
    );
    expect(source).toContain("{ownerGrantGroups.map((group) => {");
    expect(source).toContain("{receivedGrantGroups.map((group) => {");
    expect(source).not.toContain("{vm.receivedGrants.map((grant) => {");
    expect(source).not.toContain("{vm.activeOwnerGrants.map((grant) => (");
  });

  it("keeps the one-tap Stop for a person with a single share", () => {
    // The common case must not have grown a step: the chevron appears only for
    // somebody who genuinely holds two.
    expect(source).toContain("group.grants.length === 1");
    expect(source).toContain("shareGroup.grants.length === 1");
  });
});

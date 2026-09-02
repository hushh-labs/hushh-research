// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCircles: vi.fn(),
  ensureTrusted: vi.fn(),
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  createNamedCircle: vi.fn(),
  getCircle: vi.fn(),
  listCircleMembersPage: vi.fn(),
  toastError: vi.fn(),
  searchParams: new URLSearchParams("tab=circles"),
  vaultOwnerToken: "vault-token" as string | null,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.routerPush,
    replace: mocks.routerReplace,
    back: vi.fn(),
  }),
  useSearchParams: () => mocks.searchParams,
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    listCircles: mocks.listCircles,
    ensureTrustedSystemCircle: mocks.ensureTrusted,
    createNamedCircle: mocks.createNamedCircle,
    resolveNamedCircleCode: vi.fn(),
    joinNamedCircle: vi.fn(),
    getCircle: mocks.getCircle,
    getCircleOverview: mocks.getCircle,
    listCircleMembersPage: mocks.listCircleMembersPage,
    updateNamedCircle: vi.fn(),
    createNamedCircleInviteCode: vi.fn(),
    listNamedCircleEligibleConnections: vi.fn(async () => ({
      eligibleConnections: [],
      pendingInvites: [],
      remainingCapacity: 0,
    })),
    listNamedCircleEligibleConnectionsPage: vi.fn(async () => ({
      eligibleConnections: [],
      pendingInvites: [],
      remainingCapacity: 0,
      page: 1,
      hasMore: false,
      totalCount: 0,
    })),
    createNamedCircleMemberInvites: vi.fn(),
    cancelNamedCircleMemberInvite: vi.fn(),
    removeNamedCircleMember: vi.fn(),
    leaveNamedCircle: vi.fn(),
    deleteNamedCircle: vi.fn(),
  },
}));

// The tab reads the context directly rather than through `useVault()`, because
// that hook throws outside a provider and this tab must degrade to "circles are
// unavailable" rather than take the Connect page down with it.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useContext: (context: unknown) =>
      context === VaultContextRef.current
        ? { vaultOwnerToken: mocks.vaultOwnerToken }
        : actual.useContext(context as never),
  };
});

import { VaultContext } from "@/lib/vault/vault-context";

const VaultContextRef = { current: VaultContext as unknown };

import {
  ConnectCirclesTab,
  circleRowDescription,
  orderCircles,
} from "@/components/connect/circles/connect-circles-tab";

function circle(
  id: string,
  name: string,
  memberCount: number,
  systemKind: "trusted" | "sms" | null = null,
  role: "owner" | "member" = "owner",
) {
  return {
    id,
    name,
    kind: "other" as const,
    role,
    memberCount,
    memberLimit: systemKind === "trusted" ? null : 100,
    isSystem: systemKind === "sms",
    systemKind,
    createdAt: null,
    updatedAt: null,
    viewerCapabilities: {
      canInviteMembers: true,
      canViewInviteCode: systemKind === null,
      canRotateInviteCode: systemKind === null,
      canManageCircle: true,
      canModerateInvites: true,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.vaultOwnerToken = "vault-token";
  mocks.listCircles.mockResolvedValue([]);
  mocks.ensureTrusted.mockResolvedValue({});
  mocks.searchParams = new URLSearchParams("tab=circles");
  mocks.createNamedCircle.mockResolvedValue({
    id: "new-circle",
    name: "Roommates",
  });
  mocks.getCircle.mockResolvedValue({
    id: "mine",
    name: "Roommates",
    kind: "other",
    role: "owner",
    memberCount: 1,
    memberLimit: 100,
    viewerCapabilities: {
      canInviteMembers: true,
      canViewInviteCode: true,
      canRotateInviteCode: true,
      canManageCircle: true,
      canModerateInvites: true,
      canDeleteCircle: true,
      canLeaveCircle: false,
    },
    members: [
      {
        userId: "owner-user",
        displayName: "Owner",
        role: "owner",
        phoneVerified: true,
        secureLocationReady: true,
      },
    ],
  });
  mocks.listCircleMembersPage.mockResolvedValue({
    items: [],
    page: 1,
    hasMore: false,
    totalCount: 0,
  });
});

describe("circleRowDescription", () => {
  it("counts everyone except the viewer", () => {
    // "3 people" reading as two others and yourself is the answer to a question
    // nobody asked. The Location list already excludes the viewer; these two
    // now agree.
    expect(circleRowDescription(circle("c", "K Family", 4))).toBe("3 people");
    expect(circleRowDescription(circle("c", "K Family", 2))).toBe("1 person");
    expect(circleRowDescription(circle("c", "K Family", 1))).toBe(
      "No members yet",
    );
  });

  it("says what a product-managed Circle is for, never what kind it is", () => {
    // "Family · 0 members" was removed from the Location row because the Circle
    // onboarding creates is filed under Family by default and the person was
    // never asked. These lines answer the question a Circle you did not create
    // actually raises.
    expect(circleRowDescription(circle("t", "Trusted", 8, "trusted"))).toBe(
      "Everyone you're connected to · 7 people",
    );
    expect(circleRowDescription(circle("s", "SMS Circle", 4, "sms"))).toBe(
      "Gets your SMS · 3 people",
    );
  });

  it("reads honestly when a system Circle is still empty", () => {
    expect(circleRowDescription(circle("t", "Trusted", 1, "trusted"))).toBe(
      "Everyone you're connected to",
    );
    expect(circleRowDescription(circle("s", "SMS Circle", 1, "sms"))).toBe(
      "Gets your SMS · no one yet",
    );
  });

  it("keeps the server's name for an SMS Circle you are only a member of", () => {
    // An SMS Circle appears in the list of everyone ON it. The server renames
    // the ones you do not own -- "Alice's SMS Circle" -- because three
    // friends' rosters would otherwise be three identical rows.
    const theirs = circle("s", "Alice's SMS Circle", 4, "sms", "member");
    expect(circleRowDescription(theirs)).toBe("You'll get their SMS");
  });

  it("never tells a member it is their own SMS", () => {
    const theirs = circle("s", "Alice's SMS Circle", 4, "sms", "member");
    // SMS is Save my Soul, this product's own name for the lane; "SOS" is the
    // server's word and is never shown to a person. Both are checked so the
    // rename cannot regress in either direction.
    expect(circleRowDescription(theirs)).not.toContain("your SMS");
    expect(circleRowDescription(theirs)).not.toMatch(/SOS/i);
  });

  it("still recognises an SMS Circle from a server that predates systemKind", () => {
    const legacy = { ...circle("s", "SMS Circle", 3, "sms"), systemKind: null };
    expect(circleRowDescription(legacy)).toBe("Gets your SMS · 2 people");
  });
});

describe("orderCircles", () => {
  it("separates circles you own from circles you joined", () => {
    // What is yours and what you joined, answerable at a glance rather than per
    // row -- with your product-managed circles still pinned first.
    const { owned, joined } = orderCircles([
      circle("mine", "Roommates", 3),
      circle("family", "Family", 2, null, "member"),
      circle("their-sms", "Alice's SMS Circle", 4, "sms", "member"),
      circle("sms", "SMS Circle", 4, "sms", "owner"),
      circle("trusted", "Trusted", 20, "trusted"),
    ]);

    expect(owned.map((c) => c.id)).toEqual(["trusted", "sms", "mine"]);
    expect(joined.map((c) => c.id)).toEqual(["family", "their-sms"]);
  });
});

describe("ConnectCirclesTab", () => {
  it("shows your Circles separately from joined Circles", async () => {
    mocks.listCircles.mockResolvedValue([
      circle("mine", "Roommates", 3),
      circle("joined", "Family", 2, null, "member"),
      circle("trusted", "Trusted", 20, "trusted"),
      circle("sms", "SMS Circle", 4, "sms"),
      circle("their-sms", "Alice's SMS Circle", 4, "sms", "member"),
    ]);

    render(<ConnectCirclesTab />);

    const owned = await screen.findByTestId("connect-circle-group-owned");
    const joined = screen.getByTestId("connect-circle-group-joined");

    expect(within(owned).getByText("Your circles")).toBeTruthy();
    expect(within(owned).getByText("Trusted")).toBeTruthy();
    expect(within(owned).getByText("SMS Circle")).toBeTruthy();
    expect(within(owned).getByText("Roommates")).toBeTruthy();
    expect(within(owned).queryByText("Family")).toBeNull();

    expect(within(joined).getByText("Joined circles")).toBeTruthy();
    expect(within(joined).getByText("Family")).toBeTruthy();
    expect(within(joined).getByText("Alice's SMS Circle")).toBeTruthy();
    expect(within(joined).queryByText("Roommates")).toBeNull();
    expect(screen.getByTestId("connect-circle-trusted")).toBeTruthy();
    const smsCircle = within(owned).getByTestId("connect-circle-sms");
    expect(smsCircle).toBeTruthy();
    expect(smsCircle.querySelector("[data-one-sms-text-icon]")).toBeTruthy();
  });

  it("gives the SMS Circle the same red mark Location's People tab gives it", async () => {
    // Reported: the same Circle looked like two different things depending on
    // which tab you opened. Location's People tab draws a filled red disc
    // reading "SMS"; this list drew a `Siren` glyph in the same indigo well it
    // gives Trusted and every user-made Circle, so the one row whose whole
    // point is that it behaves differently in an emergency read as another
    // ordinary group.
    //
    // Upstream landed the same fix while this branch was in review, with a
    // shared `SmsTextIcon` and the destructive token instead of a literal hex.
    // The claim is unchanged, so it is asserted against what ships.
    mocks.listCircles.mockResolvedValue([
      circle("trusted", "Trusted", 20, "trusted"),
      circle("sms", "SMS Circle", 4, "sms"),
    ]);

    render(<ConnectCirclesTab />);

    const smsRow = await screen.findByTestId("connect-circle-sms");
    const mark = within(smsRow).getByText("SMS");
    const disc = mark.parentElement!;
    // Red, round and filled -- the identity, not a tinted utility well.
    expect(disc.className).toContain("bg-[color:var(--app-destructive)]");
    expect(disc.className).toContain("rounded-full");
    // 28px, because these rows are `density="compact"` and that is the size of
    // the icon well beside them. Location's list draws the same disc at 36px,
    // which is the size of ITS rows -- dropping that one in here would make
    // the SMS row taller than its neighbours and push it past the compact
    // separator's 58px inset.
    expect(disc.className).toContain("h-7");
    expect(disc.className).toContain("w-7");

    // The indigo utility well is gone from this row, and only this row.
    expect(smsRow.querySelector('[data-slot="settings-row-icon"]')).toBeNull();
    const trustedIcon = screen
      .getByTestId("connect-circle-trusted")
      .querySelector('[data-slot="settings-row-icon"]');
    expect(trustedIcon).not.toBeNull();
    expect(trustedIcon).toHaveAttribute("data-icon-tone", "indigo");
  });

  it("marks every SMS Circle on the list, not only the one you own", async () => {
    // An SMS Circle appears in the list of everyone ON it, so a viewer can see
    // several. The mark is per row, not a badge on the first system Circle.
    mocks.listCircles.mockResolvedValue([
      circle("theirs", "Alice's SMS Circle", 4, "sms", "member"),
      circle("mine", "SMS Circle", 3, "sms", "owner"),
    ]);

    render(<ConnectCirclesTab />);

    await screen.findByText("Alice's SMS Circle");
    expect(screen.getAllByText("SMS")).toHaveLength(2);
  });

  it("renders the server's name for a Circle you do not own", async () => {
    mocks.listCircles.mockResolvedValue([
      circle("theirs", "Alice's SMS Circle", 4, "sms", "member"),
      circle("mine", "SMS Circle", 3, "sms", "owner"),
    ]);

    render(<ConnectCirclesTab />);

    // Two rows, two different names -- not two rows both reading "SMS Circle".
    expect(await screen.findByText("Alice's SMS Circle")).toBeTruthy();
    expect(screen.getByText("SMS Circle")).toBeTruthy();
  });

  it("never names a category the person did not pick", async () => {
    mocks.listCircles.mockResolvedValue([
      { ...circle("mine", "Roommates", 3), kind: "family" as const },
    ]);
    const view = render(<ConnectCirclesTab />);

    await screen.findByText("Roommates");
    expect(view.container.textContent).not.toMatch(/\bFamily\b/);
    expect(view.container.textContent).not.toMatch(/\bFriends\b/);
  });

  it("offers both ways to get another one, in their own group", async () => {
    render(<ConnectCirclesTab />);

    // Zero named Circles is never an empty screen: the two ways forward sit
    // below whatever list there is, so they do not move as it grows.
    expect(await screen.findByTestId("connect-circle-create")).toBeTruthy();
    expect(screen.getByTestId("connect-circle-join")).toBeTruthy();
  });

  it("names the real next step when there is no vault yet", async () => {
    // A LOCKED vault never reaches this branch -- the guard shows its unlock
    // dialog first. The one audience for a null token is somebody who has no
    // vault yet, so "unlock" was false for exactly the person reading it, and
    // the row was disabled with the create/join group withheld beside it.
    mocks.vaultOwnerToken = null;

    render(<ConnectCirclesTab />);

    expect(await screen.findByText("Finish setting up One")).toBeTruthy();
    expect(screen.queryByText("Unlock One to see your circles")).toBeNull();
    expect(mocks.listCircles).not.toHaveBeenCalled();
    expect(mocks.ensureTrusted).not.toHaveBeenCalled();
    // And no controls that cannot work without a vault.
    expect(screen.queryByTestId("connect-circle-create")).toBeNull();
  });

  it("sends that row to setup rather than leaving it inert", async () => {
    mocks.vaultOwnerToken = null;

    render(<ConnectCirclesTab />);

    (await screen.findByText("Finish setting up One")).click();

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    expect(String(mocks.routerPush.mock.calls[0][0])).toContain("/one/setup");
  });

  it("lets a failed load be retried", async () => {
    // Nothing else on this branch can bump the token: the flows that do are
    // unreachable from an error state, and an inbound notification is not
    // something the reader can trigger.
    mocks.listCircles.mockRejectedValueOnce(new Error("boom"));

    render(<ConnectCirclesTab />);

    const row = await screen.findByText("Circles are unavailable");
    expect(mocks.listCircles).toHaveBeenCalledTimes(1);

    mocks.listCircles.mockResolvedValue([circle("mine", "Roommates", 3)]);
    row.click();

    expect(await screen.findByText("Roommates")).toBeTruthy();
  });

  it("reconciles Trusted before it reads the list", async () => {
    // The accept hook covers a NEW connection. It cannot cover the ones a
    // person already had -- without this call they open the tab to no Trusted
    // Circle at all, and after their next accept to one holding a single name
    // under the words "Everyone you're connected to".
    const order: string[] = [];
    mocks.ensureTrusted.mockImplementation(async () => {
      order.push("reconcile");
      return {};
    });
    mocks.listCircles.mockImplementation(async () => {
      order.push("list");
      return [];
    });

    render(<ConnectCirclesTab />);

    await waitFor(() => expect(order).toEqual(["reconcile", "list"]));
    expect(mocks.ensureTrusted).toHaveBeenCalledWith({
      vaultOwnerToken: "vault-token",
      summaryOnly: true,
    });
  });

  it("still shows the circles when the reconcile fails", async () => {
    // A reconcile that fails must not cost the list. An older server with no
    // such route, a rate limit, a dropped request -- the Circles they already
    // have are still worth showing, and the next open tries again.
    mocks.ensureTrusted.mockRejectedValue(new Error("404"));
    mocks.listCircles.mockResolvedValue([circle("mine", "Roommates", 3)]);

    render(<ConnectCirclesTab />);

    expect(await screen.findByText("Roommates")).toBeTruthy();
    expect(screen.queryByText("Circles are unavailable")).toBeNull();
  });

  it("says so when circles cannot be loaded", async () => {
    mocks.listCircles.mockRejectedValue(new Error("boom"));

    render(<ConnectCirclesTab />);

    expect(await screen.findByText("Circles are unavailable")).toBeTruthy();
  });

  it("reports what it is doing, so the page can describe the screen", async () => {
    mocks.listCircles.mockResolvedValue([circle("mine", "Roommates", 3)]);
    const onStateChange = vi.fn();

    render(<ConnectCirclesTab onStateChange={onStateChange} />);

    await waitFor(() =>
      expect(onStateChange).toHaveBeenCalledWith({
        loading: false,
        error: null,
        count: 1,
      }),
    );
  });

  it("opens a circle without leaving Connect", async () => {
    mocks.listCircles.mockResolvedValue([circle("mine", "Roommates", 3)]);

    render(<ConnectCirclesTab />);
    (await screen.findByText("Roommates")).click();

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const href = String(mocks.routerPush.mock.calls[0][0]);
    expect(href).toContain("/one/connect");
    expect(href).toContain("tab=circles");
    expect(href).toContain("action=circle-detail");
    expect(href).toContain("circleId=mine");
    // The thing this replaced. `/one/location` runs a first-run onboarding
    // takeover that no query parameter bypasses, so a person who had never
    // used Location was shown "Share your location easily with anyone" after
    // asking to open a group of friends.
    expect(href).not.toContain("/one/location");
  });

  it("keeps New circle and Join with code on Connect", async () => {
    render(<ConnectCirclesTab />);

    (await screen.findByText("New circle")).click();
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const createHref = String(mocks.routerPush.mock.calls[0][0]);
    expect(createHref).toContain("/one/connect");
    expect(createHref).toContain("action=create-circle");
    expect(createHref).not.toContain("/one/location");

    mocks.routerPush.mockClear();
    screen.getByText("Join with code").click();
    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    const joinHref = String(mocks.routerPush.mock.calls[0][0]);
    expect(joinHref).toContain("/one/connect");
    expect(joinHref).toContain("action=join-circle");
    expect(joinHref).not.toContain("/one/location");
  });

  it("names the tab explicitly on every navigation", async () => {
    // The App Router refuses a navigation whose only change is the whole query
    // string disappearing, so `tab=circles` is written out even when closing a
    // flow -- otherwise back out of a Circle is a dead press.
    mocks.listCircles.mockResolvedValue([circle("mine", "Roommates", 3)]);

    render(<ConnectCirclesTab />);
    (await screen.findByText("Roommates")).click();

    await waitFor(() => expect(mocks.routerPush).toHaveBeenCalled());
    expect(String(mocks.routerPush.mock.calls[0][0])).toContain("tab=circles");
  });
});

describe("the flows are hosted on Connect, not linked away to Location", () => {
  it("renders Create a circle in place when ?action=create-circle", async () => {
    // The whole point. Before this, the same tap was a router.push into
    // /one/location, where a first-run onboarding takeover -- decided without
    // reading any query parameter -- rendered instead.
    mocks.searchParams = new URLSearchParams(
      "tab=circles&action=create-circle",
    );

    render(<ConnectCirclesTab />);

    expect(
      await screen.findByTestId("one-location-create-circle-flow"),
    ).toBeTruthy();
    expect(screen.queryByTestId("connect-circles-tab")).toBeNull();
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("renders Join with code in place, with a shared code pre-filled", async () => {
    mocks.searchParams = new URLSearchParams(
      "tab=circles&action=join-circle&code=2345-6789-ABCD",
    );

    render(<ConnectCirclesTab />);

    expect(
      await screen.findByTestId("one-location-join-circle-flow"),
    ).toBeTruthy();
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("renders circle detail in place when ?action=circle-detail", async () => {
    mocks.searchParams = new URLSearchParams(
      "tab=circles&action=circle-detail&circleId=mine",
    );

    render(<ConnectCirclesTab />);

    expect(
      await screen.findByTestId("one-location-circle-detail-flow"),
    ).toBeTruthy();
    expect(mocks.getCircle).toHaveBeenCalled();
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("an unknown action falls back to the list rather than a blank screen", async () => {
    mocks.searchParams = new URLSearchParams("tab=circles&action=nonsense");

    render(<ConnectCirclesTab />);

    expect(await screen.findByTestId("connect-circles-tab")).toBeTruthy();
  });

  it("shows the list, not a flow, when circle-detail carries no id", async () => {
    mocks.searchParams = new URLSearchParams(
      "tab=circles&action=circle-detail",
    );

    render(<ConnectCirclesTab />);

    expect(await screen.findByTestId("connect-circles-tab")).toBeTruthy();
  });
});

describe("a roster row on Connect behaves like a directory row", () => {
  beforeEach(() => {
    mocks.searchParams = new URLSearchParams(
      "tab=circles&action=circle-detail&circleId=mine",
    );
    mocks.getCircle.mockResolvedValue({
      id: "mine",
      name: "Roommates",
      kind: "other",
      role: "owner",
      memberCount: 2,
      memberLimit: 100,
      viewerCapabilities: {
        canInviteMembers: true,
        canViewInviteCode: true,
        canRotateInviteCode: true,
        canManageCircle: true,
        canModerateInvites: true,
      },
      members: [
        {
          userId: "owner-user",
          displayName: "Owner",
          role: "owner",
          phoneVerified: true,
          secureLocationReady: true,
        },
        {
          userId: "stranger-user",
          displayName: "Sharu Khan",
          role: "member",
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "none",
        },
      ],
    });
    mocks.listCircleMembersPage.mockResolvedValue({
      items: [
        {
          userId: "owner-user",
          displayName: "Owner",
          role: "owner",
          phoneVerified: true,
          secureLocationReady: true,
        },
        {
          userId: "stranger-user",
          displayName: "Sharu Khan",
          role: "member",
          phoneVerified: true,
          secureLocationReady: true,
          relationship: "none",
        },
      ],
      page: 1,
      hasMore: false,
      totalCount: 2,
    });
  });

  it("opens the capability review instead of sending outright", async () => {
    // `config/protected-behaviors.json` names this review, and the directory
    // shows it even on an empty catalog because "a request that grants nothing
    // is worth saying out loud". A Circle roster was the one place in the app
    // that skipped it.
    const onRequestConnection = vi.fn();
    render(<ConnectCirclesTab onRequestConnection={onRequestConnection} />);

    fireEvent.click(
      await screen.findByTestId("circle-member-connect-stranger-user"),
    );

    await waitFor(() => expect(onRequestConnection).toHaveBeenCalled());
    expect(onRequestConnection.mock.calls[0][0]).toMatchObject({
      userId: "stranger-user",
      displayName: "Sharu Khan",
    });
  });

  it("refuses rather than sending when no review is available", async () => {
    // Never fall back to a bare send. Silence would be better than a request
    // the person never saw the terms of.
    render(<ConnectCirclesTab />);

    fireEvent.click(
      await screen.findByTestId("circle-member-connect-stranger-user"),
    );

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  });

  it("re-reads the roster when the page says something changed", async () => {
    // A request sent through the sheet leaves the row behind it stale: it
    // still says Connect when the answer is now Requested.
    const view = render(<ConnectCirclesTab refreshToken={0} />);
    await waitFor(() => expect(mocks.getCircle).toHaveBeenCalledTimes(1));

    view.rerender(<ConnectCirclesTab refreshToken={1} />);

    await waitFor(() => expect(mocks.getCircle).toHaveBeenCalledTimes(2));
  });
});

describe("somebody else acting on your Circle", () => {
  it("re-reads when circle news arrives, without a page reload", async () => {
    // A person joining with a code, accepting an invitation, or being added by
    // another owner changes this list without the viewer touching anything.
    // Until this listener the only way to see it was to reload the page --
    // while the Location agent, on the same event, had always refreshed.
    mocks.searchParams = new URLSearchParams("tab=circles");
    render(<ConnectCirclesTab />);
    await waitFor(() => expect(mocks.listCircles).toHaveBeenCalledTimes(1));

    window.dispatchEvent(
      new CustomEvent("consent-state-changed", {
        detail: { source: "one_location_notification" },
      }),
    );

    await waitFor(() => expect(mocks.listCircles).toHaveBeenCalledTimes(2));
  });

  it("ignores news that has nothing to do with circles", async () => {
    // Every consent change in the app fires this event. Re-reading on all of
    // them would put a request behind unrelated activity.
    mocks.searchParams = new URLSearchParams("tab=circles");
    render(<ConnectCirclesTab />);
    await waitFor(() => expect(mocks.listCircles).toHaveBeenCalledTimes(1));

    window.dispatchEvent(
      new CustomEvent("consent-state-changed", {
        detail: { source: "gmail_receipts", notificationType: "gmail_synced" },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.listCircles).toHaveBeenCalledTimes(1);
  });
});

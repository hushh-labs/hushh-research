// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCircles: vi.fn(),
  ensureTrusted: vi.fn(),
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  createNamedCircle: vi.fn(),
  getCircle: vi.fn(),
  searchParams: new URLSearchParams("tab=circles"),
  vaultOwnerToken: "vault-token" as string | null,
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
    updateNamedCircle: vi.fn(),
    createNamedCircleInviteCode: vi.fn(),
    listNamedCircleEligibleConnections: vi.fn(async () => ({
      eligibleConnections: [],
      pendingInvites: [],
      remainingCapacity: 0,
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
  mocks.createNamedCircle.mockResolvedValue({ id: "new-circle", name: "Roommates" });
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
      "Gets your SOS text · 3 people",
    );
  });

  it("reads honestly when a system Circle is still empty", () => {
    expect(circleRowDescription(circle("t", "Trusted", 1, "trusted"))).toBe(
      "Everyone you're connected to",
    );
    expect(circleRowDescription(circle("s", "SMS Circle", 1, "sms"))).toBe(
      "Gets your SOS text · no one yet",
    );
  });

  it("keeps the server's name for an SMS Circle you are only a member of", () => {
    // An SMS Circle appears in the list of everyone ON it. The server renames
    // the ones you do not own -- "Alice's SMS Circle" -- because three
    // friends' rosters would otherwise be three identical rows.
    const theirs = circle("s", "Alice's SMS Circle", 4, "sms", "member");
    expect(circleRowDescription(theirs)).toBe("You'll get their SOS text");
  });

  it("never tells a member it is their own SOS text", () => {
    const theirs = circle("s", "Alice's SMS Circle", 4, "sms", "member");
    expect(circleRowDescription(theirs)).not.toContain("your SOS");
  });

  it("still recognises an SMS Circle from a server that predates systemKind", () => {
    const legacy = { ...circle("s", "SMS Circle", 3, "sms"), systemKind: null };
    expect(circleRowDescription(legacy)).toBe("Gets your SOS text · 2 people");
  });
});

describe("orderCircles", () => {
  it("puts Trusted first, then SMS, then the ones you made", () => {
    // What is yours and what is the app's, answerable at a glance rather than
    // per row -- and Trusted first because it is what a person opens this tab
    // to see.
    const { system, owned } = orderCircles([
      circle("mine", "Roommates", 3),
      circle("sms", "SMS Circle", 4, "sms"),
      circle("trusted", "Trusted", 20, "trusted"),
    ]);

    expect(system.map((c) => c.id)).toEqual(["trusted", "sms"]);
    expect(owned.map((c) => c.id)).toEqual(["mine"]);
  });
});

describe("ConnectCirclesTab", () => {
  it("shows the system Circles above the ones you made", async () => {
    mocks.listCircles.mockResolvedValue([
      circle("mine", "Roommates", 3),
      circle("trusted", "Trusted", 20, "trusted"),
      circle("sms", "SMS Circle", 4, "sms"),
    ]);

    render(<ConnectCirclesTab />);

    expect(await screen.findByText("Trusted")).toBeTruthy();
    expect(screen.getByText("SMS Circle")).toBeTruthy();
    expect(screen.getByText("Roommates")).toBeTruthy();
    expect(screen.getByTestId("connect-circle-trusted")).toBeTruthy();
    expect(screen.getByTestId("connect-circle-sms")).toBeTruthy();
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

  it("degrades to a sentence when the vault is locked", async () => {
    // Connect has never touched the vault and its tests do not mock one. A
    // locked vault must cost the circles list, not the whole page.
    mocks.vaultOwnerToken = null;

    render(<ConnectCirclesTab />);

    expect(
      await screen.findByText("Unlock One to see your circles"),
    ).toBeTruthy();
    expect(mocks.listCircles).not.toHaveBeenCalled();
    expect(mocks.ensureTrusted).not.toHaveBeenCalled();
    // And no controls that cannot work.
    expect(screen.queryByTestId("connect-circle-create")).toBeNull();
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
    mocks.searchParams = new URLSearchParams("tab=circles&action=create-circle");

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
    mocks.searchParams = new URLSearchParams("tab=circles&action=circle-detail");

    render(<ConnectCirclesTab />);

    expect(await screen.findByTestId("connect-circles-tab")).toBeTruthy();
  });
});

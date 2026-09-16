import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The area router: one screen per `?view=` / `?action=`, inside the shell
 * with the Location PageHeader; tabs only on hub views; an unknown action
 * lands on Now with a toast and a corrected URL.
 */

const harness = vi.hoisted(() => ({
  search: "" as string,
  push: vi.fn(),
  replace: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: harness.push, replace: harness.replace }),
  useSearchParams: () => new URLSearchParams(harness.search),
  usePathname: () => "/one/location",
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "me",
    user: null,
    loading: false,
    isAuthenticated: true,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vault-token", vaultKey: "key" }),
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: harness.toast }));

const { stub } = vi.hoisted(() => ({
  stub: (id: string) =>
    function Stub(props: Record<string, unknown>) {
      return <div data-testid={id} data-props={JSON.stringify(props)} />;
    },
}));

vi.mock("@/components/location/location-home", () => ({
  LocationHome: stub("screen-home"),
  LocationActiveSharesScreen: stub("screen-active-shares"),
  LocationSharedWithMeScreen: stub("screen-shared-with-me"),
  LocationNeedsReviewScreen: stub("screen-needs-review"),
  useLocationWorkspaceState: () => ({
    userId: "me",
    vaultOwnerToken: "vault-token",
    state: null,
    status: "loading",
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/location/people/location-people", () => ({
  LocationPeople: stub("screen-people"),
}));
vi.mock("@/components/location/settings/location-settings", () => ({
  LocationSettings: stub("screen-settings"),
}));
vi.mock("@/components/location/ask/ask-for-location-flow", () => ({
  AskForLocationFlow: stub("screen-ask"),
}));
vi.mock("@/components/location/share/share-location-flow", () => ({
  ShareLocationFlow: stub("screen-share"),
}));
vi.mock("@/components/location/circles/location-circles", () => ({
  LocationCircles: stub("screen-circles"),
}));
vi.mock("@/components/location/circles/circle-detail", () => ({
  CircleDetail: stub("screen-circle-detail"),
}));
vi.mock("@/components/location/circles/create-circle-flow", () => ({
  CreateCircleFlow: stub("screen-create-circle"),
}));
vi.mock("@/components/location/circles/invite-to-circle-flow", () => ({
  InviteToCircleFlow: stub("screen-invite-circle"),
}));
vi.mock("@/components/location/links/location-links", () => ({
  LocationLinks: stub("screen-links"),
}));
vi.mock("@/components/location/check-in/check-in-flow", () => ({
  CheckInFlow: stub("screen-check-in"),
}));
vi.mock("@/components/location/sos/save-my-soul", () => ({
  SaveMySoul: stub("screen-sos"),
}));
vi.mock("@/components/location/ratings/place-ratings", () => ({
  PlaceRatings: stub("screen-ratings"),
}));
vi.mock("@/components/location/setup/location-setup-flow", () => ({
  LocationSetupFlow: stub("screen-setup"),
}));
vi.mock(
  "@/components/one-location/redesign/circles/named-circle-flows",
  () => ({
    JoinCircleFlow: stub("legacy-join-circle"),
  }),
);
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    resolveNamedCircleCode: vi.fn(),
    joinNamedCircle: vi.fn(),
  },
}));

import {
  GONE_TOAST,
  LocationArea,
  resolveLocationAreaRoute,
} from "@/components/location/location-area";

function propsOf(testId: string): Record<string, unknown> {
  return JSON.parse(
    screen.getByTestId(testId).getAttribute("data-props") ?? "{}",
  );
}

describe("LocationArea", () => {
  beforeEach(() => {
    harness.search = "";
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("mounts Now inside the shell with the Location header and tabs by default", () => {
    render(<LocationArea />);
    expect(screen.getByTestId("location-area-header")).toHaveTextContent(
      "Location",
    );
    expect(screen.getByTestId("screen-home")).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Now",
      "People",
      "Circles",
      "Links",
    ]);
    expect(screen.getByRole("tab", { name: "Now" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("switches hub views by ?view= and passes the focused person to People", () => {
    harness.search = "view=people&person=u2";
    render(<LocationArea />);
    expect(screen.getByTestId("screen-people")).toBeInTheDocument();
    expect(propsOf("screen-people")).toEqual({ focusedUserId: "u2" });
    expect(screen.getByRole("tab", { name: "People" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it.each([
    ["view=circles", "screen-circles"],
    ["view=links", "screen-links"],
    ["action=share&person=u2", "screen-share"],
    ["action=ask&person=u2", "screen-ask"],
    ["action=settings", "screen-settings"],
    ["action=check-in&person=u2", "screen-check-in"],
    ["action=sos", "screen-sos"],
    ["action=create-circle", "screen-create-circle"],
    ["action=circle-detail&circle=c1", "screen-circle-detail"],
    ["action=invite-circle&circle=c1", "screen-invite-circle"],
    ["action=active-shares", "screen-active-shares"],
    ["action=shared-with-me", "screen-shared-with-me"],
    ["action=needs-review", "screen-needs-review"],
    ["action=ratings", "screen-ratings"],
    ["action=join-circle", "legacy-join-circle"],
    ["action=invite&circle=c1", "screen-invite-circle"],
  ])("mounts the right screen for ?%s", (search, testId) => {
    harness.search = search;
    render(<LocationArea />);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
    if (search.startsWith("action=")) {
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
    }
  });

  it("passes ids to the flows that need them and never renders them as text", () => {
    harness.search = "action=share&person=u2";
    render(<LocationArea />);
    expect(propsOf("screen-share")).toEqual({ personId: "u2" });
    expect(screen.getByTestId("location-area")).not.toHaveTextContent("u2");
  });

  it("lands an unknown action on Now with a toast and corrects the URL", async () => {
    harness.search = "action=teleport";
    render(<LocationArea />);
    expect(screen.getByTestId("screen-home")).toBeInTheDocument();
    await waitFor(() =>
      expect(harness.toast.info).toHaveBeenCalledWith(GONE_TOAST),
    );
    expect(harness.replace).toHaveBeenCalledWith("/one/location?view=now", {
      scroll: false,
    });
  });

  it("treats a circle flow without its circle id as gone", () => {
    expect(
      resolveLocationAreaRoute({
        view: null,
        action: "circle-detail",
        person: null,
        circle: null,
      }),
    ).toEqual({ kind: "gone", raw: "circle-detail" });
    expect(
      resolveLocationAreaRoute({
        view: null,
        action: "circle-detail",
        person: null,
        circle: "c1",
      }),
    ).toEqual({
      kind: "action",
      action: "circle-detail",
      personId: null,
      circleId: "c1",
    });
  });

  it("renders the setup flow in setup mode", () => {
    render(<LocationArea mode="setup" />);
    expect(screen.getByTestId("screen-setup")).toBeInTheDocument();
    expect(propsOf("screen-setup")).toEqual({ mode: "setup" });
    expect(screen.queryByTestId("location-area-header")).toBeNull();
  });
});

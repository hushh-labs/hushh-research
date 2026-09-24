// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextType } from "react";
import type {
  OneLocationCircleDetail,
  OneLocationCircleSummary,
} from "@/lib/one-location/types";
import { LivingConnections } from "../living-connections";
import {
  CIRCLE_STARTERS,
  findStarterCircle,
  type ConnectCirclesSnapshot,
} from "../circle-discovery";
import { VaultContext } from "@/lib/vault/vault-context";
import { DASHBOARD_AGENT_ICON_STYLE_BY_ID } from "@/lib/design/home-icon-palette";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  sms: vi.fn(),
  push: vi.fn(),
  publish: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    createNamedCircle: mocks.create,
    ensureSmsSystemCircle: mocks.sms,
  },
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onOneLocationStateMutated: mocks.publish },
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: { promise: mocks.toast },
}));
vi.mock("@/lib/observability/client", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/vault/vault-context", async () => {
  const { createContext } = await import("react");
  return { VaultContext: createContext(null) };
});

const circle = (
  overrides: Partial<OneLocationCircleSummary> = {},
): OneLocationCircleSummary => ({
  id: "finance-id",
  name: "Finance Circle",
  kind: "other",
  role: "owner",
  memberCount: 1,
  memberLimit: 100,
  ...overrides,
});
const ready: ConnectCirclesSnapshot = {
  ownerId: "owner",
  loading: false,
  error: null,
  count: 0,
  available: true,
  circles: [],
};
const callbacks = {
  onFindPeople: vi.fn(),
  onCreateCircle: vi.fn(),
  onRetry: vi.fn(),
  onRetryCircles: vi.fn(),
};
const ui = (snapshot = ready, token: string | null = "test-token") => (
  <VaultContext.Provider
    value={{ vaultOwnerToken: token } as ContextType<typeof VaultContext>}
  >
    <LivingConnections
      currentUserId="owner"
      ownerName="Test Owner"
      connections={[]}
      totalCount={0}
      loading={false}
      error={false}
      circlesState={snapshot}
      {...callbacks}
    />
  </VaultContext.Provider>
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue(circle());
  mocks.sms.mockResolvedValue(
    circle({
      id: "sms-id",
      name: "SMS Circle",
      systemKind: "sms",
      isSystem: true,
    }),
  );
});

describe("circle discovery actions", () => {
  it("reuses home icon colours while keeping selection and actions independent", () => {
    render(ui());
    const expected = {
      family: DASHBOARD_AGENT_ICON_STYLE_BY_ID.email,
      finance: DASHBOARD_AGENT_ICON_STYLE_BY_ID.finance,
      investor: DASHBOARD_AGENT_ICON_STYLE_BY_ID.ria,
      business: DASHBOARD_AGENT_ICON_STYLE_BY_ID.wallet,
      location: DASHBOARD_AGENT_ICON_STYLE_BY_ID.location,
      sms: DASHBOARD_AGENT_ICON_STYLE_BY_ID.gmail,
    };
    for (const [id, style] of Object.entries(expected)) {
      const node = screen.getByTestId(`circle-starter-${id}`);
      for (const [property, value] of Object.entries(style)) {
        expect(node.style.getPropertyValue(property)).toBe(value);
      }
      fireEvent.click(node);
      expect(node).toHaveAttribute("aria-pressed", "true");
      expect(
        screen
          .getByTestId("connect-living-connections")
          .style.getPropertyValue("--agent-icon-profile-bg"),
      ).toBe("");
      expect(
        screen.getByTestId("circle-discovery-preview").className,
      ).toContain("bg-[color:var(--app-secondary-surface)]");
      expect(
        screen.getByTestId("circle-discovery-orbit").querySelector("circle"),
      ).toHaveAttribute("fill", "none");
    }
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  it("explores without writes, guides zero connections and creates the selected starter once", async () => {
    let resolve!: (circle: OneLocationCircleDetail) => void;
    mocks.create.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(ui());
    fireEvent.click(
      screen.getByRole("button", { name: "Explore Finance Circle" }),
    );
    expect(screen.getByText(/your CA, financial advisor/)).toBeTruthy();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.getByText(/add people after they accept/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    expect(callbacks.onFindPeople).toHaveBeenCalledOnce();
    const create = screen.getByRole("button", {
      name: "Create Finance Circle",
    });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      vaultOwnerToken: "test-token",
      name: "Finance Circle",
      kind: "other",
    });
    await act(async () => {
      resolve(circle() as OneLocationCircleDetail);
    });
    expect(mocks.publish).toHaveBeenCalledWith(
      "owner",
      ["workspace", "circles", "sms_roster"],
      { notificationType: "location_circle_created", circleId: "finance-id" },
    );
    expect(mocks.push).toHaveBeenCalledWith(
      "/one/connect?tab=circles&action=circle-detail&circleId=finance-id",
      { scroll: false },
    );
    expect(screen.getByTestId("circle-discovery-primary")).toBeDisabled();
  });

  it("uses the real SMS system roster, never an ordinary circle named SMS", async () => {
    render(ui({ ...ready, circles: [circle({ name: "SMS Circle" })] }));
    fireEvent.click(screen.getByRole("button", { name: "Explore SMS Circle" }));
    fireEvent.click(screen.getByRole("button", { name: "Create SMS Circle" }));
    await waitFor(() =>
      expect(mocks.sms).toHaveBeenCalledExactlyOnceWith({
        vaultOwnerToken: "test-token",
      }),
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith(
      expect.stringContaining("circleId=sms-id"),
      { scroll: false },
    );
  });

  it("replaces the selected idea with the authoritative circle and updates its count without remounting", () => {
    const view = render(ui());
    fireEvent.click(
      screen.getByRole("button", { name: "Explore Finance Circle" }),
    );
    view.rerender(
      ui({ ...ready, count: 1, circles: [circle({ memberCount: 4 })] }),
    );
    expect(
      screen.getByRole("button", {
        name: "Explore Finance Circle, already created",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("4 people in your circle")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open circle" }));
    expect(mocks.create).not.toHaveBeenCalled();
    view.rerender(
      ui({ ...ready, count: 1, circles: [circle({ memberCount: 5 })] }),
    );
    expect(screen.getByText("5 people in your circle")).toBeTruthy();
    view.rerender(ui());
    expect(
      screen.getByRole("button", { name: "Create Finance Circle" }),
    ).toBeTruthy();
  });

  it("keeps a failed creation retryable", async () => {
    mocks.create.mockRejectedValueOnce(new Error("offline"));
    render(ui());
    fireEvent.click(
      screen.getByRole("button", { name: "Create Family Circle" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create Family Circle" }),
      ).toBeEnabled(),
    );
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Create Family Circle" }),
    );
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  });

  it("does not turn a loading or failed list into an empty list that allows duplicate creation", () => {
    const view = render(ui({ ...ready, loading: true }));
    expect(
      screen.getByRole("button", { name: "Loading circles…" }),
    ).toBeDisabled();
    view.rerender(ui({ ...ready, error: "unavailable" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry circles" }));
    expect(callbacks.onRetryCircles).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("drops a late successful action after the vault locks", async () => {
    let resolve!: (value: OneLocationCircleDetail) => void;
    mocks.create.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(ui());
    fireEvent.click(
      screen.getByRole("button", { name: "Create Family Circle" }),
    );
    view.rerender(ui(ready, null));
    await act(async () => {
      resolve(circle() as OneLocationCircleDetail);
    });
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not show summaries from another owner", () => {
    render(ui({ ...ready, ownerId: "someone-else", circles: [circle()] }));
    expect(
      screen.queryByRole("button", { name: /already created/ }),
    ).toBeNull();
  });

  it("routes missing vault access to setup rather than an ineffective list retry", () => {
    render(ui(ready, null));
    expect(screen.queryByRole("button", { name: "Retry circles" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Finish setting up One" }),
    );
    expect(mocks.push).toHaveBeenCalledWith("/one/setup");
  });

  it("opens the saved circle and keeps duplicate protection when cross-tab notification fails", async () => {
    mocks.publish.mockImplementationOnce(() => {
      throw new Error("BroadcastChannel unavailable");
    });
    render(ui());
    fireEvent.click(
      screen.getByRole("button", { name: "Create Family Circle" }),
    );
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        expect.stringContaining("circleId=finance-id"),
        { scroll: false },
      ),
    );
    expect(screen.getByTestId("circle-discovery-primary")).toBeDisabled();
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});

describe("starter identity", () => {
  it("does not infer purpose from other, joined circles or system-circle names", () => {
    const finance = CIRCLE_STARTERS.find((item) => item.id === "finance")!;
    expect(
      findStarterCircle(
        [circle({ name: "Work group" }), circle({ role: "member" })],
        finance,
      ),
    ).toBeUndefined();
    expect(
      findStarterCircle([circle({ systemKind: "trusted" })], finance),
    ).toBeUndefined();
    expect(
      findStarterCircle([circle({ name: " Finance " })], finance)?.id,
    ).toBe("finance-id");
  });
});

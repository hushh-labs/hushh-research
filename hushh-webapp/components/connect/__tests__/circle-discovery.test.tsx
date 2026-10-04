// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  sms: vi.fn(),
  listMembers: vi.fn(),
  push: vi.fn(),
  publish: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    createNamedCircle: mocks.create,
    ensureSmsSystemCircle: mocks.sms,
    listCircleMembersPage: mocks.listMembers,
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
  mocks.listMembers.mockResolvedValue({
    items: [],
    page: 1,
    hasMore: false,
    totalCount: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("circle discovery actions", () => {
  it("shows all six starters without writing and keeps Custom circle wired", () => {
    render(ui());
    expect(
      screen.getAllByRole("button", { name: /^Setup .* circle$/ }),
    ).toHaveLength(6);
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Create your own circle" }),
    );
    expect(callbacks.onCreateCircle).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: "Find people to connect with" }),
    );
    expect(callbacks.onFindPeople).toHaveBeenCalledOnce();
  });

  it("creates the requested starter once and opens the saved circle", async () => {
    let resolve!: (value: OneLocationCircleDetail) => void;
    mocks.create.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(ui());
    const create = screen.getByRole("button", { name: "Setup Finance circle" });
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
    expect(create).toBeDisabled();
  });

  it("uses the SMS system roster rather than a similarly named custom circle", async () => {
    render(ui({ ...ready, circles: [circle({ name: "SMS Circle" })] }));
    fireEvent.click(screen.getByRole("button", { name: "Setup SMS circle" }));
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

  it("shows Open only for the current owner's saved starter and updates after removal", () => {
    const view = render(ui({ ...ready, circles: [circle()] }));
    expect(screen.queryByText("Ready")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Finance circle" }),
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith(
      expect.stringContaining("circleId=finance-id"),
      { scroll: false },
    );
    view.rerender(ui());
    expect(
      screen.getByRole("button", { name: "Setup Finance circle" }),
    ).toBeEnabled();
  });

  it("keeps a failed creation retryable", async () => {
    mocks.create.mockRejectedValueOnce(new Error("offline"));
    render(ui());
    fireEvent.click(
      screen.getByRole("button", { name: "Setup Family circle" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Setup Family circle" }),
      ).toBeEnabled(),
    );
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Setup Family circle" }),
    );
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  });

  it("does not turn a loading or failed list into an empty list that allows duplicate creation", () => {
    const view = render(ui({ ...ready, loading: true }));
    expect(
      screen.getByRole("button", { name: "Setup Family circle" }),
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
      screen.getByRole("button", { name: "Setup Family circle" }),
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
    expect(screen.queryByRole("button", { name: /Open Finance/ })).toBeNull();
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
      screen.getByRole("button", { name: "Setup Family circle" }),
    );
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        expect.stringContaining("circleId=finance-id"),
        { scroll: false },
      ),
    );
    expect(
      screen.getByRole("button", { name: "Setup Family circle" }),
    ).toBeDisabled();
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

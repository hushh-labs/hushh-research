import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveQueryView } from "@/lib/services/drive-sharing-service";

const state = vi.hoisted(() => ({
  uid: "a",
  unlocked: true,
  token: "owner-a",
  epoch: 1,
  getToken: vi.fn(),
  invalidate: vi.fn(),
  periodic: vi.fn(),
  service: {
    getQuery: vi.fn(),
    allowQuery: vi.fn(),
    denyQuery: vi.fn(),
    cancelQuery: vi.fn(),
    // Drive-reading and file-review calls of the document flow. A question
    // card must never touch them.
    prepare: vi.fn(),
    review: vi.fn(),
    status: vi.fn(),
    delivery: vi.fn(),
    approve: vi.fn(),
    decide: vi.fn(),
  },
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: state.uid } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: state.unlocked,
    getVaultOwnerToken: state.getToken,
  }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/perf/use-periodic-task", () => ({
  useCoarseClock: () => Date.now(),
  usePeriodicTask: state.periodic,
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onConsentMutated: state.invalidate },
}));
vi.mock("@/lib/services/drive-sharing-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-sharing-service")>()),
  DriveSharingService: state.service,
}));
import { DriveQueryRequestCard } from "@/components/consent/drive-query-request-card";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";
import { ROUTES } from "@/lib/navigation/routes";

const requestId = "11111111-1111-4111-8111-111111111111";
const view = (overrides: Partial<DriveQueryView> = {}): DriveQueryView => ({
  requestId,
  direction: "incoming",
  status: "pending",
  revision: 2,
  query: "potential bank statement",
  counterpartName: "Bea",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  decidedAt: null,
  answer: null,
  canDecide: true,
  lastError: null,
  ...overrides,
});
const answered = (overrides: Partial<DriveQueryView> = {}) =>
  view({
    status: "answered",
    canDecide: false,
    decidedAt: new Date().toISOString(),
    answer: {
      text: "Your March statement shows a closing balance.\nSee [link](https://evil.invalid) https://drive.google.com/x",
      titles: ["March statement.pdf", "<script>x</script>.pdf"],
      truncated: false,
    },
    ...overrides,
  });
const mount = (props: Partial<Parameters<typeof DriveQueryRequestCard>[0]> = {}) =>
  render(<DriveQueryRequestCard requestId={requestId} {...props} />);

describe("Drive question card", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.uid = "a";
    state.unlocked = true;
    state.token = "owner-a";
    state.epoch = 1;
    state.getToken.mockImplementation(() => state.token);
    state.service.getQuery.mockResolvedValue(view());
  });
  afterEach(cleanup);

  it("shows the asker, the exact question and Allow/Deny without reading Drive on open", async () => {
    mount({ direction: "incoming" });
    expect(await screen.findByText("Bea asked about your Drive")).toBeVisible();
    expect(screen.getByText("“potential bank statement”")).toBeVisible();
    expect(screen.getByText(/searches your Drive once for this question/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
    expect(state.service.getQuery).toHaveBeenCalledWith("owner-a", requestId, expect.any(Function));
    for (const reader of ["prepare", "review", "status", "delivery", "approve", "decide", "allowQuery", "denyQuery"] as const)
      expect(state.service[reader]).not.toHaveBeenCalled();
  });

  it("allows exactly once, keeps both choices disabled while Drive is searched, then shows the answer", async () => {
    let finish!: (value: DriveQueryView) => void;
    state.service.allowQuery.mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    const reconcile = vi.fn();
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    try {
      mount();
      const allow = await screen.findByRole("button", { name: "Allow" });
      fireEvent.click(allow);
      fireEvent.click(allow);
      expect(await screen.findByText("Searching your Drive…")).toBeVisible();
      expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Deny" }));
      expect(state.service.allowQuery).toHaveBeenCalledOnce();
      expect(state.service.allowQuery).toHaveBeenCalledWith("owner-a", requestId, 2, expect.any(Function));
      expect(state.service.denyQuery).not.toHaveBeenCalled();
      await act(async () => finish(answered()));
      expect(await screen.findByText("You allowed this question.")).toBeVisible();
      expect(screen.getByText("March statement.pdf")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
      expect(reconcile).toHaveBeenCalledOnce();
      expect(state.invalidate).toHaveBeenCalledWith("a");
    } finally {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    }
  });

  it("denies exactly once and never reads Drive", async () => {
    state.service.denyQuery.mockResolvedValueOnce(
      view({ status: "denied", canDecide: false, decidedAt: new Date().toISOString() }),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    expect(await screen.findByText("You declined this question.")).toBeVisible();
    expect(state.service.denyQuery).toHaveBeenCalledOnce();
    expect(state.service.denyQuery).toHaveBeenCalledWith("owner-a", requestId, 2, expect.any(Function));
    expect(state.service.allowQuery).not.toHaveBeenCalled();
    expect(state.service.prepare).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it.each([
    ["reconnect_required", "Reconnect Google Drive, then allow again."],
    ["drive_query_unavailable", "Drive didn't answer. Try again."],
    ["request_changed", "This question changed. Check it and try again."],
  ])("keeps a pending question decidable after %s with plain copy", async (code, copy) => {
    state.service.allowQuery.mockRejectedValueOnce(new DriveSharingError(code, 409));
    state.service.getQuery
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ revision: 3 }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
    state.service.allowQuery.mockResolvedValueOnce(answered());
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(state.service.allowQuery).toHaveBeenCalledTimes(2));
    // The retry uses the server's current revision, not the stale one.
    expect(state.service.allowQuery.mock.calls[1][2]).toBe(3);
  });

  it("refetches an already-decided question instead of showing a failure", async () => {
    state.service.allowQuery.mockRejectedValueOnce(new DriveSharingError("request_already_decided", 409));
    state.service.getQuery
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ status: "denied", canDecide: false, decidedAt: new Date().toISOString() }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("You declined this question.")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("shows an expired question without a way to allow it", async () => {
    state.service.allowQuery.mockRejectedValueOnce(new DriveSharingError("request_expired", 409));
    state.service.getQuery
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ status: "expired", canDecide: false }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText("This question expired.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("hides Allow when the expiry has passed even if the server still says pending", async () => {
    state.service.getQuery.mockResolvedValue(
      view({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    mount();
    expect(await screen.findByText("This question expired.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("explains a previous failed Allow recorded on the question", async () => {
    state.service.getQuery.mockResolvedValue(view({ lastError: "reconnect_required" }));
    mount();
    expect(await screen.findByText("Reconnect Google Drive, then allow again.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("shows the asker a waiting state with no decision controls", async () => {
    state.service.getQuery.mockResolvedValue(
      view({ direction: "outgoing", counterpartName: "Alex", canDecide: false }),
    );
    mount({ direction: "outgoing" });
    expect(await screen.findByText("Waiting for Alex to allow")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    // Pending questions keep polling on the shared idle clock.
    expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: true });
  });

  it("renders the asker's answer and file names as plain text with no links", async () => {
    state.service.getQuery.mockResolvedValue(
      answered({ direction: "outgoing", counterpartName: "Alex" }),
    );
    const { container } = mount({ direction: "outgoing" });
    expect(await screen.findByText("Answered")).toBeVisible();
    expect(screen.getByText(/Your March statement shows a closing balance\./)).toBeVisible();
    expect(screen.getByText(/\[link\]\(https:\/\/evil\.invalid\)/)).toBeVisible();
    expect(screen.getByText("From these files:")).toBeVisible();
    const titles = screen.getByRole("list", { name: "From these files:" });
    expect(titles).toHaveTextContent("March statement.pdf");
    expect(screen.getByText("<script>x</script>.pdf")).toBeVisible();
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(document.querySelector("script")).toBeNull();
    expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: false });
  });

  it.each([
    ["denied", "Declined"],
    ["expired", "Expired"],
    ["running", "Allowed — finding the answer"],
  ] as const)("shows the asker %s as %s", async (status, copy) => {
    state.service.getQuery.mockResolvedValue(
      view({ direction: "outgoing", status, canDecide: false }),
    );
    mount();
    expect(await screen.findByText(copy)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("uses an initial view immediately and still confirms it with the server", async () => {
    mount({ direction: "outgoing", initial: view({ direction: "outgoing", counterpartName: "Alex", canDecide: false }) });
    expect(screen.getByText("Waiting for Alex to allow")).toBeVisible();
    await waitFor(() => expect(state.service.getQuery).toHaveBeenCalledOnce());
  });

  it("never leaves a question decidable after a failed refresh", async () => {
    state.service.getQuery.mockRejectedValue(new DriveSharingError("request_unavailable", 404));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("This question isn't available.");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  it("drops a late decision after the vault locks", async () => {
    let finish!: (value: DriveQueryView) => void;
    state.service.allowQuery.mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    const rendered = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    state.unlocked = false;
    state.epoch++;
    rendered.rerender(<DriveQueryRequestCard requestId={requestId} />);
    await act(async () => finish(answered()));
    expect(screen.getByText("Unlock your vault to see this question.")).toBeVisible();
    expect(screen.queryByText("March statement.pdf")).toBeNull();
    expect(state.invalidate).not.toHaveBeenCalled();
  });
  it("lets the asker cancel a waiting question once and never reads Drive", async () => {
    let finish!: (value: DriveQueryView) => void;
    state.service.cancelQuery.mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    state.service.getQuery.mockResolvedValue(
      view({ direction: "outgoing", counterpartName: "Alex", canDecide: false }),
    );
    mount({ direction: "outgoing" });
    const cancel = await screen.findByRole("button", { name: "Cancel question" });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(await screen.findByText("Cancelling…")).toBeVisible();
    expect(state.service.cancelQuery).toHaveBeenCalledOnce();
    expect(state.service.cancelQuery).toHaveBeenCalledWith("owner-a", requestId, 2, expect.any(Function));
    await act(async () =>
      finish(
        view({
          direction: "outgoing",
          counterpartName: "Alex",
          canDecide: false,
          status: "cancelled",
          revision: 3,
          decidedAt: new Date().toISOString(),
        }),
      ),
    );
    expect(await screen.findByText("Cancelled")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel question" })).toBeNull();
    for (const reader of ["allowQuery", "denyQuery", "prepare", "review", "approve", "decide"] as const)
      expect(state.service[reader]).not.toHaveBeenCalled();
    expect(state.invalidate).toHaveBeenCalledWith("a");
  });

  it("tells the owner the asker cancelled, with no Allow or Deny", async () => {
    state.service.getQuery.mockResolvedValue(
      view({ status: "cancelled", canDecide: false, decidedAt: new Date().toISOString() }),
    );
    mount({ direction: "incoming" });
    expect(await screen.findByText("Bea cancelled this question.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel question" })).toBeNull();
    expect(state.periodic.mock.lastCall?.[3]).toEqual({ enabled: false });
  });

  it("offers no cancel once the question is answered, declined or expired", async () => {
    for (const status of ["answered", "denied", "expired"] as const) {
      state.service.getQuery.mockResolvedValue(
        status === "answered"
          ? answered({ direction: "outgoing" })
          : view({ direction: "outgoing", status, canDecide: false }),
      );
      const rendered = mount({ direction: "outgoing" });
      await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
      expect(screen.queryByRole("button", { name: "Cancel question" })).toBeNull();
      rendered.unmount();
    }
  });

  it("offers a reconnect link when Allow needs Google Drive again", async () => {
    state.service.getQuery.mockResolvedValue(view({ lastError: "reconnect_required" }));
    const rendered = mount({ direction: "incoming" });
    const link = await screen.findByRole("link", { name: "Reconnect Google Drive" });
    expect(link).toHaveAttribute("href", ROUTES.PROFILE_CONNECTORS);
    rendered.unmount();
    state.service.getQuery.mockResolvedValue(view({ lastError: "drive_query_unavailable" }));
    const other = mount({ direction: "incoming" });
    expect(await screen.findByText("Drive didn't answer. Try again.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Reconnect Google Drive" })).toBeNull();
    other.unmount();
    state.service.getQuery.mockResolvedValue(
      view({ direction: "outgoing", canDecide: false, lastError: "reconnect_required" }),
    );
    mount({ direction: "outgoing" });
    expect(await screen.findByRole("button", { name: "Cancel question" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Reconnect Google Drive" })).toBeNull();
  });
});

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AdvisorReview } from "@/lib/advisor-review/contract";
const mocks = vi.hoisted(() => ({
  view: vi.fn(),
  decrypt: vi.fn(),
  decide: vi.fn(),
  meeting: vi.fn(),
  time: vi.fn(),
  billing: vi.fn(),
  sandboxPayout: vi.fn(),
  calendarStatus: vi.fn(),
}));
vi.mock("@/lib/advisor-review/service", () => ({
  AdvisorReviewService: mocks,
}));
vi.mock("@/lib/services/google-calendar-service", () => ({ GoogleCalendarService: { status: mocks.calendarStatus } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/ria/clients" }));
vi.mock("@/components/app-ui/kai-control-surface", () => ({
  KaiControlSurface: ({
    title,
    children,
    footer,
  }: {
    title: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
  }) => (
    <section role="dialog" aria-label="Advisor review">
      <h1>{title}</h1>
      {children}
      {footer}
    </section>
  ),
}));
import { AdvisorWorkspace } from "@/components/kai/advisor/advisor-workspace";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

const context = {
  userId: "advisor",
  vaultKey: "synthetic",
  vaultOwnerToken: "synthetic",
  getIdToken: async () => "synthetic",
  isCurrent: () => true,
};
const value: AdvisorReview = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "owner",
  ownerPersonRef: "22222222-2222-4222-8222-222222222222",
  advisorUserId: "advisor",
  advisorPersonRef: "33333333-3333-4333-8333-333333333333",
  ownerName: "Sample owner",
  advisorName: "Sample advisor",
  direction: "received",
  status: "pending",
  introduction: "Please review my allocation.",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 604800000).toISOString(),
  serverNow: new Date().toISOString(),
  contentHash: "a".repeat(64),
  snapshotAvailable: false,
  meeting: null,
  plan: null,
  planRevision: 0,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(window.matchMedia).mockImplementation((query) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  mocks.view.mockResolvedValue({ ...value });
  mocks.sandboxPayout.mockResolvedValue({ mode: "test", setup: "setup_required", latest: null });
  mocks.calendarStatus.mockResolvedValue({ status: "disconnected", connected: false });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("withholds the snapshot and scheduling until advisor acceptance is acknowledged", async () => {
  render(
    <AdvisorWorkspace id={value.id} context={context} onClose={vi.fn()} />,
  );
  await screen.findByRole("button", { name: "Accept & connect" });
  expect(mocks.decrypt).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("heading", { name: "Finance snapshot" }),
  ).toBeNull();
  mocks.decide.mockRejectedValue(
    new Error("Acceptance could not be confirmed."),
  );
  fireEvent.click(screen.getByRole("button", { name: "Accept & connect" }));
  await screen.findByRole("alert");
  expect(mocks.decide).toHaveBeenCalledWith(context, value.id, "accept", undefined);
  expect(mocks.decrypt).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Review Calendar booking" }),
  ).toBeNull();
});

it("offers plain Accept for an existing connection and waits for authorized snapshot access", async () => {
  mocks.view.mockResolvedValue({ ...value, alreadyConnected: true });
  render(<AdvisorWorkspace id={value.id} context={context} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Accept", exact: true }));
  await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith(context, value.id, "accept", true));
  expect(mocks.decrypt).not.toHaveBeenCalled();
});

it("consumes Back while acceptance settles, then closes the workspace before its route", async () => {
  let complete!: () => void;
  mocks.decide.mockReturnValue(
    new Promise<void>((resolve) => {
      complete = resolve;
    }),
  );
  const close = vi.fn();
  render(<AdvisorWorkspace id={value.id} context={context} onClose={close} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Accept & connect" }),
  );
  expect(unwindBackLayer("/ria/clients")).toBe(true);
  expect(close).not.toHaveBeenCalled();
  complete();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Accept & connect" }),
    ).not.toBeDisabled(),
  );
  expect(unwindBackLayer("/ria/clients")).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

it("offers a Calendar recovery path without marking a failed booking as confirmed", async () => {
  mocks.view.mockResolvedValue({
    ...value,
    status: "accepted",
    meeting: {
      id: "meeting",
      status: "agreed",
      startAt: new Date(Date.now() + 86400000).toISOString(),
      endAt: new Date(Date.now() + 88200000).toISOString(),
      timeZone: "UTC",
    },
  });
  mocks.meeting.mockRejectedValue(
    new Error(
      "Connect Google Calendar and allow scheduling before booking. Your request is saved.",
    ),
  );
  render(
    <AdvisorWorkspace id={value.id} context={context} onClose={vi.fn()} />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Review Calendar booking" }),
  );
  await screen.findByRole("alert");
  expect(
    await screen.findByRole("link", { name: "Connect Calendar" }),
  ).toHaveAttribute("href", "/one/calendar");
  expect(screen.queryByRole("button", { name: "Confirm meeting" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Join Google Meet" })).toBeNull();
});

it("keeps billing explicitly unconfirmed until a provider status check and exposes Stripe setup", async () => {
  mocks.view.mockResolvedValue({
    ...value,
    status: "accepted",
    meeting: { status: "completed" },
    plan: {
      amountCents: 2000,
      currency: "usd",
      interval: "month",
      services: "A portfolio review each month.",
      cancellationTerms: "Cancel future renewals at any time.",
    },
    planRevision: 1,
  });
  mocks.billing.mockResolvedValue({ status: "past_due", mode: "test" });
  render(
    <AdvisorWorkspace id={value.id} context={context} onClose={vi.fn()} />,
  );
  fireEvent.click(await screen.findByRole("tab", { name: "Plan" }));
  await screen.findByRole("button", { name: "Check payment status" });
  expect(screen.queryByText(/Test subscription active/)).toBeNull();
  expect(await screen.findByRole("button", { name: "Set up test payouts" })).toBeEnabled();
  expect(screen.queryByRole("link", { name: /Stripe setup/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("past due"),
  );
  expect(screen.queryByText(/Test subscription active/)).toBeNull();
});

it("opens a one-time Stripe return on Plan and only shows Paid after provider readback", async () => {
  mocks.view.mockResolvedValue({
    ...value,
    status: "accepted",
    direction: "outgoing",
    plan: {
      amountCents: 2500,
      currency: "usd",
      interval: "one_time",
      services: "One portfolio review and follow-up call.",
      cancellationTerms: "Cancel before the advisor starts work.",
    },
    planRevision: 2,
  });
  mocks.billing.mockResolvedValue({ mode: "test", status: "processing", planRevision: 2 });
  render(<AdvisorWorkspace id={value.id} context={{ ...context, userId: "owner" }}
    openPlan onClose={vi.fn()} />);
  expect(await screen.findByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByText("Payment pending")).toBeVisible();
  expect(screen.queryByText(/^Paid /)).toBeNull();
  expect(screen.queryByRole("button", { name: "Pay $25.00" })).toBeNull();
  mocks.billing.mockResolvedValue({
    mode: "test", status: "paid", planRevision: 2, amountCents: 2500, paidAt: "2026-11-11T12:00:00Z",
  });
  fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
  expect(await screen.findByText(/^Paid \$25\.00/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Pay $25.00" })).toBeNull();
});

it.each(["owner", "advisor"])("reads and refreshes the %s’s own connected Calendar", async (userId) => {
  mocks.view.mockResolvedValue({ ...value, status: "accepted", direction: userId === "advisor" ? "received" : "outgoing" });
  mocks.calendarStatus.mockResolvedValueOnce({
    status: "connected", connected: true,
    accounts: [{ account_id: "default", google_email: `${userId}@example.test`, status: "connected", connected: true, access_level: "manage" }],
  });
  render(<AdvisorWorkspace id={value.id} context={{ ...context, userId }} onClose={vi.fn()} />);
  expect(await screen.findByText(`${userId}@example.test`)).toBeVisible();
  expect(mocks.calendarStatus).toHaveBeenCalledWith("synthetic", userId);
  expect(screen.getByRole("link", { name: "Manage Calendar" })).toBeVisible();
  fireEvent.focus(window);
  expect(await screen.findByRole("link", { name: "Connect Calendar" })).toBeVisible();
  expect(screen.queryByText(`${userId}@example.test`)).toBeNull();
});

it("opens accepted reviews on Meeting and supports keyboard navigation without changing access", async () => {
  const close = vi.fn();
  mocks.view.mockResolvedValue({ ...value, status: "accepted", direction: "outgoing" });
  render(<AdvisorWorkspace id={value.id} context={{ ...context, userId: "owner" }} onClose={close} />);
  expect(await screen.findByRole("button", { name: "Stop advisor review" })).toHaveTextContent(/^Stop$/);
  const meeting = screen.getByRole("tab", { name: "Meeting" });
  expect(meeting).toHaveAttribute("aria-selected", "true");
  expect(await screen.findByRole("link", { name: "Connect Calendar" })).toBeVisible();
  fireEvent.keyDown(meeting, { key: "ArrowRight" });
  expect(screen.getByRole("tab", { name: "Portfolio" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("link", { name: "Connect Calendar" })).toBeNull();
  expect(mocks.decide).not.toHaveBeenCalled();
  expect(unwindBackLayer("/ria/clients")).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

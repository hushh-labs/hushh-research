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
}));
vi.mock("@/lib/advisor-review/service", () => ({
  AdvisorReviewService: mocks,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/ria/clients" }));
vi.mock("@/components/app-ui/kai-control-surface", () => ({
  KaiControlSurface: ({
    title,
    children,
  }: {
    title: ReactNode;
    children: ReactNode;
  }) => (
    <section role="dialog" aria-label="Advisor review">
      <h1>{title}</h1>
      {children}
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
  mocks.view.mockResolvedValue({ ...value });
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
    screen.getByRole("link", { name: "Connect or manage Calendar" }),
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
  await screen.findByRole("button", { name: "Check payment status" });
  expect(screen.queryByText(/Test subscription active/)).toBeNull();
  expect(
    screen.getByRole("link", { name: "Finish Stripe setup" }),
  ).toHaveAttribute("href", "/one/profile/payouts");
  fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("past due"),
  );
  expect(screen.queryByText(/Test subscription active/)).toBeNull();
});

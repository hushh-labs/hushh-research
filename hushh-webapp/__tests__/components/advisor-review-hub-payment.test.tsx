import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdvisorReview } from "@/lib/advisor-review/contract";

const mocks = vi.hoisted(() => ({ history: vi.fn() }));
const context = { isCurrent: () => true };
vi.mock("@/lib/advisor-review/service", () => ({ AdvisorReviewService: mocks }));
vi.mock("@/lib/finance-sharing/use-finance-share-context", () => ({
  useFinanceShareContext: () => ({ capture: () => context, ready: true, session: "s" }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/ria/clients",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: vi.fn() }));
vi.mock("@/components/kai/views/portfolio-briefing", () => ({ PortfolioAnalysis: () => null }));
vi.mock("@/components/connections/connection-person-avatar", () => ({ ConnectionPersonAvatar: () => null }));
vi.mock("@/components/kai/advisor/advisor-workspace", () => ({ AdvisorWorkspace: () => null }));
vi.mock("@/components/kai/advisor/advisor-request-flow", () => ({ AdvisorRequestFlow: () => null }));
vi.mock("@/components/kai/advisor/portfolio-agent-review", () => ({ PortfolioAgentReview: () => null }));
import { AdvisorReviewHub } from "@/components/kai/advisor/advisor-review-hub";

const review = (id: string, payment?: AdvisorReview["payment"]): AdvisorReview => ({
  id,
  ownerUserId: "owner",
  ownerPersonRef: "22222222-2222-4222-8222-222222222222",
  advisorUserId: "advisor",
  advisorPersonRef: "33333333-3333-4333-8333-333333333333",
  ownerName: `Client ${id[0]}`,
  advisorName: `Advisor ${id[0]}`,
  direction: "outgoing",
  status: "accepted",
  introduction: "Hello",
  createdAt: "2026-11-12T00:00:00+00:00",
  expiresAt: "2026-11-19T00:00:00+00:00",
  serverNow: "2026-11-12T00:00:00+00:00",
  contentHash: "a".repeat(64),
  snapshotAvailable: true,
  meeting: null,
  plan: { amountCents: 100, currency: "usd", interval: "one_time", services: "", cancellationTerms: "" },
  planRevision: 1,
  ...(payment ? { payment } : {}),
});

afterEach(cleanup);

it("marks a settled advisor payment on the request row and leaves unpaid rows alone", async () => {
  mocks.history.mockResolvedValue({
    items: [
      review("1aaaaaaa-1111-4111-8111-111111111111", {
        status: "paid",
        amountCents: 100,
        paidAt: "2026-11-12T01:00:00+00:00",
      }),
      review("2bbbbbbb-1111-4111-8111-111111111111"),
    ],
  });
  render(<AdvisorReviewHub />);
  // The client's list sits in a collapsed group.
  fireEvent.click(await screen.findByRole("button", { name: /Advisor requests/ }));
  const paid = await screen.findByRole("button", { name: /Open request with Advisor 1/ });
  await waitFor(() => expect(paid.textContent).toContain("Paid"));
  expect(paid.textContent).toContain("plan paid $1.00");
  const unpaid = screen.getByRole("button", { name: /Open request with Advisor 2/ });
  expect(unpaid.textContent).toContain("introduction and plan");
  expect(unpaid.textContent).not.toContain("Paid");
});

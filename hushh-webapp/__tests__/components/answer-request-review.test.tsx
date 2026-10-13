import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/components/consent/answer-payout-account", () => ({
  AnswerPayoutAccount: () => null,
}));
const priceSheet = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/consent/document-request-price-sheet", () => ({
  DocumentRequestPriceSheet: (props: Record<string, unknown>) => {
    priceSheet.props = props;
    return props.open ? <>{props.settlement as React.ReactNode}</> : null;
  },
}));
import { AnswerRequestReview } from "@/components/consent/answer-request-review";
import type { PendingAnswerRequest } from "@/lib/services/answer-request-service";
afterEach(cleanup);
const base: PendingAnswerRequest = {
  requestId: "r",
  requesterUserId: "peer",
  question: "What meals do you prefer?",
  periodStart: null,
  periodEnd: null,
  resolutionMode: "skipped",
  resolutionSkippedReason: "resolver_failed",
  proposedScopes: [
    { scope: "attr.food.preferences", label: "Food preferences" },
  ],
};
it("failed resolution cannot expose the catalog or permit pricing", () => {
  render(<AnswerRequestReview request={base} requesterLabel="Peer" />);
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.queryByText("Food preferences")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Set a price" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry matching" })).toBeEnabled();
});
it("successful empty resolution never falls back to every scope", () => {
  render(
    <AnswerRequestReview
      request={{ ...base, resolutionMode: "agent", proposedScopes: [] }}
      requesterLabel="Peer"
    />,
  );
  expect(screen.getByRole("button", { name: "Set a price" })).toBeDisabled();
  expect(
    screen.queryByRole("checkbox", { name: "Food preferences" }),
  ).not.toBeInTheDocument();
});

it("prices the answer in this lane's words, never the document lane's", () => {
  priceSheet.props = null;
  render(<AnswerRequestReview request={{ ...base, resolutionMode: "agent" }} requesterLabel="Peer" />);
  fireEvent.click(screen.getByRole("button", { name: "Set a price" }));
  const description = String(priceSheet.props?.description ?? "");
  expect(description).toBeTruthy();
  // The sheet is Drive's control; the promise it states is not Drive's here.
  expect(description).not.toMatch(/file|drive|google|document/i);
  expect(description).toMatch(/memory/i);
  expect(description).toMatch(/After you approve/i);
  expect(description).toMatch(/pay this price only when it is ready/i);
  expect(description).toMatch(/verified payment releases/i);
  expect(screen.getByRole("checkbox", { name: /I agree to Google Gemini/ }))
    .toHaveAccessibleName(/Google Gemini/);
});

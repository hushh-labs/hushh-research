import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/components/consent/answer-payout-account", () => ({
  AnswerPayoutAccount: () => null,
}));
const priceSheet = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/consent/document-request-price-sheet", () => ({
  DocumentRequestPriceSheet: (props: Record<string, unknown>) => {
    priceSheet.props = props;
    return null;
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
it("failed resolution requires explicit scope and model consent choices", () => {
  render(<AnswerRequestReview request={base} requesterLabel="Peer" />);
  expect(
    screen.getByRole("checkbox", { name: "Food preferences" }),
  ).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Set a price" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Food preferences" }));
  expect(screen.getByRole("button", { name: "Set a price" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I agree to model processing/ }),
  );
  expect(screen.getByRole("button", { name: "Set a price" })).toBeEnabled();
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
  render(<AnswerRequestReview request={base} requesterLabel="Peer" />);
  const description = String(priceSheet.props?.description ?? "");
  expect(description).toBeTruthy();
  // The sheet is Drive's control; the promise it states is not Drive's here.
  expect(description).not.toMatch(/file|drive|google|document/i);
  expect(description).toMatch(/memory/i);
});

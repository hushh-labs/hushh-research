import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OwnerRetryState,
  RecoveryRefundState,
  RequesterRecovery,
} from "@/lib/consent/document-request-requester-view";
import type { SharingDelivery, SharingStatus } from "@/lib/services/drive-sharing-service";

const state = vi.hoisted(() => ({
  reviewRequest: vi.fn(),
  token: "vault-token" as string | null,
  paymentProps: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ getVaultOwnerToken: () => state.token }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => 1,
  isVaultSessionEpochCurrent: () => true,
}));
// The payment section has its own suite; this one covers the recovery row.
vi.mock("@/components/consent/requester-payment-section", () => ({
  RequesterPaymentSection: (props: Record<string, unknown>) => { state.paymentProps = props; return null; },
}));
vi.mock("@/lib/services/drive-request-requester-service", () => ({
  DriveRequestRequesterService: { reviewRequest: state.reviewRequest },
}));

import { DocumentRequestRequesterPanel } from "@/components/consent/document-request-requester-panel";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";

const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

function recovery(
  ownerRetry: OwnerRetryState,
  refund: RecoveryRefundState = "none",
): RequesterRecovery {
  return {
    undeliveredCount: 3,
    reasons: [{ reasonCode: "permission_rejected", count: 3 }],
    ownerRetry: { state: ownerRetry, retryableCount: 3, requestedAt: null },
    refund: {
      state: refund,
      amountCents: refund === "none" ? null : 1500,
      grossCents: null,
      expectedFiles: null,
      confirmedFiles: null,
    },
  };
}

const STATUS: SharingStatus = {
  requestId: REQUEST_ID,
  status: "approved",
  revision: 4,
  direction: "outgoing",
};

function delivery(next: RequesterRecovery | null): SharingDelivery {
  return { status: "approved", files: [], recovery: next };
}

function panel(next: RequesterRecovery | null, onChanged = vi.fn()) {
  return (
    <DocumentRequestRequesterPanel
      requestId={REQUEST_ID}
      status={STATUS}
      delivery={delivery(next)}
      context={null}
      locked={false}
      surface="sheet"
      onCancel={vi.fn()}
      onChanged={onChanged}
    />
  );
}

const row = () => screen.getByTestId("requester-recovery");
const live = () => screen.getByTestId("requester-recovery-announcement");

describe("DocumentRequestRequesterPanel recovery row", () => {
  beforeEach(() => {
    state.reviewRequest.mockReset();
    state.token = "vault-token";
  });

  it("binds private disclosure to its request revision without equating the package revision", () => {
    const disclosure = { schemaVersion: 1 as const, packageDigest: "b".repeat(64), packageRevision: 2,
      selectedCount: 1, coverageStatus: "complete" as const, periods: [], limitations: [] };
    const context = { requestId: REQUEST_ID, requestRevision: 3, packageDisclosure: disclosure,
      purpose: { purpose: "Statements", periodStart: null, periodEnd: null } };
    const props = { requestId: REQUEST_ID, status: STATUS, locked: false, surface: "sheet" as const,
      onCancel: vi.fn(), onChanged: vi.fn() };
    const mounted = render(<DocumentRequestRequesterPanel {...props} context={context} />);
    expect(state.paymentProps?.packageDisclosure).toBeNull();
    mounted.rerender(<DocumentRequestRequesterPanel {...props} context={{ ...context, requestRevision: 4 }} />);
    expect(state.paymentProps?.packageDisclosure).toEqual(disclosure);
    mounted.rerender(<DocumentRequestRequesterPanel {...props} status={{ ...STATUS, revision: 5 }} context={{ ...context, requestRevision: 4 }} />);
    expect(state.paymentProps?.packageDisclosure).toBeNull();
  });

  it("keeps the row and Request review out of the live region and says nothing on opening", () => {
    render(panel(recovery("available")));

    const ask = screen.getByRole("button", { name: "Request review" });
    expect(row()).toHaveTextContent("3 files not shared");
    expect(screen.getAllByRole("status")).toEqual([live()]);
    expect(live()).toHaveClass("sr-only");
    expect(live()).not.toContainElement(ask);
    expect(row()).not.toContainElement(live());
    expect(within(row()).queryByRole("status")).toBeNull();
    expect(live().textContent).toBe("");
  });

  it("stays silent through re-renders with the same state", () => {
    const { rerender } = render(panel(recovery("available")));
    rerender(panel(recovery("available")));
    rerender(panel(recovery("available")));
    expect(live().textContent).toBe("");
  });

  it("announces the review request once it is asked, without the button", async () => {
    state.reviewRequest.mockResolvedValue(undefined);
    const onChanged = vi.fn();
    const { rerender } = render(panel(recovery("available"), onChanged));

    fireEvent.click(screen.getByRole("button", { name: "Request review" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(state.reviewRequest).toHaveBeenCalledExactlyOnceWith(
      "vault-token",
      REQUEST_ID,
      expect.any(Function),
    );
    expect(live().textContent).toBe("");

    // The reload carries the new state: that change is what is heard.
    rerender(panel(recovery("requested"), onChanged));
    expect(row()).toHaveTextContent("Review requested");
    expect(screen.queryByRole("button", { name: "Request review" })).toBeNull();
    expect(live().textContent).toBe("3 files not shared. Review requested");
    expect(live()).not.toHaveTextContent("Request review");

    rerender(panel(recovery("retrying", "succeeded"), onChanged));
    expect(live().textContent).toBe("3 files not shared · $15 refunded. Owner retrying");
  });

  it("reports the ask limit as an alert, outside both the row and the status", async () => {
    state.reviewRequest.mockRejectedValue(new DriveSharingError("review_limit_reached"));
    const onChanged = vi.fn();
    const { rerender } = render(panel(recovery("available"), onChanged));

    fireEvent.click(screen.getByRole("button", { name: "Request review" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You've already asked three times.");
    expect(row()).not.toContainElement(alert);
    expect(live()).not.toContainElement(alert);

    rerender(panel(recovery("unavailable"), onChanged));
    expect(screen.queryByRole("button", { name: "Request review" })).toBeNull();
    expect(live().textContent).toBe("");
  });

  it("says nothing when the recovery row first appears after loading", () => {
    const { rerender } = render(panel(null));
    expect(screen.queryByTestId("requester-recovery-announcement")).toBeNull();
    rerender(panel(recovery("requested")));
    expect(row()).toHaveTextContent("Review requested");
    expect(live().textContent).toBe("");
  });
});

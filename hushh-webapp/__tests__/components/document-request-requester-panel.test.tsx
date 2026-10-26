import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OwnerRetryState,
  RecoveryRefundState,
  RequesterRecovery,
} from "@/lib/consent/document-request-requester-view";
import type {
  DriveBulkReasonCode,
  SharingDelivery,
  SharingStatus,
} from "@/lib/services/drive-sharing-service";

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
import { OneCopyService } from "@/lib/services/one-copy-service";
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

  it("keeps one original Drive row and one same-session One locator without copy polling", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://one.invalid");
    const copyRead = vi.spyOn(OneCopyService, "status");
    try {
      render(<DocumentRequestRequesterPanel requestId={REQUEST_ID} status={{ ...STATUS, oneCopyRequested: true }}
        delivery={{ status: "approved", files: [{ name: "Statement.pdf", status: "shared", revocationStatus: null,
          grantId: "grant", managed: true, openUrl: "https://drive.google.com/file/d/source/view", manageInGoogle: false }] }}
        context={null} locked={false} surface="sheet" onCancel={vi.fn()} onChanged={vi.fn()} />);
      expect(screen.getAllByText("Statement.pdf")).toHaveLength(1);
      expect(screen.getAllByRole("link", { name: "Open in Google Drive" })).toHaveLength(1);
      const locator = screen.getByRole("link", { name: "Open One link", exact: true });
      expect(locator).toHaveAttribute("href", `/one/documents/open?ref=${REQUEST_ID}&delivery=background`);
      expect(locator).not.toHaveAttribute("target", "_blank");
      expect(screen.queryByRole("button", { name: "Preview", exact: true })).not.toBeInTheDocument();
      expect(copyRead).not.toHaveBeenCalled();
    } finally { copyRead.mockRestore(); vi.unstubAllEnvs(); }
  });

  it("shows no charge instead of an old final quote after existing-access completion", () => {
    render(<DocumentRequestRequesterPanel requestId={REQUEST_ID}
      status={{ ...STATUS, status: "completed", price: { state: "final", estimateCents: 50, currentCents: 50, finalCents: 50 } }}
      delivery={{ status: "completed", files: [], noChargeReason: "existing_access", bulkShareId: REQUEST_ID, fileCount: 2, sharedCount: 2 }}
      context={null} locked={false} surface="sheet" onCancel={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText("No charge")).toBeInTheDocument();
    expect(screen.getByText("These files were already available to you. No payment was needed.")).toBeInTheDocument();
    expect(screen.queryByText("Final price")).toBeNull();
  });

  it("shows the server's approved Viewer term and exact access end in request details", () => {
    const props = { requestId: REQUEST_ID, delivery: undefined, context: null,
      locked: false, surface: "sheet" as const, onCancel: vi.fn(), onChanged: vi.fn() };
    const mounted = render(<DocumentRequestRequesterPanel {...props}
      status={{ ...STATUS, requestedAccessDays: 90, approvedAccessDays: 30,
        accessExpiresAt: "2026-10-20T10:15:00Z" }} />);
    expect(screen.getByText("Access")).toBeInTheDocument();
    expect(screen.getByText(/Viewer for 30 days · until /)).toBeInTheDocument();
    mounted.rerender(<DocumentRequestRequesterPanel {...props}
      status={{ ...STATUS, status: "pending", requestedAccessDays: 90,
        approvedAccessDays: null, accessExpiresAt: null }} />);
    expect(screen.getByText("Requested 90 days")).toBeInTheDocument();
    expect(screen.queryByText(/Viewer for/)).toBeNull();
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

  it("tells a requester without a Google account how to receive files", () => {
    const delivery = (reasonCode: DriveBulkReasonCode): SharingDelivery => ({
      status: "partial",
      files: [],
      bulkShareId: "55555555-5555-4555-8555-555555555555",
      fileCount: 2,
      sharedCount: 0,
      counts: { total: 2, processed: 2, shared: 0, alreadyShared: 0, skipped: 0,
        failed: 2, needsReview: 0, unknown: 0, pending: 0 },
      issues: [{ reasonCode, count: 2 }],
    });
    const props = { requestId: REQUEST_ID, status: { ...STATUS, status: "partial" }, context: null,
      locked: false, surface: "sheet" as const, onCancel: vi.fn(), onChanged: vi.fn() };
    const issues = () => screen.getByRole("list", { name: "Sharing issues" });
    const { rerender } = render(
      <DocumentRequestRequesterPanel {...props} delivery={delivery("recipient_needs_google_account")} />,
    );
    expect(issues()).toHaveTextContent("2 files: Link a Google account to receive files.");
    // Negative control: a refusal on the owner's side never asks B to link one.
    rerender(<DocumentRequestRequesterPanel {...props} delivery={delivery("permission_rejected")} />);
    expect(issues()).toHaveTextContent("Google Drive denied sharing.");
    expect(issues()).not.toHaveTextContent("Link a Google account");
  });

  it("says nothing when the recovery row first appears after loading", () => {
    const { rerender } = render(panel(null));
    expect(screen.queryByTestId("requester-recovery-announcement")).toBeNull();
    rerender(panel(recovery("requested")));
    expect(row()).toHaveTextContent("Review requested");
    expect(live().textContent).toBe("");
  });
});

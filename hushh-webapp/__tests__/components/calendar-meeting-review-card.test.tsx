import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(), review: vi.fn(), approve: vi.fn(), decide: vi.fn(),
  preview: vi.fn(), search: vi.fn(), linkedFiles: vi.fn(), prepare: vi.fn(), onChanged: vi.fn(),
  getVaultOwnerToken: vi.fn(() => "vault-owner-token"),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "organizer" }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({
  isVaultUnlocked: true, getVaultOwnerToken: mocks.getVaultOwnerToken,
}) }));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => 1, isVaultSessionEpochCurrent: () => true,
}));
vi.mock("@/lib/services/drive-sharing-service", () => ({
  DriveSharingService: { status: mocks.status, review: mocks.review,
    approve: mocks.approve, decide: mocks.decide },
}));
vi.mock("@/lib/services/calendar-meeting-review-service", () => ({
  CalendarMeetingReviewService: { preview: mocks.preview, search: mocks.search,
    linkedFiles: mocks.linkedFiles,
    prepare: mocks.prepare },
}));
vi.mock("@/components/consent/document-share-review", () => ({
  DocumentShareReview: () => <div data-testid="ordinary-drive-review" />,
}));

import { DocumentRequestReviewRouter } from "@/components/consent/calendar-meeting-review-card";

const requestId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const preview = {
  requestId, revision: 0, status: "pending", requestType: "calendar_meeting",
  recipientEmail: "calendar-b@example.invalid", ownerDriveReady: true,
  meeting: { title: "Weekly design review", date: "2026-10-14",
    start_at: "2026-10-14T10:00:00Z", organizer_email: "organizer@example.invalid",
    account_id: "calendar-B", occurrence_id: "a".repeat(64), requested_types: ["notes"] },
};

describe("Calendar organizer exact-file review", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getVaultOwnerToken.mockReturnValue("vault-owner-token");
    mocks.status.mockResolvedValue({ requestId, requestType: "calendar_meeting",
      direction: "incoming", revision: 0, status: "pending" });
    mocks.preview.mockResolvedValue(preview);
    mocks.search.mockResolvedValue({ files: [{ file_id: "approvednote123", name: "Approved note",
      mime_type: "application/vnd.google-apps.document", artifact_kind: "notes" }],
      candidateToken: { ciphertext: "sealed" }, hasMore: false, accountLabel: "Organizer Drive" });
    mocks.linkedFiles.mockResolvedValue({ files: [{ file_id: "approvednote123", name: "Approved note",
      mime_type: "application/vnd.google-apps.document", artifact_kind: "notes" }],
      candidateToken: { ciphertext: "linked-sealed" }, hasMore: false, accountLabel: "Organizer Drive" });
    mocks.prepare.mockResolvedValue(undefined);
    mocks.review.mockResolvedValue({ requestId, requestType: "calendar_meeting",
      recipientEmail: preview.recipientEmail, revision: 0, canApprove: true,
      reviewDigest: "d".repeat(64), expiresAt: "2099-01-01T00:00:00Z",
      files: [{ documentId, name: "Approved note" }] });
    mocks.approve.mockResolvedValue({ requestId, status: "approved" });
  });
  afterEach(() => cleanup());

  it("requires owner search, occurrence attestation and final exact-file confirmation", async () => {
    render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
    expect(await screen.findByText("Weekly design review")).toBeInTheDocument();
    expect(screen.getByText(preview.recipientEmail)).toBeInTheDocument();
    expect(screen.queryByTestId("ordinary-drive-review")).toBeNull();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText("Enter a file name"), { target: { value: "Approved note" } });
    fireEvent.click(screen.getByRole("button", { name: "Search files" }));
    expect(await screen.findByText("Organizer Drive")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare exact-file review" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Approved note/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm these exact files belong/ }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare exact-file review" }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith(requestId, "vault-owner-token",
      expect.objectContaining({ candidateToken: { ciphertext: "sealed" } }), ["approvednote123"]));
    expect(await screen.findByText("Final file and recipient review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Give access" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Approved note" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm these selected files/ }));
    fireEvent.click(screen.getByRole("button", { name: "Give access" }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(
      "vault-owner-token", requestId, expect.objectContaining({ requestType: "calendar_meeting" }),
      expect.any(Function), [documentId], false, undefined, true,
    ));
    expect(mocks.onChanged).toHaveBeenCalledOnce();
  });

  it("offers provider-linked exact references for manual owner selection", async () => {
    mocks.preview.mockResolvedValue({ ...preview, meeting: { ...preview.meeting,
      exact_refs: [{ file_id: "approvednote123", kind: "notes" }] } });
    render(<DocumentRequestReviewRouter requestId={requestId} onChanged={mocks.onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: "Check files linked to this meeting" }));
    expect(await screen.findByRole("checkbox", { name: /Approved note/ })).toBeInTheDocument();
    expect(mocks.linkedFiles).toHaveBeenCalledWith(requestId, "vault-owner-token");
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });
});

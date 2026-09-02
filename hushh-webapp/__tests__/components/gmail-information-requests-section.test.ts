import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import GmailInformationRequestsSection, {
  isExactDraftCandidate,
} from "@/components/gmail/gmail-information-requests-section";
import { projectDomainDataForScope } from "@/lib/personal-knowledge-model/manifest";

const gmailServiceMocks = vi.hoisted(() => ({
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  list: vi.fn(),
  scan: vi.fn(),
}));

vi.mock("@/lib/services/gmail-information-requests-service", () => ({
  GmailInformationRequestsService: gmailServiceMocks,
}));

function renderSection(
  idTokenProvider = () => Promise.resolve("firebase-token"),
) {
  return render(
    createElement(GmailInformationRequestsSection, {
      userId: "owner",
      vaultKey: null,
      vaultOwnerToken: null,
      isConnected: true,
      idTokenProvider,
      onRequestVaultUnlock: vi.fn(),
    }),
  );
}

describe("personal Gmail information-request scope boundary", () => {
  beforeEach(() => {
    gmailServiceMocks.getPreference.mockReset();
    gmailServiceMocks.setPreference.mockReset();
    gmailServiceMocks.list.mockReset();
    gmailServiceMocks.getPreference.mockResolvedValue({
      user_id: "owner",
      monitoring_enabled: false,
      retention: "metadata_only",
      disclosure: "Only new inbox messages are checked.",
    });
  });

  it("accepts only one manifest-backed exact leaf segment", () => {
    expect(
      isExactDraftCandidate({
        scope: "attr.identity.address.postal_code",
        domain: "identity",
        label: "Postal code",
        segment_ids: ["address"],
      }),
    ).toBe(true);
  });

  it("projects an approved nested leaf without sibling private values", () => {
    const projected = projectDomainDataForScope({
      domain: "identity",
      scope: "attr.identity.address.postal_code",
      approvedPaths: ["address.postal_code"],
      domainData: {
        address: {
          postal_code: "10001",
          street: "1 Private Street",
          city: "New York",
        },
        passport_number: "private-passport-number",
      },
    });

    expect(projected).toEqual({
      identity: { address: { postal_code: "10001" } },
    });
  });

  it("rejects broad, malformed, and unbound scope candidates before PKM access", () => {
    expect(
      isExactDraftCandidate({
        scope: "attr.identity.*",
        domain: "identity",
        label: "Identity",
        segment_ids: ["identity"],
      }),
    ).toBe(false);
    expect(
      isExactDraftCandidate({
        scope: "attr.identity.address.postal_code",
        domain: "identity",
        label: "Postal code",
        segment_ids: [],
      }),
    ).toBe(false);
    expect(
      isExactDraftCandidate({
        scope: "attr.identity.address.*",
        domain: "identity",
        label: "Address",
        segment_ids: ["address"],
      }),
    ).toBe(false);
  });

  it("does not refetch monitoring preference when a parent recreates its token callback", async () => {
    const view = renderSection();

    await waitFor(() =>
      expect(gmailServiceMocks.getPreference).toHaveBeenCalledTimes(1),
    );
    view.rerender(
      createElement(GmailInformationRequestsSection, {
        userId: "owner",
        vaultKey: null,
        vaultOwnerToken: null,
        isConnected: true,
        idTokenProvider: () => Promise.resolve("firebase-token"),
        onRequestVaultUnlock: vi.fn(),
      }),
    );

    await waitFor(() =>
      expect(screen.getByText("Verification requests")).toBeVisible(),
    );
    expect(gmailServiceMocks.getPreference).toHaveBeenCalledTimes(1);
  });

  it("keeps the server's safe monitoring error visible after an enable attempt fails", async () => {
    gmailServiceMocks.setPreference.mockRejectedValue(
      new Error(
        "Personal Gmail monitoring is temporarily unavailable. Please try again.",
      ),
    );
    renderSection();

    await screen.findByRole("button", { name: "Turn on monitoring" });
    fireEvent.click(screen.getByRole("button", { name: "Turn on monitoring" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Personal Gmail monitoring is temporarily unavailable. Please try again.",
    );
  });

  it("confirms the metadata deletion before turning monitoring off", async () => {
    gmailServiceMocks.getPreference.mockResolvedValue({
      user_id: "owner",
      monitoring_enabled: true,
      retention: "metadata_only",
    });
    gmailServiceMocks.list.mockResolvedValue({
      workflows: [],
      next_offset: null,
      total_count: 0,
    });
    gmailServiceMocks.setPreference.mockResolvedValue({
      user_id: "owner",
      monitoring_enabled: false,
      retention: "metadata_only",
    });

    render(
      createElement(GmailInformationRequestsSection, {
        userId: "owner",
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner-token",
        isConnected: true,
        idTokenProvider: () => Promise.resolve("firebase-token"),
        onRequestVaultUnlock: vi.fn(),
      }),
    );

    const turnOff = await screen.findByRole("button", {
      name: "Turn off monitoring",
    });
    fireEvent.click(turnOff);

    expect(await screen.findByText("Turn off monitoring?")).toBeVisible();
    expect(
      screen.getByText(/Your Gmail emails are not deleted/i),
    ).toBeVisible();
    expect(gmailServiceMocks.setPreference).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn off and delete activity" }),
    );
    await waitFor(() =>
      expect(gmailServiceMocks.setPreference).toHaveBeenCalledWith({
        userId: "owner",
        firebaseIdToken: "firebase-token",
        enabled: false,
      }),
    );
  });

  it("loads verification activity once and keeps it separate from the request queue", async () => {
    gmailServiceMocks.getPreference.mockResolvedValue({
      user_id: "owner",
      monitoring_enabled: true,
      retention: "metadata_only",
    });
    gmailServiceMocks.list.mockImplementation(({ view }: { view?: string }) =>
      Promise.resolve({
        workflows: [],
        next_offset: null,
        total_count: view === "activity" ? 1 : 0,
      }),
    );

    render(
      createElement(GmailInformationRequestsSection, {
        userId: "owner",
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner-token",
        isConnected: true,
        idTokenProvider: () => Promise.resolve("firebase-token"),
        onRequestVaultUnlock: vi.fn(),
      }),
    );

    await screen.findByRole("tab", { name: "Requests" });
    const activity = screen.getByRole("tab", { name: "Activity" });
    fireEvent.click(activity);
    fireEvent.click(activity);

    await waitFor(() =>
      expect(gmailServiceMocks.list).toHaveBeenCalledWith(
        expect.objectContaining({ view: "activity", offset: 0 }),
      ),
    );
    expect(
      gmailServiceMocks.list.mock.calls.filter(
        ([input]) => input.view === "activity",
      ),
    ).toHaveLength(1);
  });

  it("keeps request metadata in the queue and moves disclosure controls into review", async () => {
    gmailServiceMocks.getPreference.mockResolvedValue({
      user_id: "owner",
      monitoring_enabled: true,
      retention: "metadata_only",
    });
    gmailServiceMocks.list.mockResolvedValue({
      workflows: [
        {
          workflow_id: "request-1",
          status: "detected",
          gmail_thread_id: "thread-1",
          received_at: "2026-09-02T00:00:00.000Z",
          requested_field_labels: ["Passport number"],
          candidate_scopes: [],
          attachment_review_required: false,
        },
      ],
      next_offset: null,
      total_count: 1,
    });

    render(
      createElement(GmailInformationRequestsSection, {
        userId: "owner",
        vaultKey: "vault-key",
        vaultOwnerToken: "vault-owner-token",
        isConnected: true,
        idTokenProvider: () => Promise.resolve("firebase-token"),
        onRequestVaultUnlock: vi.fn(),
      }),
    );

    expect(await screen.findByText("Passport number")).toBeVisible();
    expect(
      screen.queryByLabelText("Private information reply draft"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    expect(await screen.findByText("Review request")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open email" })).toBeVisible();
  });
});

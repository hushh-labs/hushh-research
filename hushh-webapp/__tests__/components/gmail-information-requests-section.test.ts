import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import GmailInformationRequestsSection, {
  isExactDraftCandidate,
} from "@/components/gmail/gmail-information-requests-section";
import { projectDomainDataForScope } from "@/lib/personal-knowledge-model/manifest";
import type { GmailInformationRequestWorkflow } from "@/lib/services/gmail-information-requests-service";

const gmailServiceMocks = vi.hoisted(() => ({
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  list: vi.fn(),
  scanStream: vi.fn(),
}));
const handoffMocks = vi.hoisted(() => ({
  createHandoff: vi.fn(),
  navigateToAgentChat: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/services/gmail-information-requests-service", () => ({
  GmailInformationRequestsService: gmailServiceMocks,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: handoffMocks.push }),
}));
vi.mock("@/lib/navigation/agent-navigation", () => ({
  navigateToAgentChat: handoffMocks.navigateToAgentChat,
}));
vi.mock("@/lib/agent/one-conversation-session", () => ({
  useOneConversationSession: (
    selector: (state: {
      createHandoff: typeof handoffMocks.createHandoff;
    }) => unknown,
  ) => selector({ createHandoff: handoffMocks.createHandoff }),
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
    gmailServiceMocks.scanStream.mockReset();
    handoffMocks.createHandoff.mockReset();
    handoffMocks.navigateToAgentChat.mockReset();
    handoffMocks.push.mockReset();
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

    await waitFor(() => expect(screen.getByText("KYC requests")).toBeVisible());
    expect(gmailServiceMocks.getPreference).toHaveBeenCalledTimes(1);
  });

  it("shows the KYC workspace skeleton while monitoring state is still resolving", async () => {
    let resolvePreference!: (preference: {
      user_id: string;
      monitoring_enabled: boolean;
      retention: string;
    }) => void;
    gmailServiceMocks.getPreference.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePreference = resolve;
      }),
    );

    renderSection();

    expect(screen.getByText("KYC requests")).toBeVisible();
    expect(screen.getByLabelText("Loading KYC workspace")).toBeVisible();
    expect(screen.getByRole("status", { name: "Loading KYC requests" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Start monitoring" }),
    ).not.toBeInTheDocument();

    resolvePreference({
      user_id: "owner",
      monitoring_enabled: false,
      retention: "metadata_only",
    });

    expect(
      await screen.findByRole("button", { name: "Unlock to start" }),
    ).toBeVisible();
  });

  it("keeps the server's safe monitoring error visible after an enable attempt fails", async () => {
    gmailServiceMocks.setPreference.mockRejectedValue(
      new Error(
        "Personal Gmail monitoring is temporarily unavailable. Please try again.",
      ),
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

    const start = await screen.findByRole("button", {
      name: "Start monitoring",
    });
    await waitFor(() => expect(start).not.toBeDisabled());
    fireEvent.click(start);
    fireEvent.click(
      await screen.findByRole("button", { name: "Start monitoring" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Personal Gmail monitoring is temporarily unavailable. Please try again.",
    );
  });

  it("opens the private vault instead of issuing an invalid monitor opt-in", async () => {
    const onRequestVaultUnlock = vi.fn();
    render(
      createElement(GmailInformationRequestsSection, {
        userId: "owner",
        vaultKey: null,
        vaultOwnerToken: null,
        isConnected: true,
        idTokenProvider: () => Promise.resolve("firebase-token"),
        onRequestVaultUnlock,
      }),
    );

    const unlock = await screen.findByRole("button", {
      name: "Unlock to start",
    });
    await waitFor(() => expect(unlock).not.toBeDisabled());
    fireEvent.click(unlock);

    await waitFor(() => expect(onRequestVaultUnlock).toHaveBeenCalledOnce());
    expect(gmailServiceMocks.setPreference).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Open your private vault before changing KYC monitoring.",
    );
  });

  it("starts an incremental KYC scan when the unlocked KYC workspace opens", async () => {
    gmailServiceMocks.getPreference.mockResolvedValue({
      user_id: "owner",
      monitoring_enabled: true,
      retention: "metadata_only",
    });
    gmailServiceMocks.scanStream.mockImplementation(
      ({ handlers }: { handlers: { onProgress: (count: number) => void } }) => {
      handlers.onProgress(1);
      return Promise.resolve({
      accepted: true,
      scanned_count: 1,
      unchanged_count: 0,
      matched_count: 1,
      failed_count: 0,
      workflow_ids: ["request-1"],
      });
      },
    );
    gmailServiceMocks.list.mockResolvedValue({
      workflows: [],
      next_offset: null,
      total_count: 0,
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

    await waitFor(() =>
      expect(gmailServiceMocks.scanStream).toHaveBeenCalledWith(expect.objectContaining({
        firebaseIdToken: "firebase-token",
        vaultOwnerToken: "vault-owner-token",
        maxResults: 30,
      })),
    );
    expect(await screen.findByText("Emails checked")).toBeVisible();
    expect(screen.getByText("KYC requests found")).toBeVisible();
    expect(screen.getAllByText("1")).toHaveLength(2);
    expect(screen.getByText("Gmail monitoring is on")).toBeVisible();
    expect(
      screen.queryByText(/We process new Inbox messages first/i),
    ).toBeNull();
    expect(
      screen.queryByText(/Processing up to 30 previously unprocessed/i),
    ).toBeNull();
  });

  it("shows a completed email count and a new KYC request before the scan finishes", async () => {
    gmailServiceMocks.getPreference.mockResolvedValue({
      user_id: "owner",
      monitoring_enabled: true,
      retention: "metadata_only",
    });
    let finishScan: (() => void) | null = null;
    gmailServiceMocks.scanStream.mockImplementation(
      ({ handlers }: {
        handlers: {
          onProgress: (count: number) => void;
          onRequest: (workflow: GmailInformationRequestWorkflow) => void;
        };
      }) =>
        new Promise((resolve) => {
          handlers.onProgress(2);
          handlers.onRequest({
            workflow_id: "request-2",
            status: "detected",
            gmail_thread_id: "thread-2",
            received_at: "2026-09-24T12:00:00.000Z",
            classification_confidence: 0.9,
            requested_field_labels: ["Passport number"],
            candidate_scopes: [],
            attachment_review_required: false,
          });
          finishScan = () =>
            resolve({
              accepted: true,
              scanned_count: 2,
              unchanged_count: 0,
              matched_count: 1,
              failed_count: 0,
              workflow_ids: ["request-2"],
            });
        }),
    );
    gmailServiceMocks.list.mockResolvedValue({
      workflows: [],
      next_offset: null,
      total_count: 0,
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

    expect(await screen.findByText("Scanning emails: 2")).toBeVisible();
    expect(await screen.findByText("Passport number")).toBeVisible();
    expect(screen.getByRole("button", { name: "Looking…" })).toBeDisabled();

    finishScan?.();
    expect(await screen.findByText("Emails checked")).toBeVisible();
  });

  it("keeps partial scan retries out of the owner-facing KYC screen", async () => {
    gmailServiceMocks.getPreference.mockResolvedValue({
      user_id: "owner",
      monitoring_enabled: true,
      retention: "metadata_only",
    });
    gmailServiceMocks.scanStream.mockImplementation(
      ({ handlers }: { handlers: { onProgress: (count: number) => void } }) => {
      handlers.onProgress(1);
      return Promise.resolve({
      accepted: true,
      scanned_count: 1,
      unchanged_count: 1,
      matched_count: 0,
      failed_count: 1,
      retry_pending: true,
      workflow_ids: [],
      });
      },
    );
    gmailServiceMocks.list.mockResolvedValue({
      workflows: [],
      next_offset: null,
      total_count: 0,
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

    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));

    await waitFor(() => expect(gmailServiceMocks.scanStream).toHaveBeenCalled());
    expect(
      screen.queryByText(/We couldn’t check \d+ emails?\. Try again/i),
    ).toBeNull();
    expect(
      screen.getByText("Emails checked").nextElementSibling,
    ).toHaveTextContent("1");
    expect(
      screen.getByText("KYC requests found").nextElementSibling,
    ).toHaveTextContent("0");
  });

  it("keeps the server's safe scan error visible", async () => {
    gmailServiceMocks.getPreference.mockResolvedValue({
      user_id: "owner",
      monitoring_enabled: true,
      retention: "metadata_only",
    });
    gmailServiceMocks.scanStream.mockRejectedValue(
      new Error("Personal Gmail monitoring is temporarily unavailable."),
    );
    gmailServiceMocks.list.mockResolvedValue({
      workflows: [],
      next_offset: null,
      total_count: 0,
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

    fireEvent.click(await screen.findByRole("button", { name: "Check now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Personal Gmail monitoring is temporarily unavailable.",
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
      name: /^Turn off$/,
    });
    await waitFor(() => expect(turnOff).toBeEnabled());
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
        vaultOwnerToken: "vault-owner-token",
        enabled: false,
      }),
    );
  });

  it("loads verification activity with the request queue and keeps it separate", async () => {
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

    await screen.findByRole("tab", { name: "Active requests" });
    const activity = screen.getByRole("tab", { name: /^Activity/ });
    fireEvent.click(activity);
    fireEvent.click(activity);

    await waitFor(() =>
      expect(gmailServiceMocks.list).toHaveBeenCalledWith(
        expect.objectContaining({ view: "activity", limit: 100 }),
      ),
    );
    expect(
      gmailServiceMocks.list.mock.calls.filter(
        ([input]) => input.view === "activity",
      ),
    ).toHaveLength(2);
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
          requested_field_labels: ["passport_number", "education_history"],
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

    expect(
      await screen.findByText("Passport number, Education history"),
    ).toBeVisible();
    expect(
      screen.queryByLabelText("Private information reply draft"),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    expect(await screen.findByText("Review request")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open mail" })).toBeVisible();
  });

  it("moves a KYC request into One without putting private values in the handoff", async () => {
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
          requested_field_labels: ["Education"],
          candidate_scopes: [
            {
              scope: "attr.education.institution",
              domain: "education",
              label: "Education",
              segment_ids: ["institution"],
            },
          ],
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

    fireEvent.click(
      await screen.findByRole("button", { name: "Draft with One" }),
    );

    expect(handoffMocks.createHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "user_requested",
        gmailInformationRequest: expect.objectContaining({
          workflow_id: "request-1",
          requested_field_labels: ["Education"],
        }),
      }),
    );
    const handoff = handoffMocks.createHandoff.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(handoff.transcript).toBeUndefined();
    expect(JSON.stringify(handoff)).not.toContain("private-value");
    expect(handoffMocks.navigateToAgentChat).toHaveBeenCalledOnce();
  });
});

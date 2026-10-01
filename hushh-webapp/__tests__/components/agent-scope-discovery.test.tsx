import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InformationRequestReviewExperience, ScopeDiscoveryExperience } from "@/lib/agent/agui-structured-experiences";
import type { ViewerPersonProfile } from "@/lib/services/person-profile-service";

const mocks = vi.hoisted(() => ({
  user: { uid: "reviewer-a", getIdToken: vi.fn(async () => "test-token") },
  unlocked: true, getViewer: vi.fn(), create: vi.fn(), getInformationRequest: vi.fn(),
  getInformationRequestExports: vi.fn(), readStoredConnector: vi.fn(), decryptScopedExport: vi.fn(),
  consentOutcomes: vi.fn(async (): Promise<Record<string, string>> => ({})),
}));
vi.mock("@/lib/services/agent-chat-client", () => ({ getAgentChatConsentOutcomes: mocks.consentOutcomes }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: mocks.unlocked, vaultKey: "test-key", vaultOwnerToken: "test-owner-token" }) }));
vi.mock("@/lib/services/person-profile-service", async importOriginal => ({
  ...await importOriginal<object>(),
  PersonProfileService: { getViewer: mocks.getViewer, createInformationRequest: mocks.create, getInformationRequest: mocks.getInformationRequest, getInformationRequestExports: mocks.getInformationRequestExports },
}));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: {
  ensureConnector: async () => ({ connector_key_id: "test-connector" }),
  readStoredConnector: mocks.readStoredConnector,
  decryptScopedExport: mocks.decryptScopedExport,
} }));
vi.mock("@/lib/morphy-ux/button", () => ({ Button: ({ children, ...props }: { children: ReactNode }) => <button {...props}>{children}</button> }));
vi.mock("@/lib/morphy-ux/ui/surface-primitives", () => ({
  SectionCard: ({ children, title }: { children: ReactNode; title: string }) => <section><h4>{title}</h4>{children}</section>,
  StatusPill: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
// Keep the selection contract focused; the recursive selector has its own UI suite.
vi.mock("@/components/consent/consent-scope-nested-list", () => ({
  ConsentScopeNestedList: ({ items, selection }: { items: Array<{ id: string; label: string }>; selection?: { selectedIds: Set<string>; onToggleMany: (ids: string[], select: boolean) => void } }) =>
    <div>{items.map(item => <button key={item.id} aria-pressed={selection?.selectedIds.has(item.id)} onClick={() => selection?.onToggleMany([item.id], !selection.selectedIds.has(item.id))}>{item.label}</button>)}</div>,
}));

import { AgentConsentContinuationContext, AgentStructuredExperienceView } from "@/components/agent/agent-structured-experience";
import { armConsentContinuation, clearSentInformationRequests } from "@/lib/agent/consent-continuation";
import { resetInformationRequestReads } from "@/lib/consent/information-request-reads";

const person = "1234567890abcdef";
const experience: ScopeDiscoveryExperience = {
  type: "one.scope_discovery.v1", person: { personRef: person, displayName: "Synthetic Recipient", profilePath: `/people/${person}`, relationship: "connected" },
  domainFilter: null,
  scopes: [{ scopeRef: "stale-field", label: "Stale history label", description: null, domain: "professional", sensitivity: "standard" }],
};
function page(number: number, revision = "a".repeat(64)): ViewerPersonProfile {
  return { personRef: person, displayName: "Synthetic Recipient", photoUrl: null, verifiedRole: null,
    relationship: { status: "connected", connectionId: "synthetic", connectedAt: null, requestId: null },
    grants: [], requestHistory: [],
    requestableScopes: [{ scopeRef: `scope-${number}`, label: `Synthetic field ${number}`, description: null, domain: "professional", sensitivity: "standard", wildcard: false }],
    scopeCatalog: { page: number, nextPage: number < 2 ? 2 : null, limit: 100, totalCount: 2, hasMore: number < 2, catalogRevision: revision, paginationReset: false, domains: [] },
  };
}

describe("current-authority inline Chat catalog", () => {
  beforeEach(() => {
    resetInformationRequestReads();
    vi.clearAllMocks();
    mocks.user.uid = "reviewer-a";
    mocks.unlocked = true;
    mocks.getViewer.mockReset();
    mocks.getViewer.mockResolvedValue(page(1));
    mocks.create.mockReset();
    mocks.create.mockResolvedValue({ bundleId: "test-bundle" });
    mocks.getInformationRequest.mockReset();
    mocks.getInformationRequestExports.mockReset();
    mocks.readStoredConnector.mockReset();
    mocks.readStoredConnector.mockResolvedValue({ connector_key_id: "test-connector" });
    mocks.decryptScopedExport.mockReset();
  });
  afterEach(() => {
    cleanup();
    resetInformationRequestReads();
  });

  it("refreshes retained descriptors, loads consecutive pages, and never replays actions", async () => {
    mocks.getViewer.mockResolvedValueOnce(page(1)).mockResolvedValueOnce(page(2));
    render(<AgentStructuredExperienceView experience={experience} />);
    expect(screen.getByText("Stale history label")).toBeInTheDocument();
    await screen.findByText("Synthetic field 1");
    expect(screen.queryByText("Stale history label")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Load more information"));
    await screen.findByText("Synthetic field 2");
    expect(screen.getByText("Synthetic field 1")).toBeInTheDocument();
    expect(mocks.getViewer).toHaveBeenLastCalledWith(person, "test-token", { page: 2, revision: "a".repeat(64), domain: "" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps selection, editable review and explicit submission inside Chat", async () => {
    render(<AgentStructuredExperienceView experience={experience} />);
    fireEvent.click(await screen.findByText("Synthetic field 1"));
    fireEvent.click(screen.getByText("Review request"));
    expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    fireEvent.change(screen.getByTestId("chat-request-purpose"), { target: { value: "Synthetic sharing rehearsal" } });
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await screen.findByRole("status");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ personRef: person, scopeRefs: ["scope-1"], purpose: "Synthetic sharing rehearsal" }));
    expect(screen.getByRole("link", { name: "View profile" })).toHaveAttribute("href", `/people/${person}`);
  });

  it("submits one validated Professional root instead of separate covered requests", async () => {
    const profile = page(1);
    profile.requestableScopes = [
      { scopeRef: "opaque-professional-root", label: "Professional Domain", description: null, domain: "professional", sensitivity: "standard", wildcard: true, pathSegments: [] },
      { scopeRef: "opaque-professional-role", label: "Professional role", description: null, domain: "professional", sensitivity: "standard", wildcard: false, pathSegments: ["role"] },
    ];
    mocks.getViewer.mockResolvedValue(profile);
    render(<AgentStructuredExperienceView experience={experience} />);
    fireEvent.click(await screen.findByRole("button", { name: "Professional Domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Professional role" }));
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    expect(screen.getByText("This includes all available information in this area, not just one detail.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What you are asking for" }).parentElement)
      .not.toHaveTextContent("Professional role");
    fireEvent.change(screen.getByTestId("chat-request-purpose"), { target: { value: "Synthetic professional review" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      personRef: person, scopeRefs: ["opaque-professional-root"],
    })));
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("turns a bound Chat submission into the submitted card and opens only its current grant", async () => {
    const scopeRef = "opaque-professional-root";
    const bundleId = "bundle_12345678";
    const requestId = "request_12345678";
    const purpose = "Synthetic professional review";
    const bundle = (status: "pending" | "granted") => ({
      personRef: person, bundleId, purpose, durationSeconds: 168 * 3600, cancelled: false,
      items: [{ requestId, scopeRef, label: "Professional Domain", sensitivity: "standard", status }],
    });
    mocks.getViewer.mockResolvedValue({ ...page(1), requestableScopes: [
      { scopeRef, label: "Professional Domain", description: null, domain: "professional", sensitivity: "standard", wildcard: true, pathSegments: [] },
    ] });
    mocks.create.mockResolvedValue(bundle("pending"));
    let finishStaleRead: ((value: ReturnType<typeof bundle>) => void) | undefined;
    mocks.getInformationRequest.mockImplementationOnce(() => new Promise((resolve) => {
      finishStaleRead = resolve;
    }));
    mocks.getInformationRequestExports.mockResolvedValue([{
      requestId, scopeRef,
      encryptedExport: {
        request_id: requestId, scope: "attr.professional.*", export_revision: 1,
        export_envelope: { version: 2, export_id: "export-1", aad: {
          version: 2, app_id: "agent_one", grant_id: requestId, export_id: "export-1",
          revision: 1, machine_scope: "attr.professional.*", payload_algorithm: "AES-256-GCM",
          expires_at_ms: Date.now() + 3600_000,
        } },
      },
    }]);
    mocks.decryptScopedExport.mockResolvedValue({ professional: { role: "Synthetic analyst" } });

    const onInformationRequestSubmitted = vi.fn(async () => undefined);
    const view = render(<AgentStructuredExperienceView experience={experience}
      onInformationRequestSubmitted={onInformationRequestSubmitted} />);
    fireEvent.click(await screen.findByRole("button", { name: "Professional Domain" }));
    fireEvent.click(screen.getByRole("button", { name: "Review request" }));
    fireEvent.change(screen.getByTestId("chat-request-purpose"), { target: { value: purpose } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText("Request sent to Synthetic Recipient")).toBeInTheDocument();
    expect(screen.queryByTestId("shared-with-you-values")).toBeNull();
    expect(onInformationRequestSubmitted).toHaveBeenCalledWith({
      bundleId, subjectRef: person, idempotencyKey: expect.any(String),
      // The sent card itself, labels only, so the chat shows "Request sent"
      // whether or not its history receipt is recorded.
      review: expect.objectContaining({ phase: "submitted", bundleId, subjectRef: person }),
    });
    expect(JSON.stringify(onInformationRequestSubmitted.mock.calls)).not.toContain("Synthetic analyst");
    await waitFor(() => expect(mocks.getInformationRequest).toHaveBeenCalledWith({ bundleId, vaultOwnerToken: "test-owner-token" }));
    expect(mocks.decryptScopedExport).not.toHaveBeenCalled();

    mocks.getInformationRequest.mockResolvedValue(bundle("granted"));
    act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: {
      source: "information_request_updated", action: "CONSENT_GRANTED", bundleId, requestId,
    } })));
    expect(await screen.findByTestId("shared-with-you-values")).toHaveTextContent("Synthetic analyst");
    expect(mocks.getInformationRequestExports).toHaveBeenCalledWith({ bundleId, vaultOwnerToken: "test-owner-token" });
    await act(async () => finishStaleRead?.(bundle("pending")));
    expect(screen.getByTestId("shared-with-you-values")).toHaveTextContent("Synthetic analyst");

    await act(async () => {
      mocks.unlocked = false;
      view.rerender(<AgentStructuredExperienceView experience={experience} />);
    });
    expect(screen.queryByText("Synthetic analyst")).toBeNull();
    await act(async () => {
      mocks.user.uid = "reviewer-b";
      mocks.unlocked = true;
      view.rerender(<AgentStructuredExperienceView experience={experience} />);
    });
    expect(await screen.findByRole("button", { name: "Professional Domain" })).toBeInTheDocument();
    expect(screen.queryByText("Synthetic analyst")).toBeNull();
    expect(screen.queryByText("Request sent to Synthetic Recipient")).toBeNull();
  });

  it("does not promote a submitted response bound to another subject", async () => {
    mocks.create.mockResolvedValue({
      personRef: "another-subject-ref", bundleId: "bundle_12345678",
      purpose: "Synthetic sharing rehearsal", durationSeconds: 168 * 3600, cancelled: false,
      items: [{ requestId: "request_12345678", scopeRef: "scope-1", label: "Synthetic field 1", sensitivity: "standard", status: "pending" }],
    });
    render(<AgentStructuredExperienceView experience={experience} />);
    fireEvent.click(await screen.findByText("Synthetic field 1"));
    fireEvent.click(screen.getByText("Review request"));
    fireEvent.change(screen.getByTestId("chat-request-purpose"), { target: { value: "Synthetic sharing rehearsal" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText(/Request sent\. They can now review/)).toBeInTheDocument();
    expect(screen.queryByText("Request sent to Synthetic Recipient")).toBeNull();
    expect(mocks.getInformationRequest).not.toHaveBeenCalled();
  });

  it("does not promote a bundle that repeats one scope instead of matching the selected set", async () => {
    const profile = page(1);
    profile.requestableScopes.push({
      scopeRef: "scope-2", label: "Synthetic field 2", description: null,
      domain: "professional", sensitivity: "standard", wildcard: false,
    });
    mocks.getViewer.mockResolvedValue(profile);
    mocks.create.mockResolvedValue({
      personRef: person, bundleId: "bundle_12345678",
      purpose: "Synthetic sharing rehearsal", durationSeconds: 168 * 3600, cancelled: false,
      items: [1, 2].map(number => ({
        requestId: `request_1234567${number}`, scopeRef: "scope-1", label: "Synthetic field 1",
        sensitivity: "standard", status: "pending",
      })),
    });
    render(<AgentStructuredExperienceView experience={experience} />);
    fireEvent.click(await screen.findByText("Synthetic field 1"));
    fireEvent.click(screen.getByText("Synthetic field 2"));
    fireEvent.click(screen.getByText("Review request"));
    fireEvent.change(screen.getByTestId("chat-request-purpose"), { target: { value: "Synthetic sharing rehearsal" } });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));
    expect(await screen.findByText(/Request sent\. They can now review/)).toBeInTheDocument();
    expect(mocks.getInformationRequest).not.toHaveBeenCalled();
  });

  it("clears selected fields when continuation reports a changed catalog", async () => {
    const reset = page(1, "b".repeat(64)); reset.requestableScopes[0]!.scopeRef = "replacement"; reset.scopeCatalog!.paginationReset = true;
    mocks.getViewer.mockResolvedValueOnce(page(1)).mockResolvedValueOnce(reset);
    render(<AgentStructuredExperienceView experience={experience} />);
    fireEvent.click(await screen.findByText("Synthetic field 1"));
    expect(screen.getByText("Review request")).toBeEnabled();
    fireEvent.click(screen.getByText("Load more information"));
    await waitFor(() => expect(screen.getByText("Review request")).toBeDisabled());
  });

  it("does not present a failed check as an empty catalog", async () => {
    mocks.getViewer.mockRejectedValue(new Error("unavailable"));
    render(<AgentStructuredExperienceView experience={experience} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn’t check");
    expect(screen.queryByText("Nothing is currently available to request.")).not.toBeInTheDocument();
  });

  it("keeps a legacy card display-only when it has no bound subject reference", async () => {
    const legacy = { ...experience, person: { ...experience.person, personRef: null } };
    render(<AgentStructuredExperienceView experience={legacy} />);
    expect(await screen.findByText("This saved card cannot be used to make a request. Ask One to check again.")).toBeInTheDocument();
    expect(mocks.getViewer).not.toHaveBeenCalled();
  });

  it("reconciles restored item status by request identity, not duplicate labels", async () => {
    const restored: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1",
      personName: "Synthetic Recipient",
      purpose: "Compare two independently requested records.",
      durationLabel: "2 days",
      direction: "outgoing",
      phase: "submitted",
      subjectRef: person,
      bundleId: "bundle_12345678",
      requestId: null,
      status: "mixed",
      fields: [
        { label: "Same label", domain: "Financial", requestId: "request_12345678", sensitivity: "standard" },
        { label: "Same label", domain: "Financial", requestId: "request_22345678", sensitivity: "standard" },
      ],
    };
    mocks.getInformationRequest.mockResolvedValue({
      bundleId: "bundle_12345678",
      personRef: person,
      purpose: restored.purpose,
      durationSeconds: 172800,
      cancelled: false,
      items: [
        { requestId: "request_12345678", scopeRef: "scope-1", label: "Same label", sensitivity: "standard", status: "denied" },
        { requestId: "request_22345678", scopeRef: "scope-2", label: "Same label", sensitivity: "standard", status: "granted" },
      ],
    });
    render(<AgentStructuredExperienceView experience={restored} />);
    await waitFor(() => expect(mocks.getInformationRequest).toHaveBeenCalledWith({ bundleId: restored.bundleId, vaultOwnerToken: "test-owner-token" }));
    expect(await screen.findByText("Declined")).toBeInTheDocument();
    expect(await screen.findByText("Granted")).toBeInTheDocument();
  });

  it("fails closed when a restored status response belongs to another person", async () => {
    const restored: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1",
      personName: "Synthetic Recipient",
      purpose: "Check the selected recipient only.",
      durationLabel: "2 days",
      direction: "outgoing",
      phase: "submitted",
      subjectRef: person,
      bundleId: "bundle_12345678",
      requestId: null,
      status: "pending",
      fields: [{ label: "Professional role", domain: "Professional", sensitivity: "standard" }],
    };
    mocks.getInformationRequest.mockResolvedValue({
      bundleId: restored.bundleId,
      personRef: "fedcba0987654321",
      purpose: restored.purpose,
      durationSeconds: 172800,
      cancelled: false,
      items: [{ requestId: "request_12345678", scopeRef: "scope-other", label: "Professional role", sensitivity: "standard", status: "granted" }],
    });

    render(<AgentStructuredExperienceView experience={restored} />);

    expect(await screen.findByText(/Current status unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Checking current status…")).not.toBeInTheDocument();
    expect(screen.queryByText("Access granted")).not.toBeInTheDocument();
  });

  it("rejects a different bundle even for the same person", async () => {
    const restored: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1",
      personName: "Synthetic Recipient",
      purpose: "Review a request.",
      durationLabel: "2 days",
      direction: "outgoing",
      phase: "submitted",
      subjectRef: person,
      bundleId: "bundle_12345678",
      requestId: null,
      status: "pending",
      fields: [{ label: "Professional role", domain: "Professional", sensitivity: "standard" }],
    };
    mocks.getInformationRequest.mockResolvedValue({
      bundleId: "bundle_22345678",
      personRef: person,
      purpose: restored.purpose,
      durationSeconds: 172800,
      cancelled: false,
      items: [{ requestId: "request_12345678", scopeRef: "scope-1", label: "Professional role", sensitivity: "standard", status: "granted" }],
    });

    render(<AgentStructuredExperienceView experience={restored} />);
    expect(await screen.findByText(/Current status unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("Access granted")).not.toBeInTheDocument();
  });

  it("takes current field labels and states from the authorized bundle, not a saved label", async () => {
    const restored: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1",
      personName: "Synthetic Recipient",
      purpose: "Review a request.",
      durationLabel: "2 days",
      direction: "outgoing",
      phase: "submitted",
      subjectRef: person,
      bundleId: "bundle_12345678",
      requestId: null,
      status: "pending",
      fields: [{ label: "Stale label", domain: "Professional", sensitivity: "standard" }],
    };
    mocks.getInformationRequest.mockResolvedValue({
      bundleId: restored.bundleId,
      personRef: person,
      purpose: restored.purpose,
      durationSeconds: 172800,
      cancelled: false,
      items: [{ requestId: "request_12345678", scopeRef: "scope-1", label: "Current label", sensitivity: "standard", status: "granted" }],
    });

    render(<AgentStructuredExperienceView experience={restored} />);
    expect(await screen.findByText("Current label")).toBeInTheDocument();
    expect(screen.queryByText("Stale label")).toBeNull();
    expect(screen.getByText("Consent approved")).toBeInTheDocument();
  });

  it("shows an approved value inside Chat at once, using the stored browser connector", async () => {
    const restored: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1", personName: "Synthetic Recipient",
      purpose: "Review approved information.", durationLabel: "2 days",
      direction: "outgoing", phase: "submitted", subjectRef: person,
      bundleId: "bundle_12345678", requestId: "request_12345678", status: "pending",
      fields: [{ label: "Professional role", domain: "Professional", sensitivity: "standard", requestId: "request_12345678" }],
    };
    mocks.getInformationRequest.mockResolvedValue({
      bundleId: restored.bundleId, personRef: person, purpose: restored.purpose,
      durationSeconds: 172800, cancelled: false,
      items: [{ requestId: "request_12345678", scopeRef: "scope-1", label: "Professional role", sensitivity: "standard", status: "granted" }],
    });
    mocks.getInformationRequestExports.mockResolvedValue([{
      requestId: "request_12345678", scopeRef: "scope-1",
      encryptedExport: {
        request_id: "request_12345678", scope: "attr.professional.role", export_revision: 1,
        export_envelope: { version: 2, export_id: "export-1", aad: {
          version: 2, app_id: "agent_one", grant_id: "request_12345678", export_id: "export-1",
          revision: 1, machine_scope: "attr.professional.role", scope_handle: "scope-handle",
          recipient_key_fingerprint: "fingerprint", payload_algorithm: "AES-256-GCM",
          expires_at_ms: Date.now() + 3600_000,
        } },
      },
    }]);
    mocks.decryptScopedExport.mockResolvedValue({ professional: { role: "Synthetic analyst" } });

    render(<AgentStructuredExperienceView experience={restored} />);
    expect(await screen.findByTestId("shared-with-you-values")).toHaveTextContent("Synthetic analyst");
    // No reveal control: the secure card is the answer (CONTRACT-2 decision 2).
    expect(screen.queryByRole("button", { name: "View shared information" })).toBeNull();
    expect(mocks.readStoredConnector).toHaveBeenCalledTimes(1);
    expect(mocks.decryptScopedExport).toHaveBeenCalledTimes(1);
    mocks.getInformationRequest.mockResolvedValue({
      bundleId: restored.bundleId, personRef: person, purpose: restored.purpose,
      durationSeconds: 172800, cancelled: false,
      items: [{ requestId: "request_12345678", scopeRef: "scope-1", label: "Professional role", sensitivity: "standard", status: "revoked" }],
    });
    act(() => window.dispatchEvent(new Event("consent-state-changed")));
    await waitFor(() => expect(screen.queryByTestId("shared-with-you-values")).toBeNull());
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
  });

  it("opens a newly granted bundle on a matching requester doorbell, not another bundle", async () => {
    const restored: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1", personName: "Synthetic Recipient",
      purpose: "Review approved information.", durationLabel: "2 days",
      direction: "outgoing", phase: "submitted", subjectRef: person,
      bundleId: "bundle_12345678", requestId: "request_12345678", status: "pending",
      fields: [{ label: "Professional role", domain: "Professional", sensitivity: "standard", requestId: "request_12345678" }],
    };
    const bundle = (status: "pending" | "granted") => ({
      bundleId: restored.bundleId, personRef: person, purpose: restored.purpose,
      durationSeconds: 172800, cancelled: false,
      items: [{ requestId: "request_12345678", scopeRef: "scope-1", label: "Professional role", sensitivity: "standard", status }],
    });
    mocks.getInformationRequest.mockResolvedValue(bundle("pending"));
    mocks.getInformationRequestExports.mockResolvedValue([{
      requestId: "request_12345678", scopeRef: "scope-1",
      encryptedExport: {
        request_id: "request_12345678", scope: "attr.professional.role", export_revision: 1,
        export_envelope: { version: 2, export_id: "export-1", aad: {
          version: 2, app_id: "agent_one", grant_id: "request_12345678", export_id: "export-1",
          revision: 1, machine_scope: "attr.professional.role", scope_handle: "scope-handle",
          recipient_key_fingerprint: "fingerprint", payload_algorithm: "AES-256-GCM",
          expires_at_ms: Date.now() + 3600_000,
        } },
      },
    }]);
    mocks.decryptScopedExport.mockResolvedValue({ professional: { role: "Synthetic analyst" } });

    render(<AgentStructuredExperienceView experience={restored} />);
    expect(await screen.findByText("Waiting for Synthetic Recipient's approval")).toBeInTheDocument();
    mocks.getInformationRequest.mockResolvedValue(bundle("granted"));
    act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: {
      source: "information_request_updated", action: "CONSENT_GRANTED", bundleId: "another-bundle", requestId: "request_12345678",
    } })));
    expect(mocks.decryptScopedExport).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: {
      source: "information_request_updated", action: "CONSENT_GRANTED", bundleId: restored.bundleId, requestId: "request_12345678",
    } })));
    expect(await screen.findByTestId("shared-with-you-values")).toHaveTextContent("Synthetic analyst");
    expect(mocks.decryptScopedExport).toHaveBeenCalledTimes(1);
  });

  it("waits for the owner's approval, then continues the asking chat exactly once", async () => {
    clearSentInformationRequests(null);
    const sent: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1", personName: "Synthetic Recipient",
      purpose: "Plan a dinner.", durationLabel: "1 day",
      direction: "outgoing", phase: "submitted", subjectRef: person,
      bundleId: "0f0e0d0c-0b0a-4908-8706-050403020100", requestId: null, status: "pending",
      fields: [{ label: "Allergies", domain: "Health", sensitivity: "sensitive", requestId: "request_12345678" }],
    };
    const bundle = (status: "pending" | "granted" | "denied") => ({
      bundleId: sent.bundleId, personRef: person, purpose: sent.purpose, durationSeconds: 86400, cancelled: false,
      items: [{ requestId: "request_12345678", scopeRef: "scope-1", label: "Allergies", sensitivity: "sensitive", status }],
    });
    const continueWithOutcome = vi.fn(async () => true);
    mocks.getInformationRequest.mockResolvedValue(bundle("pending"));
    render(
      <AgentConsentContinuationContext.Provider value={{ conversationId: "conversation-1", continueWithOutcome }}>
        <AgentStructuredExperienceView experience={sent} />
      </AgentConsentContinuationContext.Provider>,
    );
    expect(await screen.findByText("Waiting for Synthetic Recipient's approval")).toBeInTheDocument();
    expect(continueWithOutcome).not.toHaveBeenCalled();

    mocks.getInformationRequest.mockResolvedValue(bundle("granted"));
    const doorbell = () => act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: {
      source: "information_request_updated", action: "CONSENT_GRANTED", bundleId: sent.bundleId, requestId: "request_12345678",
    } })));
    doorbell();
    expect(await screen.findByText("Consent approved")).toBeInTheDocument();
    await waitFor(() => expect(continueWithOutcome).toHaveBeenCalledTimes(1));
    expect(continueWithOutcome).toHaveBeenCalledWith(expect.objectContaining({ bundleId: sent.bundleId, outcome: "granted", subjectRef: person }));
    doorbell();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(continueWithOutcome).toHaveBeenCalledTimes(1);
  });

  // Run 4 (R3): every refetch re-ran the continuation and dropped it before
  // its slow ledger check returned, so the answer never continued in place.
  it("continues once even when refreshes land faster than its slow ledger check", async () => {
    clearSentInformationRequests(null);
    vi.useFakeTimers();
    try {
      const bundleId = "2f0e0d0c-0b0a-4908-8706-050403020100";
      mocks.consentOutcomes.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({}), 3_000)));
      mocks.getInformationRequest.mockResolvedValue({
        bundleId, personRef: person, purpose: "Plan a dinner.", durationSeconds: 86400, cancelled: false,
        items: [{ requestId: "request_slow", scopeRef: "scope-1", label: "Allergies", sensitivity: "sensitive", status: "denied" }],
      });
      armConsentContinuation(mocks.user.uid, bundleId);
      const continueWithOutcome = vi.fn(async () => true);
      render(
        <AgentConsentContinuationContext.Provider value={{ conversationId: "conversation-1", continueWithOutcome }}>
          <AgentStructuredExperienceView experience={{
            type: "one.information_request_review.v1", personName: "Synthetic Recipient", purpose: "Plan a dinner.",
            durationLabel: "1 day", direction: "outgoing", phase: "submitted", subjectRef: person, bundleId,
            requestId: null, status: "pending", fields: [{ label: "Allergies", domain: "Health", sensitivity: "sensitive", requestId: "request_slow" }],
          }} />
        </AgentConsentContinuationContext.Provider>,
      );
      // A refresh every 2s (focus, events, readings), for 12s.
      for (let tick = 0; tick < 6; tick += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
          window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: {
            source: "information_request_updated", action: "CONSENT_DENIED", bundleId, requestId: "request_slow",
          } }));
        });
      }
      // Continued while the refreshes were still landing, exactly once.
      expect(continueWithOutcome).toHaveBeenCalledTimes(1);
      expect(continueWithOutcome).toHaveBeenCalledWith(expect.objectContaining({ bundleId, outcome: "denied" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(continueWithOutcome).toHaveBeenCalledTimes(1);
    } finally {
      mocks.consentOutcomes.mockImplementation(async () => ({}));
      vi.useRealTimers();
    }
  });

  it("never replays an answer for an old chat it did not see waiting", async () => {
    clearSentInformationRequests(null);
    const continueWithOutcome = vi.fn(async () => true);
    mocks.getInformationRequest.mockResolvedValue({
      bundleId: "1f0e0d0c-0b0a-4908-8706-050403020100", personRef: person, purpose: "Old.", durationSeconds: 86400, cancelled: false,
      items: [{ requestId: "request_old", scopeRef: "scope-1", label: "Allergies", sensitivity: "sensitive", status: "denied" }],
    });
    render(
      <AgentConsentContinuationContext.Provider value={{ conversationId: "conversation-1", continueWithOutcome }}>
        <AgentStructuredExperienceView experience={{
          type: "one.information_request_review.v1", personName: "Synthetic Recipient", purpose: "Old.", durationLabel: "1 day",
          direction: "outgoing", phase: "submitted", subjectRef: person, bundleId: "1f0e0d0c-0b0a-4908-8706-050403020100",
          requestId: null, status: "pending", fields: [{ label: "Allergies", domain: "Health", sensitivity: "sensitive", requestId: "request_old" }],
        }} />
      </AgentConsentContinuationContext.Provider>,
    );
    expect(await screen.findByText("Request declined")).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(continueWithOutcome).not.toHaveBeenCalled();
  });

  it("rejects a swapped export scope before decrypting it", async () => {
    const restored: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1", personName: "Synthetic Recipient",
      purpose: "Review approved information.", durationLabel: "2 days",
      direction: "outgoing", phase: "submitted", subjectRef: person,
      bundleId: "bundle_12345678", requestId: "request_12345678", status: "pending",
      fields: [{ label: "Professional role", domain: "Professional", sensitivity: "standard", requestId: "request_12345678" }],
    };
    mocks.getInformationRequest.mockResolvedValue({
      bundleId: restored.bundleId, personRef: person, purpose: restored.purpose,
      durationSeconds: 172800, cancelled: false,
      items: [{ requestId: "request_12345678", scopeRef: "scope-1", label: "Professional role", sensitivity: "standard", status: "granted" }],
    });
    mocks.getInformationRequestExports.mockResolvedValue([{
      requestId: "request_12345678", scopeRef: "another-scope",
      encryptedExport: { request_id: "request_12345678" },
    }]);

    render(<AgentStructuredExperienceView experience={restored} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t be opened/);
    expect(screen.queryByTestId("shared-with-you-values")).toBeNull();
    expect(mocks.decryptScopedExport).not.toHaveBeenCalled();
  });

  it("does not decrypt an export that arrives after the vault locks", async () => {
    const restored: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1", personName: "Synthetic Recipient",
      purpose: "Review approved information.", durationLabel: "2 days",
      direction: "outgoing", phase: "submitted", subjectRef: person,
      bundleId: "bundle_12345678", requestId: "request_12345678", status: "granted",
      fields: [{ label: "Professional role", domain: "Professional", sensitivity: "standard", requestId: "request_12345678" }],
    };
    mocks.getInformationRequest.mockResolvedValue({
      bundleId: restored.bundleId, personRef: person, purpose: restored.purpose,
      durationSeconds: 172800, cancelled: false,
      items: [{ requestId: "request_12345678", scopeRef: "scope-1", label: "Professional role", sensitivity: "standard", status: "granted" }],
    });
    let resolveExports!: (value: unknown[]) => void;
    mocks.getInformationRequestExports.mockReturnValue(new Promise(done => { resolveExports = done; }));

    const view = render(<AgentStructuredExperienceView experience={restored} />);
    await waitFor(() => expect(mocks.getInformationRequestExports).toHaveBeenCalled());
    mocks.unlocked = false;
    view.rerender(<AgentStructuredExperienceView experience={restored} />);
    await act(async () => resolveExports([]));
    expect(mocks.decryptScopedExport).not.toHaveBeenCalled();
    expect(screen.queryByTestId("shared-with-you-values")).not.toBeInTheDocument();
  });

  it("opens only what is still shared after the notified item is revoked", async () => {
    const restored: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1", personName: "Synthetic Recipient",
      purpose: "Review approved information.", durationLabel: "2 days",
      direction: "outgoing", phase: "submitted", subjectRef: person,
      bundleId: "bundle_12345678", requestId: null, status: "pending",
      fields: [
        { label: "Professional role", domain: "Professional", sensitivity: "standard", requestId: "request_12345678" },
        { label: "Professional title", domain: "Professional", sensitivity: "standard", requestId: "request_22345678" },
      ],
    };
    const bundle = (firstStatus: "pending" | "granted" | "revoked") => ({
      bundleId: restored.bundleId, personRef: person, purpose: restored.purpose,
      durationSeconds: 172800, cancelled: false,
      items: [
        { requestId: "request_12345678", scopeRef: "scope-1", label: "Professional role", sensitivity: "standard", status: firstStatus },
        { requestId: "request_22345678", scopeRef: "scope-2", label: "Professional title", sensitivity: "standard", status: "granted" },
      ],
    });
    const exportFor = (requestId: string, scopeRef: string, scope: string) => ({
      requestId, scopeRef,
      encryptedExport: {
        request_id: requestId, scope, export_revision: 1,
        export_envelope: { version: 2, export_id: `export-${requestId}`, aad: {
          version: 2, app_id: "agent_one", grant_id: requestId, export_id: `export-${requestId}`,
          revision: 1, machine_scope: scope, scope_handle: "scope-handle",
          recipient_key_fingerprint: "fingerprint", payload_algorithm: "AES-256-GCM",
          expires_at_ms: Date.now() + 3600_000,
        } },
      },
    });
    mocks.getInformationRequestExports.mockResolvedValue([
      exportFor("request_12345678", "scope-1", "attr.professional.role"),
      exportFor("request_22345678", "scope-2", "attr.professional.title"),
    ]);
    mocks.decryptScopedExport.mockResolvedValue({ professional: { title: "Synthetic lead" } });
    mocks.getInformationRequest.mockResolvedValue(bundle("revoked"));
    render(<AgentStructuredExperienceView experience={restored} />);
    act(() => window.dispatchEvent(new CustomEvent("consent-state-changed", { detail: {
      source: "information_request_updated", action: "REVOKED", bundleId: restored.bundleId, requestId: "request_12345678",
    } })));
    const values = await screen.findByTestId("shared-with-you-values");
    expect(values).toHaveTextContent("Synthetic lead");
    // The revoked item is never opened, not even for a moment.
    const opened = mocks.decryptScopedExport.mock.calls.map(([arg]) => (arg as { exportPackage: { request_id: string } }).exportPackage.request_id);
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((id) => id === "request_22345678")).toBe(true);
    expect(screen.getByTestId("shared-with-you-card").textContent).not.toContain("Professional role");
  });

  it("does not refresh current status for an unbound historical card", async () => {
    const historical: InformationRequestReviewExperience = {
      type: "one.information_request_review.v1",
      personName: "Legacy Recipient",
      purpose: "Historical request preview.",
      durationLabel: "2 days",
      direction: "unknown",
      phase: "historical",
      subjectRef: null,
      bundleId: "bundle_12345678",
      requestId: null,
      status: "pending",
      fields: [{ label: "Professional role", domain: "Professional", sensitivity: "standard" }],
    };

    render(<AgentStructuredExperienceView experience={historical} />);

    expect(await screen.findByText("Historical preview · current status was not checked")).toBeInTheDocument();
    expect(mocks.getInformationRequest).not.toHaveBeenCalled();
  });

  it("discards a late catalog after lock instead of displaying private-session state", async () => {
    let resolve!: (value: ViewerPersonProfile) => void;
    mocks.getViewer.mockReturnValue(new Promise<ViewerPersonProfile>(done => { resolve = done; }));
    const view = render(<AgentStructuredExperienceView experience={experience} />);
    await waitFor(() => expect(mocks.getViewer).toHaveBeenCalled());
    mocks.unlocked = false;
    view.rerender(<AgentStructuredExperienceView experience={experience} />);
    await act(async () => resolve(page(1)));
    expect(screen.queryByText("Synthetic field 1")).not.toBeInTheDocument();
    expect(screen.getByText("Unlock your vault to continue here.")).toBeInTheDocument();
  });
});

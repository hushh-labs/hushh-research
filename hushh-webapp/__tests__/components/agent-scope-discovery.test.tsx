import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeDiscoveryExperience } from "@/lib/agent/agui-structured-experiences";
import type { ViewerPersonProfile } from "@/lib/services/person-profile-service";

const mocks = vi.hoisted(() => ({
  user: { uid: "reviewer-a", getIdToken: vi.fn(async () => "test-token") },
  unlocked: true, getViewer: vi.fn(), create: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: mocks.unlocked, vaultKey: "test-key", vaultOwnerToken: "test-owner-token" }) }));
vi.mock("@/lib/services/person-profile-service", async importOriginal => ({
  ...await importOriginal<object>(),
  PersonProfileService: { getViewer: mocks.getViewer, createInformationRequest: mocks.create },
}));
vi.mock("@/lib/services/one-kyc-client-zk-service", () => ({ OneKycClientZkService: { ensureConnector: async () => ({ connector_key_id: "test-connector" }) } }));
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

import { AgentStructuredExperienceView } from "@/components/agent/agent-structured-experience";

const person = "1234567890abcdef";
const experience: ScopeDiscoveryExperience = {
  type: "one.scope_discovery.v1", person: { displayName: "Synthetic Recipient", profilePath: `/people/${person}`, relationship: "connected" },
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
  beforeEach(() => { vi.clearAllMocks(); mocks.unlocked = true; mocks.getViewer.mockResolvedValue(page(1)); mocks.create.mockResolvedValue({ bundleId: "test-bundle" }); });
  afterEach(cleanup);

  it("refreshes retained descriptors, loads consecutive pages, and never replays actions", async () => {
    mocks.getViewer.mockResolvedValueOnce(page(1)).mockResolvedValueOnce(page(2));
    render(<AgentStructuredExperienceView experience={experience} />);
    expect(screen.queryByText("Stale history label")).not.toBeInTheDocument();
    await screen.findByText("Synthetic field 1");
    fireEvent.click(screen.getByText("Load more fields"));
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

  it("clears selected fields when continuation reports a changed catalog", async () => {
    const reset = page(1, "b".repeat(64)); reset.requestableScopes[0]!.scopeRef = "replacement"; reset.scopeCatalog!.paginationReset = true;
    mocks.getViewer.mockResolvedValueOnce(page(1)).mockResolvedValueOnce(reset);
    render(<AgentStructuredExperienceView experience={experience} />);
    fireEvent.click(await screen.findByText("Synthetic field 1"));
    expect(screen.getByText("Review request")).toBeEnabled();
    fireEvent.click(screen.getByText("Load more fields"));
    await waitFor(() => expect(screen.getByText("Review request")).toBeDisabled());
  });

  it("does not present a failed check as an empty catalog", async () => {
    mocks.getViewer.mockRejectedValue(new Error("unavailable"));
    render(<AgentStructuredExperienceView experience={experience} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn’t check");
    expect(screen.queryByText("Nothing is currently available to request.")).not.toBeInTheDocument();
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

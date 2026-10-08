import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import type { AgentPkmPreviewCard } from "@/lib/agent/agent-pkm-memory";

const mocks = vi.hoisted(() => ({ get: vi.fn(), load: vi.fn(), prepare: vi.fn(), save: vi.fn(), decide: vi.fn(), create: vi.fn(), attach: vi.fn(), syntheticPreview: vi.fn() }));
vi.mock("@/lib/services/business-suggestion-service", () => ({ BusinessSuggestionService: { get: mocks.get } }));
vi.mock("@/lib/agent/business-profile-review", () => ({
  BusinessOriginValidationError: class extends Error {},
  loadBusinessReview: mocks.load, saveBusinessReview: mocks.save, decideBusinessReview: mocks.decide,
  createBusinessReviewJob: mocks.create, attachBusinessOrigin: mocks.attach,
  buildSyntheticBusinessPreview: mocks.syntheticPreview,
  businessDraftMessage: (_candidate: unknown, name: string, website: string) => `${name}\n${website}`,
}));
vi.mock("@/lib/agent/connector-memory-review", () => ({ prepareConnectorMemoryReview: mocks.prepare,
  connectorMemorySharingImpact: (cards: AgentPkmPreviewCard[]) => Math.max(0, ...cards.map(card => card.sharing_impact?.active_recipient_count || 0)) }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: vi.fn(), promise: vi.fn() } }));
import { BusinessProfileSuggestion } from "@/components/agent/business-profile-suggestion";
import { AgentBubble } from "@/components/agent/agent-chat-workspace";
const candidate = { businessUid: "urn:hushh:business:uat:hushh.ai:v1", synthetic: true,
  sourceIdentity: { source: "uat_fixture", sourceKey: "hushh.ai:v1" }, draft: { name: "Hushh — UAT Test Business", website: "https://hushh.ai" } };
const cards: AgentPkmPreviewCard[] = [{ card_id: "one", source_text: "Synthetic company detail", write_mode: "confirm_first", target_domain: "professional" }];
const props = { ownerId: "owner", vaultKey: "key", vaultOwnerToken: "token", tokenExpiresAt: Date.now() + 100000, enabled: true };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.clearAllMocks(); publishValidatedAuthSessionOwner("owner");
  mocks.get.mockResolvedValue({ candidates: [candidate] }); mocks.load.mockResolvedValue(null);
  mocks.syntheticPreview.mockReturnValue(cards);
  mocks.prepare.mockResolvedValue({ cards, incomplete: false, alreadySaved: false });
  mocks.save.mockResolvedValue({ saved: 1, remaining: 0 }); mocks.decide.mockResolvedValue(true);
  mocks.create.mockImplementation((_owner, _candidate, message, selected) => ({ cards: selected, message, revision: "synthetic" }));
});
afterEach(() => { cleanup(); publishValidatedAuthSessionOwner(null); });
describe("post-onboarding business suggestion", () => {
  it("offers multiple businesses separately; rejecting one keeps the other available", async () => {
    const second = { ...candidate, businessUid: "second", draft: { name: "Second business", website: "https://second.test" } };
    mocks.get.mockResolvedValue({ candidates: [candidate, second] });
    render(<BusinessProfileSuggestion {...props} />);
    await screen.findByText("Second business");
    expect(screen.getAllByRole("button", { name: "Review details", exact: true })).toHaveLength(2);
    expect(mocks.prepare).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Not my business", exact: true })[0]!);
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ businessUid: candidate.businessUid })));
    expect(screen.getByText("Second business")).toBeTruthy();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("opens a visibly synthetic nudge; discovery and preparation never save", async () => {
    const onVisibleChange = vi.fn();
    render(<BusinessProfileSuggestion {...props} onVisibleChange={onVisibleChange}
      renderMessage={(id, text, card) => <AgentBubble message={{ id, role: "assistant", text,
        timestamp: "", status: "done", ephemeral: true }} businessProfileCard={card} />} />);
    expect(await screen.findByRole("region", { name: "Is this your business?" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/I found a business you may be connected to/)).toBeTruthy();
    const region = screen.getByRole("region", { name: "Is this your business?" });
    const assistantBubble = region.closest('[class*="--one-chat-bubble"]');
    expect(assistantBubble?.textContent).toContain("I found a business");
    expect(region.closest('[data-message-role="assistant"]')).toBeTruthy();
    await waitFor(() => expect(onVisibleChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByText(/UAT test suggestion/)).toBeTruthy(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review details", exact: true }));
    await screen.findByText("Synthetic company detail"); expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("agent-pkm-review-save"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Is this your business?" })).toBeNull());
    await waitFor(() => expect(onVisibleChange).toHaveBeenLastCalledWith(false));
  });
  it.each([false, null, Date.now() - 1000])("unknown, expired, or disabled authority does not request a candidate: %s", async value => {
    render(<BusinessProfileSuggestion {...props} {...(value === false ? { enabled: false } : { tokenExpiresAt: value as number | null })} />);
    await act(async () => undefined); expect(mocks.get).not.toHaveBeenCalled();
  });
  it.each(["not_me", "saved", "later"])("durable %s suppresses the nudge without memory writes", async decision => {
    mocks.load.mockResolvedValue({ version: 1, decision, until: Date.now() + 100000 });
    render(<BusinessProfileSuggestion {...props} />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Is this your business?" })).toBeNull(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("Later stores only a decision, never prepares or saves memory", async () => {
    render(<BusinessProfileSuggestion {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "owner", decision: "later" })));
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("editing invalidates the prepared selection and requires another review", async () => {
    mocks.syntheticPreview.mockReturnValue([]);
    render(<BusinessProfileSuggestion {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review details", exact: true }));
    await screen.findByText("Synthetic company detail");
    fireEvent.click(screen.getByRole("button", { name: "Edit details", exact: true }));
    fireEvent.change(screen.getByLabelText("Business name"), { target: { value: "Edited synthetic company" } });
    expect(screen.queryByTestId("agent-pkm-review-save")).toBeNull(); expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review details", exact: true }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2));
    expect(mocks.prepare.mock.calls[1]![0].message).toContain("Edited synthetic company");
  });
  it.each(["owner", "vault", "unmount"])("discards late preparation after %s", async cause => {
    mocks.syntheticPreview.mockReturnValue([]);
    const pending = deferred<{ cards: AgentPkmPreviewCard[]; incomplete: boolean }>(); mocks.prepare.mockReturnValue(pending.promise);
    const root = render(<BusinessProfileSuggestion {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review details", exact: true }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalled());
    if (cause === "owner") { publishValidatedAuthSessionOwner("another"); root.rerender(<BusinessProfileSuggestion {...props} ownerId="another" />); }
    if (cause === "vault") { advanceVaultSessionEpoch(); root.rerender(<BusinessProfileSuggestion {...props} enabled={false} />); }
    if (cause === "unmount") root.unmount();
    await act(async () => { pending.resolve({ cards, incomplete: false }); });
    expect(mocks.save).not.toHaveBeenCalled(); expect(screen.queryByText("Synthetic company detail")).toBeNull();
  });
  it("a changed fresh candidate prevents saving even if the preview was valid", async () => {
    mocks.syntheticPreview.mockReturnValue([]);
    render(<BusinessProfileSuggestion {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review details", exact: true }));
    await screen.findByText("Synthetic company detail"); mocks.get.mockResolvedValue({ candidates: [] });
    fireEvent.click(screen.getByTestId("agent-pkm-review-save"));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

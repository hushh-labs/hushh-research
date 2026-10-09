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
  businessCandidateSnapshot: (candidate: unknown) => JSON.stringify(candidate),
  businessDraftMessage: (_candidate: unknown, name: string, website: string) => `${name}\n${website}`,
}));
vi.mock("@/lib/agent/connector-memory-review", () => ({ prepareConnectorMemoryReview: mocks.prepare,
  connectorMemorySharingImpact: (cards: AgentPkmPreviewCard[]) => Math.max(0, ...cards.map(card => card.sharing_impact?.active_recipient_count || 0)) }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { error: vi.fn(), success: vi.fn(), promise: vi.fn() } }));
import { BusinessProfileSuggestion } from "@/components/agent/business-profile-suggestion";
import { AgentBubble } from "@/components/agent/agent-chat-workspace";
const candidate = { businessUid: "urn:hushh:business:uat:hushh.ai:v1", synthetic: true,
  sourceIdentity: { source: "uat_fixture", sourceKey: "hushh.ai:v1" }, draft: { name: "Hushh — UAT Test Business", website: "https://hushh.ai" } };
const cards: AgentPkmPreviewCard[] = [{ card_id: "one", source_text: "Synthetic company detail", write_mode: "confirm_first", target_domain: "professional",
  candidate_payload: { businesses: { entities: { demo: { name: "Synthetic company detail", phone: "+15555550100" } } } } }];
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
  it("shows pending deferral and refresh, prevents duplicate clicks, and restores controls after failure", async () => {
    const choice = deferred<boolean>();
    mocks.decide.mockReturnValueOnce(choice.promise);
    render(<BusinessProfileSuggestion {...props} />);
    const later = await screen.findByRole("button", { name: "Later", exact: true });
    fireEvent.click(later);
    expect(later).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review details", exact: true })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Saving your choice");
    fireEvent.click(later);
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledTimes(1));
    await act(async () => choice.resolve(false));
    cleanup();
    mocks.load.mockResolvedValue(null);
    render(<BusinessProfileSuggestion {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit details", exact: true }));
    const refreshed = deferred<{ candidates: typeof candidate[] }>();
    mocks.get.mockReturnValueOnce(refreshed.promise);
    const refresh = screen.getByRole("button", { name: "Refresh listing", exact: true });
    fireEvent.click(refresh);
    expect(refresh).toBeDisabled();
    expect(screen.getByLabelText("Business name")).toBeDisabled();
    await act(async () => refreshed.resolve({ candidates: [] }));
    await waitFor(() => expect(refresh).not.toBeDisabled());
    expect(screen.getByLabelText("Business name")).not.toBeDisabled();
  });
  it("shows an actionable version mismatch instead of hiding a failed Review click", async () => {
    mocks.syntheticPreview.mockReturnValue([]);
    const failure = new Error("Synthetic mismatch"); failure.name = "PkmBackendContractMismatch";
    mocks.prepare.mockRejectedValue(failure);
    render(<BusinessProfileSuggestion {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review details", exact: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("backend update finishes");
    expect(screen.getByRole("button", { name: "Review details", exact: true })).not.toBeDisabled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("reviews repeated facts once and deselects all backing fields without leaking record metadata", async () => {
    const repeated = ["a", "b"].map(id => ({ ...cards[0]!, card_id: id,
      candidate_payload: { businesses: { entities: { [id]: { kind: "profile_fact", summary: "state: TX", observations: ["state: TX"], status: "active" } } } } }));
    mocks.syntheticPreview.mockReturnValue(repeated);
    render(<BusinessProfileSuggestion {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review details", exact: true }));
    const state = await screen.findByRole("checkbox", { name: "Save state", exact: true });
    expect(screen.getAllByText("TX", { exact: true })).toHaveLength(1);
    expect(screen.queryByText("profile_fact", { exact: true })).toBeNull();
    fireEvent.click(screen.getByText(/Record details ·/));
    fireEvent.click(screen.getByRole("checkbox", { name: "Save record type", exact: true }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Save record status", exact: true }));
    fireEvent.click(state);
    expect(screen.getByTestId("agent-pkm-review-save")).toBeDisabled();
    fireEvent.click(state);
    fireEvent.click(screen.getByTestId("agent-pkm-review-save"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const saved = mocks.save.mock.calls[0]![0].job.cards;
    for (let index = 0; index < saved.length; index++) expect(saved[index].candidate_payload.businesses.entities[["a", "b"][index]!])
      .toEqual({ summary: "state: TX", observations: ["state: TX"] });
  });
  it("keeps the overview focused and expands selectable details without repeated framing", async () => {
    mocks.get.mockResolvedValue({ candidates: [{ ...candidate, draft: { ...candidate.draft,
      category: "Software", formatted_address: "Austin, TX 78701", zip: "78701", state: "TX", phone: "+15555550100" } }] });
    render(<BusinessProfileSuggestion {...props} />);
    await screen.findByText("Software");
    expect(screen.queryByText("78701", { exact: true })).toBeNull();
    expect(screen.queryByText("TX", { exact: true })).toBeNull();
    expect(screen.queryByText("+15555550100", { exact: true })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review details", exact: true }));
    await screen.findByRole("checkbox", { name: "Save phone", exact: true });
    expect(screen.queryByText("Save this memory?")).toBeNull();
    expect(screen.getByTestId("agent-pkm-review-list")).not.toHaveClass("overflow-y-auto");
  });
  it("dismisses exact duplicates without a new write or ownership claim", async () => {
    mocks.syntheticPreview.mockReturnValue([]);
    mocks.prepare.mockResolvedValue({ cards: [], incomplete: false, alreadySaved: true });
    const onSaved = vi.fn();
    render(<BusinessProfileSuggestion {...props} onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review details", exact: true }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(candidate.businessUid));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it("saves only individually approved fields and disables an empty selection", async () => {
    render(<BusinessProfileSuggestion {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review details", exact: true }));
    const phone = await screen.findByRole("checkbox", { name: "Save phone", exact: true });
    fireEvent.click(phone);
    expect(screen.getByTestId("agent-pkm-review-save")).toHaveTextContent("Save 1 detail");
    fireEvent.click(screen.getByRole("checkbox", { name: "Save business name", exact: true }));
    expect(screen.getByTestId("agent-pkm-review-save")).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Save business name", exact: true }));
    fireEvent.click(screen.getByTestId("agent-pkm-review-save"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const job = mocks.save.mock.calls[0]![0].job;
    expect(job.cards[0].candidate_payload.businesses.entities.demo).toEqual({ name: "Synthetic company detail" });
    expect(JSON.stringify(job)).not.toContain("+15555550100");
  });
  it("retries an unreadable checkpoint without preparing or replacing the pending review", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Cache unavailable"));
    render(<BusinessProfileSuggestion {...props} />);
    const retry = await screen.findByRole("button", { name: "Retry saved review" });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Review details", exact: true })).toBeTruthy();
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.create).not.toHaveBeenCalled();
  });
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
    const onSaved = vi.fn();
    render(<BusinessProfileSuggestion {...props} onVisibleChange={onVisibleChange}
      onSaved={onSaved}
      renderMessage={(id, text, card) => <AgentBubble message={{ id, role: "assistant", text,
        timestamp: "", status: "done", ephemeral: true }} businessProfileCard={card} />} />);
    expect(await screen.findByRole("region", { name: "Is this your business?" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Is this your business?")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Is this your business?" });
    const assistantBubble = region.closest('[class*="--one-chat-bubble"]');
    expect(assistantBubble?.textContent).toContain("Is this your business?");
    expect(region.closest('[data-message-role="assistant"]')).toBeTruthy();
    await waitFor(() => expect(onVisibleChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByText(/UAT test suggestion/)).toBeTruthy(); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review details", exact: true }));
    await screen.findByText("Synthetic company detail"); expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("agent-pkm-review-save"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(candidate.businessUid));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Is this your business?" })).toBeNull());
    await waitFor(() => expect(onVisibleChange).toHaveBeenLastCalledWith(false));
  });
  it.each([false, null, Date.now() - 1000])("unknown, expired, or disabled authority does not request a candidate: %s", async value => {
    render(<BusinessProfileSuggestion {...props} {...(value === false ? { enabled: false } : { tokenExpiresAt: value as number | null })} />);
    await act(async () => undefined); expect(mocks.get).not.toHaveBeenCalled();
  });
  it("shows a retryable state when the directory is unavailable", async () => {
    mocks.get.mockRejectedValueOnce(new Error("directory unavailable"));
    render(<BusinessProfileSuggestion {...props} />);
    expect(await screen.findByText(/temporarily unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry business lookup", exact: true })).toBeTruthy();
  });
  it("explains when verified contacts are insufficient without showing a false no-match", async () => {
    mocks.get.mockResolvedValueOnce({ status: "insufficient_signals", candidates: [], coverageIncomplete: true });
    render(<BusinessProfileSuggestion {...props} />);
    expect(await screen.findByText(/verified contacts could not be used/)).toBeTruthy();
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
  it("rejects a changed public snapshot even when the business UID is unchanged", async () => {
    mocks.syntheticPreview.mockReturnValue([]);
    render(<BusinessProfileSuggestion {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review details", exact: true }));
    await screen.findByText("Synthetic company detail");
    mocks.get.mockResolvedValue({ candidates: [{ ...candidate, draft: { ...candidate.draft, website: "https://changed.test" } }] });
    fireEvent.click(screen.getByTestId("agent-pkm-review-save"));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("reconciles a lost save response from the durable saved checkpoint", async () => {
    mocks.syntheticPreview.mockReturnValue([]);
    let reads = 0;
    mocks.load.mockImplementation(async () => reads++ === 0 ? null : { version: 1, decision: "saved" });
    mocks.save.mockRejectedValueOnce(new Error("response lost after commit"));
    render(<BusinessProfileSuggestion {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review details", exact: true }));
    await screen.findByText("Synthetic company detail");
    fireEvent.click(screen.getByTestId("agent-pkm-review-save"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Is this your business?" })).toBeNull());
  });
});

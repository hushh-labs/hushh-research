import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

// Only the lower layers are mocked: the card, its fetch parser and the Keep
// path (`keepFirstConnectInsight`) run for real, so "nothing is saved until
// Keep" is checked against the one function that writes memory, `addToPKM`.
const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  prepare: vi.fn(),
  addToPKM: vi.fn(),
  clearAgentPkmContext: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mocks.apiFetch } }));
vi.mock("@/lib/vault/one-chat-key", () => ({ oneChatKeyHeaders: async () => ({ "X-Hussh-Chat-Key": "k" }) }));
vi.mock("@/lib/pkm/pkm-natural-language-ingestion", () => ({ prepareNaturalLanguagePkm: mocks.prepare }));
vi.mock("@/lib/agent/agent-pkm-memory", () => ({
  addToPKM: mocks.addToPKM,
  clearAgentPkmContext: mocks.clearAgentPkmContext,
  isReservedPkmCard: (card: { write_mode?: string }) => card.write_mode === "do_not_save",
}));
vi.mock("@/lib/profile/pkm-agent-lab-capture", () => ({
  loadPkmAgentLabContext: async () => ({ metadata: { domains: [{ key: "professional" }] }, manifests: {} }),
}));
vi.mock("@/lib/profile/pkm-agent-lab-preview", () => ({ isDegradedPreviewCard: () => false }));
vi.mock("@/lib/agent/agent-pkm-context-store", () => ({
  AgentPkmContextStore: { findLocalDuplicate: () => ({ kind: "none" }), load: async () => null },
}));

import { FirstConnectInsightsCard } from "@/components/agent/first-connect-insights-card";

const MEETING = "I have a weekly 1:1 with Alex on Mondays";
const NEWSLETTERS = "I get a lot of newsletters from Substack";

function offer() {
  return {
    status: "offered",
    source: "calendar",
    sourceLabel: "Calendar",
    items: [
      { id: "insight-1", kind: "recurring_meeting", label: "You have a weekly 1:1 with Alex on Mondays", memory_text: MEETING, evidence: "4 Monday events" },
      { id: "insight-2", kind: "newsletter_heavy", label: "You get a lot of newsletters from Substack", memory_text: NEWSLETTERS, evidence: "12 senders" },
    ],
  };
}

function preparedCard(sourceText: string, recipients = 0) {
  return {
    cards: [
      {
        card_id: "c1",
        source_text: sourceText,
        write_mode: "confirm_first",
        ...(recipients ? { sharing_impact: { active_recipient_count: recipients } } : {}),
      },
    ],
  };
}

function renderCard() {
  return render(
    <FirstConnectInsightsCard ownerId="owner" vaultKey="vault-key" vaultOwnerToken="vault-token" enabled />,
  );
}

describe("FirstConnectInsightsCard", () => {
  beforeEach(() => {
    publishValidatedAuthSessionOwner("owner");
    mocks.apiFetch.mockReset().mockResolvedValue(new Response(JSON.stringify(offer()), { status: 200 }));
    mocks.prepare.mockReset().mockImplementation(async ({ message }: { message: string }) => preparedCard(message));
    mocks.addToPKM.mockReset().mockResolvedValue({ attempted: 1, saved: 1, failed: 0, domains: ["professional"], results: [] });
    mocks.clearAgentPkmContext.mockReset();
  });
  afterEach(() => { cleanup(); publishValidatedAuthSessionOwner(null); });

  it("shows an approval card and saves nothing until Keep; Forget discards", async () => {
    renderCard();
    expect(await screen.findByTestId("first-connect-insights-card")).toHaveTextContent(
      "Here's what I picked up from Calendar",
    );
    // Asked with the chat's own gate: vault-owner token plus chat key.
    const [, init] = mocks.apiFetch.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer vault-token");
    expect(init.headers["X-Hussh-Chat-Key"]).toBe("k");
    // Shown is not saved.
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();

    // Forget removes the item and writes nothing.
    fireEvent.click(screen.getAllByTestId("first-connect-insight-forget")[1]!);
    expect(screen.getAllByTestId("first-connect-insight")).toHaveLength(1);
    expect(mocks.addToPKM).not.toHaveBeenCalled();

    // Keep saves exactly that one item, owner-confirmed.
    await act(async () => {
      fireEvent.click(screen.getByTestId("first-connect-insight-keep"));
    });
    await waitFor(() => expect(mocks.addToPKM).toHaveBeenCalledTimes(1));
    const save = mocks.addToPKM.mock.calls[0]![0];
    expect(save.sourceMessage).toBe(MEETING);
    expect(save.confirmation).toMatchObject({ confirmedByUser: true, surface: "chat" });
    expect(save.vaultKey).toBe("vault-key");
    // The forgotten item never reached the memory path.
    const everything = JSON.stringify([mocks.prepare.mock.calls, mocks.addToPKM.mock.calls]);
    expect(everything).not.toContain(NEWSLETTERS);
    // Negative control: the same check does catch it when it is there.
    expect(JSON.stringify([everything, NEWSLETTERS])).toContain(NEWSLETTERS);
    expect(await screen.findByTestId("first-connect-insights-receipt")).toHaveTextContent(
      "Kept 1 detail from Calendar",
    );
  });

  it("asks once more before a Keep that would change what others receive", async () => {
    mocks.prepare.mockImplementation(async ({ message }: { message: string }) => preparedCard(message, 2));
    renderCard();
    const keep = (await screen.findAllByTestId("first-connect-insight-keep"))[0]!;
    await act(async () => {
      fireEvent.click(keep);
    });
    expect(await screen.findByText(/share with 2 people/)).toBeInTheDocument();
    expect(mocks.addToPKM).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getAllByTestId("first-connect-insight-keep")[0]!);
    });
    await waitFor(() => expect(mocks.addToPKM).toHaveBeenCalledTimes(1));
    expect(mocks.addToPKM.mock.calls[0]![0].confirmation.sharingImpactAcknowledged).toBe(true);
  });

  it("shows nothing when the server has nothing to offer or the vault is locked", async () => {
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ status: "none" }), { status: 200 }));
    const { container, rerender } = renderCard();
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();

    mocks.apiFetch.mockClear();
    rerender(<FirstConnectInsightsCard ownerId="owner" vaultKey={null} vaultOwnerToken="t" enabled />);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("rejects a former owner's late preparation and clears the old offer immediately", async () => {
    let resolve!: (value: ReturnType<typeof preparedCard>) => void;
    mocks.prepare.mockReturnValue(new Promise(done => { resolve = done; }));
    const root = renderCard(); await screen.findByTestId("first-connect-insights-card");
    fireEvent.click(screen.getAllByTestId("first-connect-insight-keep")[0]);
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
    publishValidatedAuthSessionOwner("other-owner");
    mocks.apiFetch.mockResolvedValue(new Response(JSON.stringify({ status: "none" }), { status: 200 }));
    root.rerender(<FirstConnectInsightsCard ownerId="other-owner" vaultKey="other-key" vaultOwnerToken="other-token" enabled />);
    expect(screen.queryByText("You have a weekly 1:1 with Alex on Mondays")).toBeNull();
    await act(async () => { resolve(preparedCard(MEETING)); });
    expect(mocks.addToPKM).not.toHaveBeenCalled();
  });

  it("keeps an accepted save private when the component unmounts before its receipt", async () => {
    let resolve!: (value: { saved: number }) => void;
    mocks.addToPKM.mockReturnValue(new Promise(done => { resolve = done; }));
    const root = renderCard(); await screen.findByTestId("first-connect-insights-card");
    fireEvent.click(screen.getAllByTestId("first-connect-insight-keep")[0]);
    await waitFor(() => expect(mocks.addToPKM).toHaveBeenCalledTimes(1));
    const write = mocks.addToPKM.mock.calls[0][0];
    root.unmount();
    await act(async () => { resolve({ saved: 1 }); });
    expect(write.mayPublish()).toBe(false);
    expect(mocks.clearAgentPkmContext).not.toHaveBeenCalled();
    expect(screen.queryByTestId("first-connect-insights-receipt")).toBeNull();
  });

  it("does not save late prepared notes after unmount while the same owner stays signed in", async () => {
    let resolve!: (value: ReturnType<typeof preparedCard>) => void;
    mocks.prepare.mockReturnValue(new Promise(done => { resolve = done; }));
    const root = renderCard(); await screen.findByTestId("first-connect-insights-card");
    fireEvent.click(screen.getAllByTestId("first-connect-insight-keep")[0]);
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
    root.unmount();
    await act(async () => { resolve(preparedCard(MEETING)); });
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    expect(mocks.clearAgentPkmContext).not.toHaveBeenCalled();
  });
});

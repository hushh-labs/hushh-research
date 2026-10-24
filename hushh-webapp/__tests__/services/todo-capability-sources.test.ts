import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readTodoCapabilities, type TaskReadContext } from "@/lib/services/todo-capability-sources";

const mocks = vi.hoisted(() => ({ messages: vi.fn(), wallet: vi.fn(), persona: vi.fn(), home: vi.fn(), mail: vi.fn(), invitations: vi.fn(), memory: vi.fn() }));
vi.mock("@/lib/services/direct-messages-service", () => ({ DirectMessagesService: { unreadCount: mocks.messages } }));
vi.mock("@/lib/services/wallet-card-access-service", () => ({ WalletCardAccessService: { listRequests: mocks.wallet } }));
vi.mock("@/lib/services/ria-service", () => ({ RiaService: { getPersonaState: mocks.persona, getHome: mocks.home } }));
vi.mock("@/lib/services/gmail-receipts-service", () => ({ GmailReceiptsService: { listNudges: mocks.mail } }));
vi.mock("@/lib/services/google-calendar-service", () => ({ GoogleCalendarService: { invitations: mocks.invitations } }));
vi.mock("@/lib/pkm/memory-refresh", () => ({ peekLiveMirror: mocks.memory }));
const context = (): TaskReadContext => ({ userId: "owner", vaultOwnerToken: "fixture", getIdToken: async () => "fixture-id", isCurrent: () => true, mailConnected: true, calendarConnected: true, mailStatusKnown: true, calendarStatusKnown: true });
const requestId = "00000000-0000-4000-8000-000000000001";
describe("owner-safe capability task reads", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    vi.clearAllMocks();
    mocks.messages.mockResolvedValue(3);
    mocks.wallet.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
    mocks.persona.mockResolvedValue({ personas: ["investor"] });
    mocks.mail.mockResolvedValue({ nudges: [{ type: "needs_reply", thread_id: "raw-thread", message_id: "raw-message", title: "Reply about the meeting" }] });
    mocks.invitations.mockResolvedValue({ events: [], pending_count: 0, complete: true });
    mocks.memory.mockReturnValue(null);
  });
  it("uses only unread metadata, a supported Mail limit, and opaque provider keys", async () => {
    const result = await readTodoCapabilities(context());
    expect(mocks.messages).toHaveBeenCalledWith({ idToken: "fixture-id" });
    expect(mocks.mail).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw-thread");
    expect(serialized).not.toContain("raw-message");
    expect(result.find(row => row.coverage.capability === "gmail")?.coverage.status).toBe("incomplete");
  });
  it("paginates pending Wallet work and keeps the exact reviewed request destination", async () => {
    mocks.wallet.mockResolvedValueOnce({ items: [{ id: requestId }], hasMore: true, nextCursor: requestId }).mockResolvedValueOnce({ items: [], hasMore: false, nextCursor: null });
    const result = await readTodoCapabilities(context());
    const wallet = result.find(row => row.coverage.capability === "wallet")!;
    expect(mocks.wallet).toHaveBeenCalledTimes(2);
    expect(wallet.coverage.count).toBe(1);
    expect(wallet.evidence[0].href).toContain(`card_request=${requestId}`);
  });
  it("preserves other sources and marks failed reads unavailable", async () => {
    mocks.wallet.mockRejectedValue(new Error("Offline"));
    const result = await readTodoCapabilities(context());
    expect(result.find(row => row.coverage.capability === "wallet")?.coverage.status).toBe("unavailable");
    expect(result.find(row => row.coverage.capability === "messages")?.coverage.count).toBe(3);
  });
  it("never calls unknown connection states disconnected", async () => {
    const result = await readTodoCapabilities({ ...context(), mailConnected: false, mailStatusKnown: false, calendarConnected: false, calendarStatusKnown: false });
    expect(result.filter(row => ["gmail", "calendar"].includes(row.coverage.capability)).every(row => row.coverage.status === "unavailable")).toBe(true);
    expect(mocks.mail).not.toHaveBeenCalled();
    expect(mocks.invitations).not.toHaveBeenCalled();
  });
  it("does not confuse an investor persona with a disconnected Advisor", async () => {
    const result = await readTodoCapabilities(context());
    expect(result.find(row => row.coverage.capability === "ria")?.coverage.status).toBe("unavailable");
    expect(mocks.home).not.toHaveBeenCalled();
  });
  it("projects explicit Advisor attention work with its reviewed internal destination", async () => {
    mocks.persona.mockResolvedValue({ personas: ["ria", "investor"] });
    mocks.home.mockResolvedValue({ needs_attention: [{ id: "attention-one", title: "Review the client request", next_action: "Review request", href: "/ria/requests" }], counts: { needs_attention: 1 } });
    const result = await readTodoCapabilities(context());
    const advisor = result.find(row => row.coverage.capability === "ria")!;
    expect(advisor.coverage).toEqual({ capability: "ria", count: 1, status: "ready" });
    expect(advisor.evidence[0]).toMatchObject({ pendingTitle: "Review request", href: "/ria/requests" });
  });
  it("does not release an old owner's results", async () => {
    let current = true;
    mocks.messages.mockImplementation(async () => { current = false; return 3; });
    await expect(readTodoCapabilities({ ...context(), isCurrent: () => current })).rejects.toThrow("Session changed");
  });
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ history: vi.fn(), revoke: vi.fn(), profile: vi.fn(), subscribe: vi.fn(), current: true }));
vi.mock("@/lib/services/wallet-card-access-service", () => ({ WalletCardAccessService: mocks }));
vi.mock("@/components/profile/settings-ui", () => ({
  SettingsPresentationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SettingsGroup: ({ title, children }: { title: string; children: React.ReactNode }) => <section aria-label={title}>{children}</section>,
  SettingsRow: ({ title, description, trailing }: { title: string; description: React.ReactNode; trailing: React.ReactNode }) => <div>{title}{description}{trailing}</div>,
}));
vi.mock("@/components/wallet/wallet-saved-card-sharing", () => ({ WalletSavedCardSharing: ({ card }: { card: { cardId: string } }) => <button>Share {card.cardId}</button> }));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: vi.fn() }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { promise: vi.fn() } }));
import { WalletSharingHistory } from "@/components/wallet/wallet-sharing-history";

const context = { userId: "owner", vaultKey: "memory-only", vaultOwnerToken: "consent", getIdToken: async () => "identity", isCurrent: () => mocks.current };
const getContext = () => context;
const item = (id: string) => ({ id, cardId: "card_1", cardType: "payment", displayLabel: "VISA •••• 4242", recipientName: id, senderName: "Owner", createdAt: "2026-10-12T10:00:00Z", expiresAt: "2026-10-12T10:15:00Z", durationMinutes: 15, status: "active", trustedCircle: false, verificationMethod: "identity_reauthentication", verifiedAt: null, revokedAt: null, lastAccessedAt: "2026-10-12T10:01:00Z", activity: [{ event: "SHARE_CREATED", at: "2026-10-12T10:00:00Z", actor: "owner", outcome: "recorded" }] });
const page = (ids: string[], cursor: string | null = null) => ({ items: ids.map(item), hasMore: Boolean(cursor), nextCursor: cursor, serverNow: "2026-10-12T10:02:00Z" });
beforeEach(() => {
  vi.clearAllMocks(); mocks.current = true;
  mocks.subscribe.mockReturnValue(() => {}); mocks.profile.mockResolvedValue({ eligible: false, cardId: null });
  mocks.history.mockResolvedValue(page(["First"])); mocks.revoke.mockResolvedValue({ revoked: true });
});
describe("Wallet's participant-scoped sharing ledger", () => {
  it("renders real timing, recipient, verification and activity and confirms recipient-specific revocation", async () => {
    const record = item("First");
    record.activity.push(...Array.from({ length: 4 }, () => ({ event: "SHARE_OPENED", at: "2026-10-12T10:01:00Z", actor: "recipient", outcome: "opened" })));
    mocks.history.mockResolvedValue({ ...page(["First"]), items: [record], recipientCount: 7 });
    render(<WalletSharingHistory ownerId="owner" active getContext={getContext} />);
    expect(await screen.findByText("VISA •••• 4242 · First")).toBeVisible();
    expect(screen.getByRole("region", { name: "Shared cards · 7" })).toBeVisible();
    expect(screen.getAllByText(/share opened/)).toHaveLength(1);
    expect(screen.getByText(/15 minutes/)).toBeVisible();
    expect(screen.getByText("Identity verification required")).toBeVisible();
    expect(screen.getByText(/Last viewed/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Revoke VISA •••• 4242 shared with First" }));
    expect(mocks.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith(context, "First"));
  });
  it("keeps loaded history through refresh and rejects a late page after the owner changes", async () => {
    mocks.profile.mockResolvedValue({ eligible: true, cardId: "profile_owner" });
    mocks.history.mockResolvedValueOnce(page(["First"], "payment:cursor")).mockResolvedValueOnce(page(["Second"]));
    const view = render(<WalletSharingHistory ownerId="owner" active getContext={getContext} />);
    expect(await screen.findByRole("button", { name: "Share profile_owner" })).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "Load more shares" }));
    await screen.findByText("VISA •••• 4242 · Second");
    mocks.history.mockResolvedValueOnce(page(["First"], "payment:cursor")).mockResolvedValueOnce(page(["Second"]));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(4));
    expect(screen.getByText("VISA •••• 4242 · Second")).toBeVisible();
    let finish!: (value: ReturnType<typeof page>) => void;
    mocks.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    mocks.current = false;
    view.rerender(<WalletSharingHistory ownerId="other" active getContext={getContext} />);
    await act(async () => finish(page(["Old owner reply"])));
    expect(screen.queryByText(/First|Second|Old owner reply/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Share profile_owner" })).toBeNull();
  });
  it("does not claim an empty ledger when loading fails, and uses the received direction", async () => {
    mocks.history.mockRejectedValueOnce(new Error("offline"));
    render(<WalletSharingHistory ownerId="owner" active getContext={getContext} />);
    await screen.findByRole("alert");
    expect(screen.queryByText("No cards shared yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Received cards" }));
    await waitFor(() => expect(mocks.history).toHaveBeenLastCalledWith(context, { direction: "received" }, expect.any(AbortSignal)));
  });
});

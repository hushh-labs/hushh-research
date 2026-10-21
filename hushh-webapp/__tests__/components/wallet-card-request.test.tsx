import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRef } from "react";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  profile: vi.fn(),
  state: vi.fn(),
  share: vi.fn(),
  decide: vi.fn(),
  encrypt: vi.fn(),
  prepare: vi.fn(),
  key: vi.fn(),
  changed: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "owner", getIdToken: async () => "identity" },
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    vaultKey: "key",
    vaultOwnerToken: "consent",
    isVaultUnlocked: true,
  }),
}));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: () => {} }));
vi.mock("@/lib/agent/local-onboarding-actions", () => ({
  useLocalOnboardingActionHandler: () => {},
}));
vi.mock("@/lib/one-location/key-bootstrap", () => ({
  bootstrapCurrentUserLocationRecipientKey: mocks.key,
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: { onFeedChanged: mocks.changed },
}));
vi.mock(
  "@/lib/services/wallet-card-access-service",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    WalletCardAccessService: {
      createRequest: mocks.create,
      getRequest: mocks.get,
      profile: mocks.profile,
      state: mocks.state,
      share: mocks.share,
      decideRequest: mocks.decide,
    },
  }),
);
vi.mock("@/lib/services/wallet-service", () => ({
  WalletService: { prepareCardSharing: mocks.prepare },
}));
vi.mock("@/lib/services/wallet-card-share-service", () => ({
  prepareTemporaryCardShares: mocks.encrypt,
  CardRecipientKeyUnavailableError: class extends Error {},
}));

import { RequestCardsButton } from "@/components/wallet/request-cards-button";
import { WalletCardRequestReview } from "@/components/wallet/wallet-card-request-review";
const id = "11111111-1111-4111-8111-111111111111",
  person = "22222222-2222-4222-8222-222222222222";
const request = {
  id,
  role: "owner",
  status: "pending",
  requesterPersonRef: person,
  requesterName: "Requester",
  ownerName: "Owner",
  createdAt: "2026-10-16T00:00:00Z",
  expiresAt: "2026-10-23T00:00:00Z",
};
const card = {
  cardId: "card_saved",
  nickname: "Travel",
  brand: "visa" as const,
  last4: "4242",
  expiryMonth: 4,
  expiryYear: 2030,
  issuingRegion: "US",
  createdAt: "",
};
let current = true;
const context = {
  userId: "owner",
  vaultKey: "key",
  vaultOwnerToken: "consent",
  getIdToken: async () => "identity",
  isCurrent: () => current,
};
const getContext = () => (current ? context : null);
beforeEach(() => {
  current = true;
  vi.resetAllMocks();
  mocks.get.mockResolvedValue(request);
  mocks.profile.mockResolvedValue({ eligible: true, cardId: "profile_owner" });
  mocks.state.mockResolvedValue({ eligible: true });
  mocks.encrypt.mockResolvedValue({ [person]: "encrypted-card" });
  mocks.key.mockResolvedValue({ userId: "owner", publicKeyJwk: { kty: "EC" } });
  mocks.create.mockResolvedValue({ ...request, role: "requester" });
  mocks.share.mockResolvedValue({ grants: [] });
});
afterEach(cleanup);

it("requires confirmation before sending an ask and bootstraps only the requester's receiving key", async () => {
  render(<RequestCardsButton personRef={person} personName="Owner" />);
  fireEvent.click(screen.getByRole("button", { name: "Request cards" }));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.key).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  await screen.findByRole("button", { name: "Card request sent" });
  expect(mocks.key).toHaveBeenCalledOnce();
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "owner" }),
    person,
    expect.any(String),
  );
  expect(mocks.state).not.toHaveBeenCalled();
  expect(mocks.encrypt).not.toHaveBeenCalled();
  expect(mocks.share).not.toHaveBeenCalled();
});

it("keeps the card acknowledgement when relationship refresh starts after dispatch", async () => {
  let accept!: (value: typeof request) => void;
  mocks.create.mockReturnValueOnce(new Promise((resolve) => { accept = resolve; }));
  const view = render(<RequestCardsButton personRef={person} personName="Owner" />);
  fireEvent.click(screen.getByRole("button", { name: "Request cards" }));
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  view.rerender(<RequestCardsButton personRef={person} personName="Owner" canRequest={false} />);
  await act(async () => accept(request));
  await screen.findByRole("button", { name: "Card request sent" });
  expect(mocks.create).toHaveBeenCalledOnce();
});

it("returns focus to Profile when the card opener disappears during review", async () => {
  const returnFocusRef = createRef<HTMLButtonElement>();
  const content = (showTrigger: boolean) => <>
    <button ref={returnFocusRef}>Share profile</button>
    <RequestCardsButton personRef={person} personName="Owner" showTrigger={showTrigger} canRequest={showTrigger} returnFocusRef={returnFocusRef} />
  </>;
  const view = render(content(true));
  fireEvent.click(screen.getByRole("button", { name: "Request cards" }));
  view.rerender(content(false));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(returnFocusRef.current).toHaveFocus());
});

it("stops a fresh card dispatch if eligibility changes during receiving-key preparation", async () => {
  let finish!: (value: { userId: string; publicKeyJwk: { kty: string } }) => void;
  mocks.key.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const view = render(<RequestCardsButton personRef={person} personName="Owner" />);
  fireEvent.click(screen.getByRole("button", { name: "Request cards" }));
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  await waitFor(() => expect(mocks.key).toHaveBeenCalledOnce());
  view.rerender(<RequestCardsButton personRef={person} personName="Owner" canRequest={false} />);
  await act(async () => finish({ userId: "owner", publicKeyJwk: { kty: "EC" } }));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
});

it("requires card selection and explicit sharing, fixes the recipient, and reuses the response identity on retry", async () => {
  mocks.share.mockRejectedValueOnce(new Error("lost response"));
  render(
    <WalletCardRequestReview
      requestId={id}
      cards={[card]}
      getContext={getContext}
      onClose={() => {}}
    />,
  );
  const share = await screen.findByRole("button", { name: "Share card" });
  expect(share).toBeDisabled();
  expect(mocks.encrypt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", { name: /Travel/ }));
  expect(mocks.encrypt).not.toHaveBeenCalled();
  fireEvent.click(share);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Share card" }));
  await screen.findByText("Card sent");
  expect(mocks.share).toHaveBeenCalledTimes(2);
  expect(mocks.share.mock.calls[0].slice(1)).toEqual([
    card.cardId,
    [person],
    15,
    expect.any(String),
    { [person]: "encrypted-card" },
    id,
  ]);
  expect(mocks.share.mock.calls[1][4]).toBe(mocks.share.mock.calls[0][4]);
  expect(mocks.changed).toHaveBeenCalledWith("owner");
});

it("never sends a prepared card after the owner session becomes stale", async () => {
  let finish!: (value: Record<string, string>) => void;
  mocks.encrypt.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <WalletCardRequestReview
      requestId={id}
      cards={[card]}
      getContext={getContext}
      onClose={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("radio", { name: /Travel/ }));
  fireEvent.click(screen.getByRole("button", { name: "Share card" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  current = false;
  await act(async () => finish({ [person]: "encrypted-card" }));
  expect(mocks.share).not.toHaveBeenCalled();
  expect(mocks.changed).not.toHaveBeenCalled();
});

it("offers recovery for a failed Profile lookup without claiming the owner has no cards", async () => {
  mocks.profile.mockRejectedValueOnce(new Error("offline"));
  render(
    <WalletCardRequestReview
      requestId={id}
      cards={[]}
      getContext={getContext}
      onClose={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry Profile Card" }),
  );
  await screen.findByRole("radio", { name: "Agent One Profile" });
  expect(screen.queryByText(/Add a card to Wallet/)).toBeNull();
  expect(mocks.share).not.toHaveBeenCalled();
});

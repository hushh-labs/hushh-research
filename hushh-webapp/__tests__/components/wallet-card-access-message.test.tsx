import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as artwork from "@/lib/services/wallet-card-artwork-service";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ view: vi.fn(), verify: vi.fn(), reauthenticate: vi.fn(), token: vi.fn(), openCard: vi.fn(), vaultKey: null as string | null, native: false }));
const user = { uid: "recipient", getIdToken: mocks.token, providerData: [{ providerId: "google.com" }] };
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ vaultKey: mocks.vaultKey, getVaultOwnerToken: () => "consent" }) }));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({ VaultUnlockDialog: () => null }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { getState: async () => ({}) } }));
vi.mock("@/lib/wallet/wallet-card-share", () => ({ openWalletCardShare: mocks.openCard }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => mocks.native } }));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { reauthenticateIdentity: mocks.reauthenticate } }));
vi.mock("@/lib/services/wallet-card-access-service", () => ({ WalletCardAccessService: { view: mocks.view, verify: mocks.verify } }));
vi.mock("@/components/profile/settings-ui", () => ({ SettingsDetailPanel: ({ open, children }: any) => open ? <div>{children}</div> : null, SettingsPresentationProvider: ({ children }: any) => children }));
import { WalletCardAccessMessage } from "@/components/wallet/wallet-card-access-message";
import { WalletAccessCardDetails } from "@/components/wallet/wallet-access-card-details";
const pending = { status: "verification_required", senderName: "Sender", expiresAt: "2030-01-01T00:15:00Z", serverNow: "2030-01-01T00:00:00Z" };
const active = { ...pending, status: "active", card: { brand: "visa", last4: "1234", expiryMonth: 6, expiryYear: 2030, issuingRegion: "IN" } };
beforeEach(() => { vi.resetAllMocks(); mocks.native = false; mocks.vaultKey = null; mocks.token.mockResolvedValue("token"); mocks.view.mockResolvedValue(pending); mocks.verify.mockResolvedValue(active); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("keeps an authorized reveal stable when polling reorders identical summary fields", async () => {
  mocks.vaultKey = "unlocked";
  const data = { ...active, status: "active" as const, encryptedCard: "ciphertext", senderUserId: "sender" };
  mocks.openCard.mockResolvedValueOnce({ pan: "4111111111111234", cardholderName: "Test", ...active.card });
  const rendered = render(<WalletAccessCardDetails grantId="grant" data={data} />);
  await waitFor(() => expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "true"));
  // A needless second decryption would leave the owner watching another loader.
  mocks.openCard.mockImplementation(() => new Promise(() => {}));
  rendered.rerender(<WalletAccessCardDetails grantId="grant" data={{ ...data, card: {
    issuingRegion: "IN", expiryYear: 2030, expiryMonth: 6, last4: "1234", brand: "visa",
  } }} />);
  expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "true");
  expect(screen.queryByText("Opening encrypted card…")).toBeNull();
  expect(mocks.openCard).toHaveBeenCalledOnce();
});
it("masks the old reveal immediately when the encrypted share actually changes", async () => {
  mocks.vaultKey = "unlocked";
  const data = { ...active, status: "active" as const, encryptedCard: "ciphertext", senderUserId: "sender" };
  mocks.openCard.mockResolvedValueOnce({ pan: "4111111111111234", cardholderName: "Test", ...active.card });
  const rendered = render(<WalletAccessCardDetails grantId="grant" data={data} />);
  await waitFor(() => expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "true"));
  let finish!: (value: unknown) => void;
  mocks.openCard.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  rendered.rerender(<WalletAccessCardDetails grantId="grant" data={{ ...data, encryptedCard: "replacement-ciphertext" }} />);
  expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "false");
  await waitFor(() => expect(mocks.openCard).toHaveBeenCalledTimes(2));
  await act(async () => finish({ pan: "4111111111111234", cardholderName: "Test", ...active.card }));
  expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "true");
});
it("still removes the revealed card when the next access poll reports revocation", async () => {
  const timers = vi.spyOn(window, "setInterval");
  mocks.vaultKey = "unlocked";
  mocks.view.mockResolvedValue({ ...active, encryptedCard: "ciphertext", senderUserId: "sender" });
  mocks.openCard.mockResolvedValue({ pan: "4111111111111234", cardholderName: "Test", ...active.card });
  render(<WalletCardAccessMessage grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  await waitFor(() => expect(screen.getByTestId("wallet-card-face")).toHaveAttribute("data-revealed", "true"));
  const poll = timers.mock.calls.find(([, delay]) => delay === 2000)?.[0] as () => void;
  expect(poll).toBeTypeOf("function");
  mocks.view.mockResolvedValue({ ...pending, status: "revoked" });
  await act(async () => poll());
  expect(screen.queryByTestId("wallet-card-face")).toBeNull();
  expect(screen.getByText("This access has ended.")).toBeVisible();
});
it("reveals the decrypted number only while the authorized recipient wallet is unlocked", async () => {
  mocks.vaultKey = "unlocked";
  mocks.view.mockResolvedValue({ ...active, encryptedCard: "ciphertext", senderUserId: "sender" });
  mocks.openCard.mockResolvedValue({ pan: "4111111111111234", cardholderName: "Test", ...active.card });
  const rendered = render(<WalletCardAccessMessage grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  await waitFor(() => expect(screen.getByTestId("wallet-card-face")).toHaveTextContent("4111"));
  expect(mocks.openCard).toHaveBeenCalledWith(expect.objectContaining({ userId: "recipient", peerUserId: "sender", senderIsViewer: false }));
  mocks.vaultKey = null;
  rendered.rerender(<WalletCardAccessMessage grantId="grant" />);
  expect(screen.getByTestId("wallet-card-face")).not.toHaveTextContent("4111");
  expect(screen.getByRole("button", { name: "Unlock to view card number" })).toBeInTheDocument();
});
it("renders the authorized masked card face", async () => {
  mocks.view.mockResolvedValue(active);
  render(<WalletCardAccessMessage grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  expect(await screen.findByTestId("wallet-card-face")).toHaveTextContent("1234");
});
it("renders the live permitted Profile Card and removes it on expiry", async () => {
  const monotonic = vi.spyOn(performance, "now").mockReturnValue(1000);
  vi.spyOn(artwork, "loadWalletCardArtwork").mockImplementation(async kind => readFileSync(join(process.cwd(), `public/wallet/artwork/${kind}-v3.svg`), "utf8"));
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn((blob: Blob) => { blobs.push(blob); return "blob:permitted-profile"; });
    static revokeObjectURL = vi.fn();
  });
  mocks.view.mockResolvedValue({ ...active, card: undefined, cardType: "profile", profileCard: { fullName: "Alice Example", headline: "Product designer", email: "alice@example.test", updatedOn: "2030-01-01" }, expiresAt: "2030-01-01T00:00:01Z" });
  render(<WalletCardAccessMessage grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  const face = await screen.findByTestId("shared-profile-card-face");
  await waitFor(() => expect(face.querySelector("img")).not.toBeNull());
  const svg = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blobs[0]!); });
  expect(svg).toContain("Alice Example");
  expect(svg).toContain("data-wallet-shared");
  expect(svg).not.toContain("data-wallet-qr");
  expect(svg).not.toContain("MEMBER SINCE");
  await act(async () => { fireEvent.load(face.querySelector("img")!); });
  expect(screen.getByRole("img", { name: "Agent One Profile", exact: true })).toBeVisible();
  expect(screen.getByText("Product designer")).toBeVisible();
  expect(screen.getByText("alice@example.test")).toBeVisible();
  monotonic.mockReturnValue(3000);
  await waitFor(() => expect(screen.queryByText("alice@example.test")).toBeNull(), { timeout: 2500 });
  expect(screen.queryByTestId("shared-profile-card-face")).toBeNull();
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:permitted-profile"));
});
it("completes verification after authentication backgrounds the tab", async () => {
  let finish!: (value: string) => void;
  mocks.reauthenticate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  render(<WalletCardAccessMessage grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  fireEvent.click(await screen.findByRole("button", { name: "Verify identity" }));
  visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
  expect(screen.queryByTestId("wallet-card-face")).toBeNull();
  visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
  mocks.view.mockResolvedValue(active);
  await act(async () => finish("fresh-token"));
  await waitFor(() => expect(mocks.verify).toHaveBeenCalledWith("fresh-token", "grant"));
  expect(await screen.findByTestId("wallet-card-face")).toHaveTextContent("1234");
});
it("still hides an active card when backgrounded", async () => {
  mocks.view.mockResolvedValue(active);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  render(<WalletCardAccessMessage grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  await screen.findByTestId("wallet-card-face");
  visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
  expect(screen.queryByTestId("wallet-card-face")).toBeNull();
});
it("discards authentication after page navigation", async () => {
  let finish!: (value: string) => void;
  mocks.reauthenticate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<WalletCardAccessMessage grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  fireEvent.click(await screen.findByRole("button", { name: "Verify identity" }));
  fireEvent(window, new Event("pagehide"));
  await act(async () => finish("fresh-token"));
  expect(mocks.verify).not.toHaveBeenCalled();
  expect(screen.queryByTestId("wallet-card-face")).toBeNull();
});

it.each(["blur", "beforeprint", "pagehide"])("clears an open card on %s and requires explicit reopening", async event => {
  mocks.view.mockResolvedValue(active);
  render(<WalletCardAccessMessage grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  await screen.findByTestId("wallet-card-face");
  fireEvent(window, new Event(event));
  expect(screen.queryByTestId("wallet-card-face")).toBeNull();
  fireEvent(window, new Event("focus"));
  expect(screen.queryByTestId("wallet-card-face")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  expect(await screen.findByTestId("wallet-card-face")).toHaveTextContent("1234");
});

it.each(["blur", "beforeprint", "pagehide"])("discards pending decrypted details after %s", async event => {
  let finish!: (value: unknown) => void;
  mocks.vaultKey = "unlocked";
  mocks.view.mockResolvedValue({ ...active, encryptedCard: "ciphertext", senderUserId: "sender" });
  mocks.openCard.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<WalletCardAccessMessage grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent(window, new Event(event));
  await act(async () => finish({ pan: "4111111111111234", cardholderName: "Test", ...active.card }));
  expect(screen.queryByTestId("wallet-card-face")).toBeNull();
});

it("allows identity verification to finish without revealing into an unfocused window", async () => {
  let finish!: (value: string) => void;
  mocks.reauthenticate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<WalletCardAccessMessage grantId="grant" />);
  fireEvent.click(screen.getByRole("button", { name: "View card" }));
  fireEvent.click(await screen.findByRole("button", { name: "Verify identity" }));
  fireEvent(window, new Event("blur"));
  mocks.view.mockResolvedValue(active);
  await act(async () => finish("fresh-token"));
  expect(mocks.verify).toHaveBeenCalledWith("fresh-token", "grant");
  expect(screen.queryByTestId("wallet-card-face")).toBeNull();
  fireEvent(window, new Event("focus"));
  expect(await screen.findByTestId("wallet-card-face")).toHaveTextContent("1234");
});

it("does not offer a native reveal without capture protection", () => {
  mocks.native = true;
  render(<WalletCardAccessMessage grantId="grant" />);
  expect(screen.queryByRole("button", { name: "View card" })).toBeNull();
  expect(mocks.view).not.toHaveBeenCalled();
});

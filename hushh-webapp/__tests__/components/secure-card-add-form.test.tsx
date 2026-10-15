import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { SecureCardAddForm as CardForm } from "@/components/wallet/secure-card-add-form";

const networkApi = vi.hoisted(() => ({ resolve: vi.fn(), supported: vi.fn(), artwork: vi.fn(), select: vi.fn(), preview: vi.fn(), display: vi.fn() }));
vi.mock("@/lib/services/wallet-service", () => ({ WalletService: { resolveCardNetwork: networkApi.resolve, supportedCardNetworks: networkApi.supported, resolveCardArtwork: networkApi.artwork, selectCardArtwork: networkApi.select, previewCardArtwork: networkApi.preview, checkCardArtworkDisplay: networkApi.display } }));
// Exercise the real region dropdown with a bounded, representative catalog.
vi.mock("@/lib/constants/country-phone-options", () => ({ COUNTRY_PHONE_OPTIONS: [
  { value: "US", label: "United States" }, { value: "IN", label: "India" },
] }));
const networkContext = () => ({ userId: "owner", vaultOwnerToken: "consent" });
const SecureCardAddForm = (props: React.ComponentProps<typeof CardForm>) => <CardForm getNetworkContext={networkContext} {...props} />;

const scan = vi.hoisted(() => ({ read: vi.fn(), pick: vi.fn(), native: vi.fn() }));
vi.mock("@/lib/services/wallet-card-scan", () => ({ scanWalletCardForReview: scan.read, detectWalletCardRegion: vi.fn().mockResolvedValue({ detected: false }), pickNativeWalletCard: scan.pick, CardScanError: class extends Error {} }));
vi.mock("@/lib/capacitor/platform", () => ({ isNative: scan.native }));
const notify = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notify }));

function fillRequired() {
  fireEvent.change(screen.getByLabelText("Card number"), { target: { value: "4242 4242 4242 4242" } });
  fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "Test Owner" } });
  fireEvent.change(screen.getByLabelText("Expiry (MM/YY)"), { target: { value: "12/99" } });
}

function openAdditional() {
  const summary = screen.getByText("Additional details");
  if (!summary.closest("details")?.open) fireEvent.click(summary);
}

function submit() {
  fireEvent.submit(screen.getByTestId("secure-card-add-form"));
}

beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:owned-test-photo") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    networkApi.artwork.mockResolvedValue({ catalogVersion: "empty-1", match: "unknown", provider: "unconfigured", issuerId: null, variants: [] });
    networkApi.preview.mockResolvedValue("data:image/png;base64,c3ludGhldGlj");
    networkApi.display.mockResolvedValue(true);
    scan.read.mockReset();
    scan.pick.mockReset();
    scan.native.mockReturnValue(false);
    networkApi.resolve.mockReset();
    networkApi.supported.mockReset();
    networkApi.supported.mockResolvedValue(["visa", "mastercard", "amex", "discover", "rupay", "other"]);
    networkApi.resolve.mockImplementation(async (_context, input) => ({ network: input.selectedNetwork || "visa", source: input.selectedNetwork ? "owner_selected" : "prefix", candidates: [] }));
});

it("keeps Add available during an exact-design download and preserves a later owner choice", async () => {
  let finish!: (value: unknown) => void;
  networkApi.select.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const variant = { assetId: "owned-blue", issuerId: "owned", productId: "test", variantId: "blue", label: "Owned blue", image: "/not-dispatched-by-this-mock", digest: "a".repeat(64), allowOverlay: false };
  networkApi.artwork.mockResolvedValue({ catalogVersion: "owned-1", provider: "configured", match: "exact", issuerId: "owned", variants: [variant] });
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  let token = "original-consent";
  const getContext = () => ({ userId: "owner", vaultOwnerToken: token });
  const view = render(<SecureCardAddForm onSubmit={onSubmit} getNetworkContext={getContext} />); fillRequired();
  await waitFor(() => expect(networkApi.select).toHaveBeenCalledOnce());
  expect(screen.getByRole("heading", { name: "Choose your card design" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Add to Wallet", exact: true })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Use a simple design" }));
  await act(async () => { finish({ source: "catalog", assetId: "owned-blue" }); });
  token = "renewed-consent"; view.rerender(<SecureCardAddForm onSubmit={onSubmit} getNetworkContext={getContext} />);
  await waitFor(() => expect(networkApi.artwork).toHaveBeenCalledTimes(2));
  expect(networkApi.select).toHaveBeenCalledOnce();
  submit();
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ artwork: { source: "neutral", version: 1 } })));
});

it("rechecks open picker and selected imagery without replacing the owner choice or restoring a foreign preview", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  try {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const variant = { assetId: "owned-blue", issuerId: "owned", productId: "test", variantId: "blue", label: "Owned blue", image: "/not-dispatched-by-this-mock", digest: "a".repeat(64), allowOverlay: false };
  const selected = { ...variant, source: "catalog", version: 1, catalogVersion: "owned-1", image: "data:image/png;base64,c3ludGhldGlj", evidence: "owner_selected" };
  networkApi.artwork.mockResolvedValue({ catalogVersion: "owned-1", provider: "configured", match: "exact", issuerId: "owned", variants: [variant] });
  networkApi.select.mockResolvedValue(selected);
  let owner = "owner";
  const getContext = () => ({ userId: owner, vaultOwnerToken: "consent" });
  const view = render(<SecureCardAddForm onSubmit={vi.fn()} getNetworkContext={getContext} />); fillRequired();
  await waitFor(() => expect(view.container.querySelectorAll('[data-card-artwork="catalog"] img, [aria-label="Approved card designs"] img')).toHaveLength(2));
  const finishes: ((approved: boolean) => void)[] = [];
  networkApi.display.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
  fireEvent.focus(window);
  await waitFor(() => expect(view.container.querySelectorAll('[data-card-artwork="catalog"] img, [aria-label="Approved card designs"] img')).toHaveLength(0));
  expect(screen.getByRole("button", { name: "Owned blue" })).toHaveAttribute("aria-pressed", "true");
  owner = "other-owner";
  networkApi.artwork.mockResolvedValue({ catalogVersion: "empty-1", provider: "unconfigured", match: "unknown", issuerId: null, variants: [] });
  view.rerender(<SecureCardAddForm onSubmit={vi.fn()} getNetworkContext={getContext} />);
  await act(async () => { finishes.forEach(finish => finish(true)); });
  expect(view.container.querySelectorAll('[data-card-artwork="catalog"] img, [aria-label="Approved card designs"] img')).toHaveLength(0);
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});


vi.mock("@/lib/wallet/card-scan-image", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/wallet/card-scan-image")>(), validateCardImage: vi.fn().mockResolvedValue(undefined) }));
const reading = (fields: { pan?: string; cardholderName?: string; expiry?: string }) => ({ fields, states: { pan: fields.pan ? "recognized" : "missing", cardholderName: fields.cardholderName ? "recognized" : "missing", expiry: fields.expiry ? "recognized" : "missing" } });
async function selectPhoto() { fireEvent.change(screen.getByLabelText("Choose a card photo"), { target: { files: [new File(["synthetic"], "card.jpg", { type: "image/jpeg" })] } }); await waitFor(() => expect(screen.getByRole("button", { name: "Read card" })).not.toBeDisabled()); fireEvent.click(screen.getByRole("button", { name: "Read card" })); }

it("offers camera and gallery, links validation errors, and has no security-code controls", () => {
  render(<SecureCardAddForm onSubmit={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Take photo" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Choose from photos" })).toBeInTheDocument();
  expect(screen.queryByLabelText("CVV")).toBeNull(); expect(screen.queryByLabelText("PIN (optional)")).toBeNull();
  submit(); expect(screen.getByRole("alert")).toHaveFocus(); expect(screen.getByLabelText("Name on card")).toHaveAttribute("aria-invalid", "true");
});
it("submits once, preserves retry identity and clears details after success", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("private diagnostic")).mockResolvedValueOnce(undefined);
  render(<SecureCardAddForm onSubmit={save} />); fillRequired(); await waitFor(() => expect(screen.getByTestId("secure-card-save")).not.toBeDisabled());
  submit(); submit(); await waitFor(() => expect(notify.error).toHaveBeenCalled());
  expect(save).toHaveBeenCalledTimes(1); const first = save.mock.calls[0][0]; expect(first).not.toHaveProperty("cvv"); expect(first).not.toHaveProperty("pin");
  expect(screen.queryByText("private diagnostic")).toBeNull(); submit(); await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][0].draftId).toBe(first.draftId); await waitFor(() => expect(screen.getByLabelText("Card number")).toHaveValue(""));
});
it("fills readable scan details only after crop confirmation and never saves automatically", async () => {
  scan.read.mockResolvedValue(reading({ pan: "5555555555554444", cardholderName: "Scanned Owner", expiry: "11/99" }));
  const save = vi.fn(); render(<SecureCardAddForm onSubmit={save} scanInToolbar />);
  expect(screen.getByRole("button", { name: "Scan card" }).querySelector("img")).not.toBeNull();
  await selectPhoto(); await waitFor(() => expect(screen.getByLabelText("Card number")).toHaveValue("5555555555554444"));
  expect(screen.getByLabelText("Name on card")).toHaveValue("Scanned Owner"); expect(screen.getByLabelText("Expiry (MM/YY)")).toHaveValue("11/99"); expect(save).not.toHaveBeenCalled();
  expect(scan.read).toHaveBeenCalledWith(expect.any(Blob), expect.any(AbortSignal), expect.objectContaining({ corners: expect.any(Array), artwork: true }));
});
it("preserves manual corrections and partial scan fields during rescans", async () => {
  scan.read.mockResolvedValue(reading({ cardholderName: "Scanned Owner", expiry: "11/99" }));
  render(<SecureCardAddForm onSubmit={vi.fn()} />); fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "Correct Owner" } });
  await selectPhoto(); await waitFor(() => expect(screen.getByLabelText("Expiry (MM/YY)")).toHaveValue("11/99"));
  expect(screen.getByLabelText("Name on card")).toHaveValue("Correct Owner"); expect(screen.getByLabelText("Card number")).toHaveValue("");
});
it("keeps failed scans retryable without exposing image diagnostics", async () => {
  scan.read.mockRejectedValueOnce(new Error("private image diagnostic")).mockResolvedValueOnce(reading({ expiry: "11/99" }));
  render(<SecureCardAddForm onSubmit={vi.fn()} />); fillRequired(); await selectPhoto();
  expect(await screen.findByText(/This photo could not be read/)).toBeInTheDocument(); expect(screen.queryByText("private image diagnostic")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Read card" })); await waitFor(() => expect(scan.read).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText("Expiry (MM/YY)")).toHaveValue("12/99");
});
it.each(["cancel", "inactive", "unmount"])("drops late recognition after %s", async exit => {
  let finish!: (value: ReturnType<typeof reading>) => void; scan.read.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const save = vi.fn(), view = render(<SecureCardAddForm onSubmit={save} />); fillRequired(); await selectPhoto();
  const signal = scan.read.mock.calls[0][1] as AbortSignal;
  if (exit === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel scan" })); else if (exit === "inactive") view.rerender(<SecureCardAddForm active={false} onSubmit={save} />); else view.unmount();
  expect(signal.aborted).toBe(true); await act(async () => finish(reading({ pan: "5555555555554444" })));
  if (exit === "inactive") { expect(screen.getByLabelText("Card number")).toHaveValue(""); view.rerender(<SecureCardAddForm active onSubmit={save} />); }
  if (exit !== "unmount") expect(screen.getByLabelText("Card number")).toHaveValue("4242424242424242"); expect(save).not.toHaveBeenCalled();
});
it("uses native camera and gallery and preserves the draft on cancellation", async () => {
  scan.native.mockReturnValue(true); scan.pick.mockResolvedValue(null); render(<SecureCardAddForm onSubmit={vi.fn()} />); fillRequired();
  fireEvent.click(screen.getByRole("button", { name: "Take photo" })); await waitFor(() => expect(scan.pick).toHaveBeenCalledWith("camera", expect.any(AbortSignal)));
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose from photos" })).not.toBeDisabled()); fireEvent.click(screen.getByRole("button", { name: "Choose from photos" }));
  await waitFor(() => expect(scan.pick).toHaveBeenCalledWith("photos", expect.any(AbortSignal))); expect(screen.getByLabelText("Card number")).toHaveValue("4242424242424242"); expect(scan.read).not.toHaveBeenCalled();
});
it("blocks submission when the Add surface becomes inactive", () => {
  const save = vi.fn(), view = render(<SecureCardAddForm onSubmit={save} />); fillRequired(); view.rerender(<SecureCardAddForm active={false} onSubmit={save} />);
  expect(screen.getByLabelText("Card number")).toBeDisabled(); submit(); expect(save).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Card number")).toHaveValue("");
  view.rerender(<SecureCardAddForm active onSubmit={save} />); expect(screen.getByLabelText("Card number")).toHaveValue("4242424242424242");
});
it("hides the previous owner's private preview before passive draft cleanup", async () => {
  const photo = new Blob(["synthetic flattened pixels"], { type: "image/png" }), observations: boolean[] = [];
  let context = { userId: "owner-a", vaultOwnerToken: "synthetic-a" };
  function PaintAudit({ owner }: { owner: string }) { useLayoutEffect(() => { if (owner === "owner-b") observations.push(Boolean(document.querySelector('img[alt="Photo design with detected text removed"]'))); }, [owner]); return null; }
  const form = () => <><SecureCardAddForm getNetworkContext={() => context} onSubmit={vi.fn()} /><PaintAudit owner={context.userId} /></>;
  scan.read.mockResolvedValue({ ...reading({ pan: "4242424242424242", cardholderName: "Synthetic Owner", expiry: "12/30" }), candidate: photo, sanitized: photo });
  const view = render(form()); await selectPhoto(); await screen.findByAltText("Photo design with detected text removed");
  context = { userId: "owner-b", vaultOwnerToken: "synthetic-b" }; view.rerender(form());
  expect(observations).toEqual([false]); expect(screen.queryByAltText("Photo design with detected text removed")).toBeNull(); expect(screen.getByLabelText("Card number")).toHaveValue("");
});
it("shows a neutral label and explains a failed backend lookup", async () => {
  networkApi.resolve.mockRejectedValue(new Error("private lookup diagnostic"));
  const save = vi.fn().mockResolvedValue(undefined);
  render(<SecureCardAddForm onSubmit={save} scanEnabled={false} />);
  fillRequired();
  expect(await screen.findByText("Network identification is unavailable. Your card will use a neutral Card label.")).toBeInTheDocument();
  expect(screen.getByLabelText("Card network (optional)")).toHaveTextContent("Auto-detect");
  expect(screen.queryByText("private lookup diagnostic")).toBeNull();
  submit();
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ nickname: "Card", brand: undefined })));
});

it("explains ambiguous networks without displaying a guessed brand", async () => {
  networkApi.resolve.mockResolvedValue({ network: "other", source: "ambiguous", candidates: ["jcb", "rupay"] });
  render(<SecureCardAddForm onSubmit={vi.fn()} scanEnabled={false} />);
  fillRequired();
  expect(await screen.findByText("This number matches more than one network. Choose the network printed on your card.")).toBeInTheDocument();
  expect(screen.getByLabelText("Card network (optional)")).toHaveTextContent("Auto-detect");
});

it("discards a late reply for a previous issuer prefix", async () => {
  let finish!: (value: unknown) => void;
  networkApi.resolve.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ network: "mastercard", source: "prefix", candidates: [] });
  render(<SecureCardAddForm onSubmit={vi.fn()} scanEnabled={false} />);
  fillRequired();
  await waitFor(() => expect(networkApi.resolve).toHaveBeenCalledOnce());
  const signal = networkApi.resolve.mock.calls[0][2] as AbortSignal;
  fireEvent.change(screen.getByLabelText("Card number"), { target: { value: "5555555555554444" } });
  await waitFor(() => expect(screen.getByLabelText("Card network (optional)")).toHaveTextContent("Auto-detect · Mastercard"));
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ network: "amex", source: "prefix", candidates: [] }));
  expect(screen.getByLabelText("Card network (optional)")).toHaveTextContent("Auto-detect · Mastercard");
});

it("hides the previous network when the owner authorization changes", async () => {
  let finish!: (value: unknown) => void;
  networkApi.resolve.mockResolvedValueOnce({ network: "visa", source: "prefix", candidates: [] })
    .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const save = vi.fn();
  const view = render(<SecureCardAddForm onSubmit={save} scanEnabled={false} />);
  fillRequired();
  await waitFor(() => expect(screen.getByLabelText("Card network (optional)")).toHaveTextContent("Auto-detect · Visa"));
  view.rerender(<SecureCardAddForm onSubmit={save} scanEnabled={false} getNetworkContext={() => ({ userId: "owner", vaultOwnerToken: "renewed-consent" })} />);
  expect(screen.getByLabelText("Card network (optional)")).toHaveTextContent(/^Auto-detect$/);
  await waitFor(() => expect(networkApi.resolve).toHaveBeenCalledTimes(2));
  await act(async () => finish({ network: "mastercard", source: "prefix", candidates: [] }));
  expect(screen.getByLabelText("Card network (optional)")).toHaveTextContent("Auto-detect · Mastercard");
});

it("offers a new backend network and distinguishes owner selection from identification", async () => {
  networkApi.supported.mockResolvedValue(["visa", "future_network", "other"]);
  render(<SecureCardAddForm onSubmit={vi.fn()} />);
  fillRequired();
  expect(await screen.findByText("Network identified from the card prefix. This does not verify the card or its issuer.")).toBeInTheDocument();
  openAdditional();
  fireEvent.keyDown(screen.getByLabelText("Card network (optional)"), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "FUTURE NETWORK" }));
  expect(await screen.findByText("You selected this network. This does not verify the card or its issuer.")).toBeInTheDocument();
});

it("explains an incompatible manual network length and recovers after correction", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<SecureCardAddForm onSubmit={save} scanEnabled={false} />);
  fillRequired();
  openAdditional();
  fireEvent.keyDown(screen.getByLabelText("Card network (optional)"), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "American Express", exact: true }));
  expect(await screen.findByText("The card number length does not match the selected network.")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId("secure-card-save")).not.toBeDisabled());
  expect(screen.queryByText(/Network identification is unavailable/)).toBeNull();
  submit();
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("The card number length does not match the selected network.");

  fireEvent.change(screen.getByLabelText("Card number"), { target: { value: "378282246310005" } });
  expect(await screen.findByText("You selected this network. This does not verify the card or its issuer.")).toBeInTheDocument();
  submit();
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ brand: "amex", pan: "378282246310005" })));
});

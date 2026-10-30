import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { SecureCardAddForm as CardForm, useSecureCardFormOwner } from "@/components/wallet/secure-card-add-form";

const networkApi = vi.hoisted(() => ({ resolve: vi.fn(), supported: vi.fn(), artwork: vi.fn(), select: vi.fn(), preview: vi.fn(), display: vi.fn(), banks: vi.fn() }));
vi.mock("@/lib/services/wallet-service", () => ({ WalletService: { resolveCardNetwork: networkApi.resolve, supportedCardNetworks: networkApi.supported, resolveCardArtwork: networkApi.artwork, selectCardArtwork: networkApi.select, previewCardArtwork: networkApi.preview, checkCardArtworkDisplay: networkApi.display, bankArtwork: networkApi.banks } }));
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

it("invalidates retired native draft replicas on reset and closure, without losing an active draft", async () => {
  const onSubmit = vi.fn();
  const view = renderHook(({ active }) => useSecureCardFormOwner({ onSubmit, active, getNetworkContext: networkContext }), { initialProps: { active: true } });
  const lifetime = view.result.current.draftLifetime, token = lifetime.current.token;
  act(() => { view.result.current.setPan("4242424242424242"); view.result.current.setSecurityCode("007"); });
  expect(lifetime.current.token).toBe(token); // Same-draft native retirement may reconcile final text.
  act(() => view.result.current.resetDraft());
  expect(lifetime.current.token).not.toBe(token);
  expect(view.result.current.pan).toBe("");
  expect(view.result.current.securityCode).toBe("");
  const resetToken = lifetime.current.token;
  view.rerender({ active: false });
  expect(lifetime.current.token).not.toBe(resetToken);
  view.unmount();
  expect(lifetime.current.alive).toBe(false);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("collects a masked manual code only when owner Wallet enables it, preserving leading zeroes", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<SecureCardAddForm collectSecurityCode onSubmit={save} />);
  fillRequired();
  const code = screen.getByLabelText("CVV");
  expect(code).toHaveAttribute("type", "password");
  fireEvent.change(code, { target: { value: "007" } });
  await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
  submit();
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0]).toMatchObject({ securityCode: "007" });
  expect(save.mock.calls[0][0]).not.toHaveProperty("cvv");
  await waitFor(() => expect(code).toHaveValue(""));
});

it.each(["inactive", "owner", "hidden"])("clears an unsaved manual code after %s", async boundary => {
  let owner = "owner-a";
  const context = () => ({ userId: owner, vaultOwnerToken: "synthetic" });
  const view = render(<SecureCardAddForm collectSecurityCode getNetworkContext={context} onSubmit={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "0123" } });
  if (boundary === "inactive") view.rerender(<SecureCardAddForm collectSecurityCode active={false} getNetworkContext={context} onSubmit={vi.fn()} />);
  if (boundary === "owner") { owner = "owner-b"; view.rerender(<SecureCardAddForm collectSecurityCode getNetworkContext={context} onSubmit={vi.fn()} />); }
  if (boundary === "hidden") {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    visibility.mockRestore();
  }
  await waitFor(() => expect(screen.getByLabelText("CVV")).toHaveValue(""));
});


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
    networkApi.banks.mockResolvedValue({ catalogVersion: "test", banks: [], variants: [], nextOffset: null });
    networkApi.select.mockReset();
    scan.read.mockReset();
    scan.pick.mockReset();
    scan.native.mockReturnValue(false);
    networkApi.resolve.mockReset();
    networkApi.supported.mockReset();
    networkApi.supported.mockResolvedValue(["visa", "mastercard", "amex", "discover", "rupay", "other"]);
    networkApi.resolve.mockImplementation(async (_context, input) => ({ network: input.selectedNetwork || "visa", source: input.selectedNetwork ? "owner_selected" : "prefix", candidates: [] }));
});

it("submits the current card without a bank or design chooser so the service can assign artwork atomically", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<SecureCardAddForm onSubmit={save} />); fillRequired();
  await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
  expect(screen.queryByLabelText("Bank (optional)")).toBeNull();
  expect(screen.queryByRole("region", { name: "Card design", exact: true })).toBeNull();
  expect(networkApi.banks).not.toHaveBeenCalled();
  expect(networkApi.artwork).not.toHaveBeenCalled();
  submit();
  expect(screen.getByLabelText("Name on card")).toHaveAttribute("autoCapitalize", "characters");
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ pan: "4242424242424242", cardholderName: "TEST OWNER" })));
  expect(save.mock.calls[0][0]).not.toHaveProperty("artwork");
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
  const cancel = vi.fn(); render(<SecureCardAddForm backRoute="/one/wallet" onCancel={cancel} onSubmit={save} />); fillRequired(); await waitFor(() => expect(screen.getByTestId("secure-card-save")).not.toBeDisabled());
  submit(); submit();
  act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
  expect(cancel).not.toHaveBeenCalled();
  await waitFor(() => expect(notify.error).toHaveBeenCalled());
  expect(save).toHaveBeenCalledTimes(1); const first = save.mock.calls[0][0]; expect(first).not.toHaveProperty("cvv"); expect(first).not.toHaveProperty("pin");
  expect(screen.queryByText("private diagnostic")).toBeNull(); submit(); await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][0].draftId).toBe(first.draftId); await waitFor(() => expect(screen.getByLabelText("Card number")).toHaveValue(""));
});
it("fills readable scan details only after crop confirmation and never saves automatically", async () => {
  scan.read.mockResolvedValue(reading({ pan: "5555555555554444", cardholderName: "Scanned Owner", expiry: "11/99" }));
  const save = vi.fn(); render(<SecureCardAddForm onSubmit={save} scanInToolbar />);
  expect(screen.getByRole("button", { name: "Scan card" }).querySelector("img")).not.toBeNull();
  await selectPhoto(); await waitFor(() => expect(screen.getByLabelText("Card number")).toHaveValue("5555 5555 5555 4444"));
  expect(screen.getByLabelText("Name on card")).toHaveValue("SCANNED OWNER"); expect(screen.getByLabelText("Expiry (MM/YY)")).toHaveValue("11/99"); expect(save).not.toHaveBeenCalled();
  expect(scan.read).toHaveBeenCalledWith(expect.any(Blob), expect.any(AbortSignal), { corners: expect.any(Array) });
});
it("preserves manual corrections and partial scan fields during rescans", async () => {
  scan.read.mockResolvedValue(reading({ cardholderName: "Scanned Owner", expiry: "11/99" }));
  render(<SecureCardAddForm onSubmit={vi.fn()} />); fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "Correct Owner" } });
  await selectPhoto(); await waitFor(() => expect(screen.getByLabelText("Expiry (MM/YY)")).toHaveValue("11/99"));
  expect(screen.getByLabelText("Name on card")).toHaveValue("CORRECT OWNER"); expect(screen.getByLabelText("Card number")).toHaveValue("");
});
it.each([{}, { expiry: "11/99" }])("keeps toolbar scanning reachable after an unclear reading %j", async fields => {
  scan.read.mockResolvedValueOnce(reading(fields)).mockResolvedValueOnce(reading({ pan: "5555555555554444", expiry: "11/99", cardholderName: "Scanned Owner" }));
  scan.native.mockReturnValue(true);
  scan.pick.mockResolvedValue(new Blob(["synthetic photo"], { type: "image/jpeg" }));
  const save = vi.fn(); render(<SecureCardAddForm onSubmit={save} scanInToolbar />);
  await selectPhoto();
  await waitFor(() => expect(screen.getByTestId("wallet-scan-field-status")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Take photo", exact: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Read card", exact: true })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Read card", exact: true }));
  await waitFor(() => expect(screen.getByLabelText("Card number")).toHaveValue("5555 5555 5555 4444"));
  expect(scan.pick).toHaveBeenCalledWith("camera", expect.any(AbortSignal));
  expect(screen.getByRole("button", { name: "Choose from photos", exact: true })).toBeEnabled();
  expect(save).not.toHaveBeenCalled();
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
  if (exit !== "unmount") expect(screen.getByLabelText("Card number")).toHaveValue("4242 4242 4242 4242"); expect(save).not.toHaveBeenCalled();
});
it("uses native camera and gallery and preserves the draft on cancellation", async () => {
  scan.native.mockReturnValue(true); scan.pick.mockResolvedValue(null); render(<SecureCardAddForm onSubmit={vi.fn()} />); fillRequired();
  fireEvent.click(screen.getByRole("button", { name: "Take photo" })); await waitFor(() => expect(scan.pick).toHaveBeenCalledWith("camera", expect.any(AbortSignal)));
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose from photos" })).not.toBeDisabled()); fireEvent.click(screen.getByRole("button", { name: "Choose from photos" }));
  await waitFor(() => expect(scan.pick).toHaveBeenCalledWith("photos", expect.any(AbortSignal))); expect(screen.getByLabelText("Card number")).toHaveValue("4242 4242 4242 4242"); expect(scan.read).not.toHaveBeenCalled();
});
it("blocks submission when the Add surface becomes inactive", () => {
  const save = vi.fn(), view = render(<SecureCardAddForm onSubmit={save} />); fillRequired(); view.rerender(<SecureCardAddForm active={false} onSubmit={save} />);
  expect(screen.getByLabelText("Card number")).toBeDisabled(); submit(); expect(save).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Card number")).toHaveValue("");
  view.rerender(<SecureCardAddForm active onSubmit={save} />); expect(screen.getByLabelText("Card number")).toHaveValue("4242 4242 4242 4242");
});
it("hides the previous owner's private preview before passive draft cleanup", async () => {
  const photo = new Blob(["synthetic flattened pixels"], { type: "image/png" }), observations: boolean[] = [];
  let context = { userId: "owner-a", vaultOwnerToken: "synthetic-a" };
  function PaintAudit({ owner }: { owner: string }) { useLayoutEffect(() => { if (owner === "owner-b") observations.push(Boolean(document.querySelector('[data-testid="wallet-card-face"]'))); }, [owner]); return null; }
  const form = () => <><SecureCardAddForm getNetworkContext={() => context} onSubmit={vi.fn()} /><PaintAudit owner={context.userId} /></>;
  scan.read.mockResolvedValue({ ...reading({ pan: "4242424242424242", cardholderName: "Synthetic Owner", expiry: "12/30" }), candidate: photo, sanitized: photo });
  const view = render(form()); await selectPhoto(); await screen.findByTestId("wallet-card-face");
  context = { userId: "owner-b", vaultOwnerToken: "synthetic-b" }; view.rerender(form());
  expect(observations).toEqual([false]); expect(screen.queryByTestId("wallet-card-face")).toBeNull(); expect(screen.getByLabelText("Card number")).toHaveValue("");
});
it("requires a manual network when backend identification is unavailable", async () => {
  networkApi.resolve.mockRejectedValue(new Error("private lookup diagnostic"));
  const save = vi.fn().mockResolvedValue(undefined);
  render(<SecureCardAddForm onSubmit={save} scanEnabled={false} />);
  fillRequired();
  expect(await screen.findByText("Choose the card network to continue.")).toBeInTheDocument();
  expect(screen.getByLabelText("Card network")).toHaveTextContent("Auto-detect");
  expect(screen.queryByText("private lookup diagnostic")).toBeNull();
  submit();
  await screen.findByTestId("secure-card-errors");
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Card network")).toHaveAttribute("aria-invalid", "true");
});

it("explains ambiguous networks without displaying a guessed brand", async () => {
  networkApi.resolve.mockResolvedValue({ network: "other", source: "ambiguous", candidates: ["jcb", "rupay"] });
  render(<SecureCardAddForm onSubmit={vi.fn()} scanEnabled={false} />);
  fillRequired();
  expect(await screen.findByText("This number matches more than one network. Choose the network printed on your card.")).toBeInTheDocument();
  expect(screen.getByLabelText("Card network")).toHaveTextContent("Auto-detect");
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
  await waitFor(() => expect(screen.getByLabelText("Card network")).toHaveTextContent("Auto-detect · Mastercard"));
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ network: "amex", source: "prefix", candidates: [] }));
  expect(screen.getByLabelText("Card network")).toHaveTextContent("Auto-detect · Mastercard");
});

it("hides the previous network when the owner authorization changes", async () => {
  let finish!: (value: unknown) => void;
  networkApi.resolve.mockResolvedValueOnce({ network: "visa", source: "prefix", candidates: [] })
    .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const save = vi.fn();
  const view = render(<SecureCardAddForm onSubmit={save} scanEnabled={false} />);
  fillRequired();
  await waitFor(() => expect(screen.getByLabelText("Card network")).toHaveTextContent("Auto-detect · Visa"));
  view.rerender(<SecureCardAddForm onSubmit={save} scanEnabled={false} getNetworkContext={() => ({ userId: "owner", vaultOwnerToken: "renewed-consent" })} />);
  expect(screen.getByLabelText("Card network")).toHaveTextContent(/^Auto-detect$/);
  await waitFor(() => expect(networkApi.resolve).toHaveBeenCalledTimes(2));
  await act(async () => finish({ network: "mastercard", source: "prefix", candidates: [] }));
  expect(screen.getByLabelText("Card network")).toHaveTextContent("Auto-detect · Mastercard");
});

it("offers a new backend network and distinguishes owner selection from identification", async () => {
  networkApi.supported.mockResolvedValue(["visa", "future_network", "other"]);
  render(<SecureCardAddForm onSubmit={vi.fn()} />);
  fillRequired();
  expect(await screen.findByText("Network identified from the card prefix. This does not verify the card or its issuer.")).toBeInTheDocument();
  fireEvent.keyDown(screen.getByLabelText("Card network"), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "FUTURE NETWORK" }));
  expect(await screen.findByText("You selected this network. This does not verify the card or its issuer.")).toBeInTheDocument();
});

it("explains an incompatible manual network length and recovers after correction", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<SecureCardAddForm onSubmit={save} scanEnabled={false} />);
  fillRequired();
  fireEvent.keyDown(screen.getByLabelText("Card network"), { key: "ArrowDown" });
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


it("consumes Back during a pending save and clears the draft only after success", async () => {
  let finish!: () => void;
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const cancel = vi.fn();
  render(<SecureCardAddForm backRoute="/one/wallet" onCancel={cancel} onSubmit={save} />);
  fillRequired();
  await waitFor(() => expect(screen.getByTestId("secure-card-save")).not.toBeDisabled());
  submit(); submit();
  expect(save).toHaveBeenCalledOnce();
  expect(screen.getByLabelText("Card number")).toHaveValue("4242 4242 4242 4242");
  act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(screen.getByLabelText("Card number")).toHaveValue("");
});

it("cancels an inline scan before Add, rejects late fields, and releases inactive Back ownership", async () => {
  let finish!: (draft: ReturnType<typeof reading>) => void;
  scan.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const cancel = vi.fn(), save = vi.fn();
  const props = { backRoute: "/one/wallet", onCancel: cancel, onSubmit: save };
  const view = render(<SecureCardAddForm {...props} />);
  await selectPhoto();
  const signal = scan.read.mock.calls.at(-1)![1] as AbortSignal;
  act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
  expect(signal.aborted).toBe(true);
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => finish(reading({ pan: "5555555555554444" })));
  expect(screen.getByLabelText("Card number")).toHaveValue("");
  act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
  expect(cancel).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
  view.rerender(<SecureCardAddForm {...props} active={false} />);
  expect(unwindBackLayer("/one/wallet")).toBe(false);
  view.unmount(); expect(unwindBackLayer("/one/wallet")).toBe(false);
});

it.each([
  ["911111111116", "Other", "other", "9111 1111 1116"],
  ["378282246310005", "American Express", "amex", "3782 8224 6310 005"],
  ["4242424242424242", "Visa", "visa", "4242 4242 4242 4242"],
])("formats and saves a %s number without persisting separators", async (pan, label, brand, grouped) => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<SecureCardAddForm onSubmit={save} scanEnabled={false} />);
  fireEvent.change(screen.getByLabelText("Card number"), { target: { value: pan } });
  fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "Synthetic Owner" } });
  fireEvent.change(screen.getByLabelText("Expiry (MM/YY)"), { target: { value: "1230" } });
  expect(screen.getByLabelText("Card number")).toHaveValue(grouped);
  expect(screen.getByLabelText("Expiry (MM/YY)")).toHaveValue("12/30");
  expect(screen.queryByText("Additional details")).toBeNull();
  expect(screen.getByLabelText("Issuing region")).toBeVisible();
  fireEvent.keyDown(screen.getByLabelText("Card network"), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: label, exact: true }));
  await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
  fireEvent.click(screen.getByTestId("secure-card-save"));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ pan, brand, expiryMonth: 12, expiryYear: 2030 })));
});

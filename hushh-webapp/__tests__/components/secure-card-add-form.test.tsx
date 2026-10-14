import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SecureCardAddForm as CardForm } from "@/components/wallet/secure-card-add-form";

const networkApi = vi.hoisted(() => ({ resolve: vi.fn(), supported: vi.fn() }));
vi.mock("@/lib/services/wallet-service", () => ({ WalletService: { resolveCardNetwork: networkApi.resolve, supportedCardNetworks: networkApi.supported } }));
// Exercise the real region dropdown with a bounded, representative catalog.
vi.mock("@/lib/constants/country-phone-options", () => ({ COUNTRY_PHONE_OPTIONS: [
  { value: "US", label: "United States" }, { value: "IN", label: "India" },
] }));
const networkContext = () => ({ userId: "owner", vaultOwnerToken: "consent" });
const SecureCardAddForm = (props: React.ComponentProps<typeof CardForm>) => <CardForm getNetworkContext={networkContext} {...props} />;

const scan = vi.hoisted(() => ({ read: vi.fn(), pick: vi.fn(), native: vi.fn() }));
vi.mock("@/lib/services/wallet-card-scan", () => ({ scanWalletCard: scan.read, pickNativeWalletCard: scan.pick, CardScanError: class extends Error {} }));
vi.mock("@/lib/capacitor/platform", () => ({ isNative: scan.native }));
const notify = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notify }));

function fillRequired() {
  fireEvent.change(screen.getByLabelText("Card number"), { target: { value: "4242 4242 4242 4242" } });
  fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "Test Owner" } });
  fireEvent.change(screen.getByLabelText("Expiry (MM/YY)"), { target: { value: "12/99" } });
  fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "123" } });
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
    scan.read.mockReset();
    scan.pick.mockReset();
    scan.native.mockReturnValue(false);
    networkApi.resolve.mockReset();
    networkApi.supported.mockReset();
    networkApi.supported.mockResolvedValue(["visa", "mastercard", "amex", "discover", "rupay", "other"]);
    networkApi.resolve.mockImplementation(async (_context, input) => ({ network: input.selectedNetwork || "visa", source: input.selectedNetwork ? "owner_selected" : "prefix", candidates: [] }));
});

describe("Secure manual card entry", () => {

  it("retries failed network options without discarding the draft or disabling auto-detect", async () => {
    networkApi.supported.mockRejectedValueOnce(new Error("offline"));
    render(<SecureCardAddForm onSubmit={vi.fn()} />);
    fillRequired();
    openAdditional();
    const retry = await screen.findByRole("button", { name: "Retry network options" });
    await screen.findByText("Network identified from the card prefix. This does not verify the card or its issuer.");
    expect(screen.getByTestId("secure-card-save")).not.toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry network options" })).toBeNull());
    openAdditional();
  fireEvent.keyDown(screen.getByLabelText("Card network (optional)"), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "American Express", exact: true })).toBeVisible();
    expect(screen.getByLabelText("Card number")).toHaveValue("4242424242424242");
    expect(networkApi.supported).toHaveBeenCalledTimes(2);
  });

  it("offers scanning alongside manual entry and links validation errors", () => {
    const save = vi.fn();
    render(<SecureCardAddForm scanEnabled onSubmit={save} />);
    expect(screen.getByRole("button", { name: "Scan card" })).toHaveAttribute("type", "button");
    expect(screen.queryByRole("button", { name: "Choose photo" })).toBeNull();
    expect(screen.queryByLabelText("Nickname")).toBeNull();
    expect(screen.getByLabelText("Card network (optional)")).toBeInTheDocument();
    submit();
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(screen.getByLabelText("Name on card")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("CVV")).toHaveAttribute("aria-describedby");
    expect(screen.getByText("Enter the name on your card.")).toBeInTheDocument();
    expect(screen.getByText("Enter the security code on your card.")).toBeInTheDocument();
  });

  it("reopens hidden optional fields on invalid input and keeps the error focused", async () => {
    const save = vi.fn();
    render(<SecureCardAddForm onSubmit={save} />);
    const additional = screen.getByText("Additional details").closest("details")!;
    expect(additional.open).toBe(false);
    fillRequired();
    openAdditional();
    fireEvent.change(screen.getByLabelText("PIN (optional)"), { target: { value: "12" } });
    fireEvent.click(screen.getByText("Additional details"));
    await waitFor(() => expect(additional.open).toBe(false));
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).not.toBeDisabled());
    submit();
    expect(save).not.toHaveBeenCalled();
    expect(additional.open).toBe(true);
    expect(screen.getByLabelText("PIN (optional)")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveFocus();
  });

  it("submits once with omitted optional fields and clears credentials only after success", async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<SecureCardAddForm onSubmit={save} />);
    fillRequired();
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).not.toBeDisabled());
    submit();
    submit();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      pan: "4242424242424242", cardholderName: "Test Owner", nickname: "Visa",
      cvv: "123", expiryMonth: 12, expiryYear: 2099,
      brand: undefined, pin: undefined, issuingRegion: undefined,
    }));
    expect(screen.getByLabelText("CVV")).toHaveValue("123");
    expect(screen.getByTestId("secure-card-save")).toBeDisabled();
    await act(async () => finish());
    expect(screen.getByLabelText("Card number")).toHaveValue("");
    expect(screen.getByLabelText("CVV")).toHaveValue("");
  });

  it("uses the chosen provider, keeps failed drafts retryable, and never displays raw errors", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("private card request details")).mockResolvedValue(undefined);
    render(<SecureCardAddForm onSubmit={save} initialNickname="Offer label" />);
    fillRequired();
    openAdditional();
  fireEvent.keyDown(screen.getByLabelText("Card network (optional)"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Mastercard", exact: true }));
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).not.toBeDisabled());
    submit();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith("Your card could not be saved. Please try again."));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ brand: "mastercard", nickname: "Offer label" }));
    expect(screen.queryByText("private card request details")).toBeNull();
    expect(screen.getByLabelText("Card number")).toHaveValue("4242424242424242");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  });

  it("uses the Profile dropdown for region selection and allows clearing it", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<SecureCardAddForm onSubmit={save} />);
    openAdditional();
    const region = screen.getByLabelText("Issuing region (optional)");
    fireEvent.keyDown(region, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "India", exact: true }));
    expect(region).toHaveTextContent("India");
    fireEvent.keyDown(region, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Select region…", exact: true }));
    fillRequired();
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).not.toBeDisabled());
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ issuingRegion: undefined })));
  });

  it("masks CVV/PIN and blocks submission when the containing tab becomes inactive", () => {
    const save = vi.fn();
    const view = render(<SecureCardAddForm onSubmit={save} />);
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Show CVV and PIN" }));
    expect(screen.getByLabelText("CVV")).toHaveAttribute("type", "text");
    view.rerender(<SecureCardAddForm active={false} onSubmit={save} />);
    expect(screen.getByLabelText("CVV")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Card number")).toBeDisabled();
    expect(screen.getByLabelText("Card network (optional)")).toBeDisabled();
    expect(screen.getByLabelText("Issuing region (optional)")).toBeDisabled();
    submit();
    expect(save).not.toHaveBeenCalled();
  });
});

it("reviews scanned fields without saving and clears old security codes", async () => {
  networkApi.supported.mockResolvedValue(["visa", "mastercard", "other"]);
  networkApi.resolve.mockResolvedValue({ network: "mastercard", source: "prefix", candidates: [] });
  scan.read.mockResolvedValue({ pan: "5555555555554444", expiry: "11/99", cardholderName: "Scanned Owner" });
  const save = vi.fn();
  render(<SecureCardAddForm scanInToolbar onSubmit={save} />);
  fillRequired();
  const trigger = screen.getByRole("button", { name: "Scan card", exact: true });
  expect(trigger.querySelector("img")).not.toBeNull();
  expect(trigger).toHaveTextContent(/^$/);
  expect(screen.queryByText("Add your card with a photo")).toBeNull();
  const capture = screen.getByLabelText("Take a card photo");
  const openCamera = vi.spyOn(capture as HTMLInputElement, "click");
  fireEvent.click(screen.getByRole("button", { name: "Scan card", exact: true }));
  expect(openCamera).toHaveBeenCalledOnce();
  expect(capture).toHaveAttribute("capture", "environment");
  expect(screen.queryByRole("dialog")).toBeNull();
  const photo = new File(["synthetic"], "card.jpg", { type: "image/jpeg" });
  fireEvent.change(capture, { target: { files: [photo] } });
  await waitFor(() => expect(screen.getByLabelText("Card number")).toHaveValue("5555555555554444"));
  expect(scan.read).toHaveBeenCalledWith(photo, expect.any(AbortSignal));
  expect(capture).toHaveValue("");
  expect(screen.getByLabelText("Name on card")).toHaveValue("Scanned Owner");
  expect(screen.getByLabelText("Expiry (MM/YY)")).toHaveValue("11/99");
  expect(screen.getByLabelText("CVV")).toHaveValue("");
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "321" } });
  await waitFor(() => expect(screen.getByTestId("secure-card-save")).not.toBeDisabled());
  submit();
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
});

it("leaves the draft intact on camera cancellation and scan failure, then allows retry", async () => {
  scan.read.mockRejectedValueOnce(new Error("private image diagnostic"))
    .mockResolvedValueOnce({ pan: "5555555555554444", expiry: "11/99" });
  render(<SecureCardAddForm onSubmit={vi.fn()} />);
  fillRequired();
  const capture = screen.getByLabelText("Take a card photo");
  fireEvent.change(capture, { target: { files: [] } });
  expect(scan.read).not.toHaveBeenCalled();
  const photo = new File(["synthetic"], "card.jpg", { type: "image/jpeg" });
  fireEvent.change(capture, { target: { files: [photo] } });
  expect(await screen.findByText(/Card scanning is unavailable right now/)).toBeVisible();
  expect(screen.queryByText("private image diagnostic")).toBeNull();
  expect(screen.getByLabelText("Card number")).toHaveValue("4242424242424242");
  expect(screen.getByLabelText("CVV")).toHaveValue("123");
  fireEvent.change(capture, { target: { files: [photo] } });
  await waitFor(() => expect(screen.getByLabelText("Card number")).toHaveValue("5555555555554444"));
});

it.each(["cancel", "inactive", "unmount"])("discards late photo recognition after %s", async (exit) => {
  let finish!: (value: { pan: string }) => void;
  scan.read.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const save = vi.fn();
  const view = render(<SecureCardAddForm onSubmit={save} />);
  fillRequired();
  fireEvent.change(screen.getByLabelText("Take a card photo"), { target: { files: [new File(["synthetic"], "card.jpg", { type: "image/jpeg" })] } });
  await waitFor(() => expect(scan.read).toHaveBeenCalledOnce());
  const signal = scan.read.mock.calls[0][1] as AbortSignal;
  if (exit === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel scan" }));
  else if (exit === "inactive") view.rerender(<SecureCardAddForm active={false} onSubmit={save} />);
  else view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ pan: "5555555555554444" }));
  if (exit !== "unmount") expect(screen.getByLabelText("Card number")).toHaveValue("4242424242424242");
  expect(save).not.toHaveBeenCalled();
});

it("uses the native camera plugin and handles cancellation without changing the draft", async () => {
  scan.native.mockReturnValue(true);
  scan.pick.mockResolvedValueOnce(null).mockResolvedValueOnce(new Blob(["synthetic"], { type: "image/jpeg" }));
  scan.read.mockResolvedValue({ pan: "5555555555554444" });
  render(<SecureCardAddForm onSubmit={vi.fn()} />);
  fillRequired();
  const capture = vi.spyOn(screen.getByLabelText("Take a card photo") as HTMLInputElement, "click");
  fireEvent.click(screen.getByRole("button", { name: "Scan card", exact: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Scan card", exact: true })).not.toBeDisabled());
  expect(scan.pick).toHaveBeenCalledWith("camera");
  expect(scan.read).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Card number")).toHaveValue("4242424242424242");
  fireEvent.click(screen.getByRole("button", { name: "Scan card", exact: true }));
  await waitFor(() => expect(screen.getByLabelText("Card number")).toHaveValue("5555555555554444"));
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
  fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "1234" } });
  expect(await screen.findByText("You selected this network. This does not verify the card or its issuer.")).toBeInTheDocument();
  submit();
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ brand: "amex", pan: "378282246310005", cvv: "1234" })));
});

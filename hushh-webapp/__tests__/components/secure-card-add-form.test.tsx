import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { SecureCardAddForm } from "@/components/wallet/secure-card-add-form";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { pickNativeWalletCard } from "@/lib/services/wallet-card-scan";

const scan = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/services/wallet-card-scan", () => ({ scanWalletCard: scan.read, pickNativeWalletCard: vi.fn() }));
const notify = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notify }));

function fillRequired() {
  fireEvent.change(screen.getByLabelText("Card number"), { target: { value: "4242 4242 4242 4242" } });
  fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "Test Owner" } });
  fireEvent.change(screen.getByLabelText("Expiry (MM/YY)"), { target: { value: "12/99" } });
  fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "123" } });
}

function submit() {
  fireEvent.submit(screen.getByTestId("secure-card-add-form"));
}

describe("Secure manual card entry", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it("submits once with omitted optional fields and clears credentials only after success", async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const cancel = vi.fn();
    render(<SecureCardAddForm backRoute="/one/wallet" onCancel={cancel} onSubmit={save} />);
    fillRequired();
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
    act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(screen.getByLabelText("Card number")).toHaveValue("");
    expect(screen.getByLabelText("CVV")).toHaveValue("");
  });

  it("uses the chosen provider, keeps failed drafts retryable, and never displays raw errors", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("private card request details")).mockResolvedValue(undefined);
    render(<SecureCardAddForm onSubmit={save} initialNickname="Offer label" />);
    fillRequired();
    fireEvent.keyDown(screen.getByLabelText("Card network (optional)"), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Mastercard", exact: true }));
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
    const region = screen.getByRole("combobox", { name: "Issuing region (optional)" });
    fireEvent.keyDown(region, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "India", exact: true }));
    expect(region).toHaveTextContent("India");
    fireEvent.keyDown(region, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Select region…", exact: true }));
    fillRequired();
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
    expect(screen.getByRole("combobox", { name: "Card network (optional)" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Issuing region (optional)" })).toBeDisabled();
    submit();
    expect(save).not.toHaveBeenCalled();
  });
});

it("cancels an inline scan before Add, rejects late fields, and releases inactive Back ownership", async () => {
  const platform = vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  let finish!: (fields: { pan: string }) => void;
  scan.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(pickNativeWalletCard).mockResolvedValue(new Blob(["synthetic"]));
  const cancel = vi.fn();
  const save = vi.fn();
  const props = { backRoute: "/one/wallet", onCancel: cancel, onSubmit: save };
  const view = render(<SecureCardAddForm {...props} />);
  try {
    fireEvent.click(screen.getByRole("button", { name: "Scan card", exact: true }));
    await waitFor(() => expect(scan.read).toHaveBeenCalled());
    const signal = scan.read.mock.calls.at(-1)![1] as AbortSignal;
    act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    expect(signal.aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => finish({ pan: "5555555555554444" }));
    expect(screen.getByLabelText("Card number")).toHaveValue("");
    act(() => { expect(unwindBackLayer("/one/wallet")).toBe(true); });
    expect(cancel).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    view.rerender(<SecureCardAddForm {...props} active={false} />);
    expect(unwindBackLayer("/one/wallet")).toBe(false);
    view.unmount();
    expect(unwindBackLayer("/one/wallet")).toBe(false);
  } finally {
    platform.mockRestore();
  }
});

it("reviews scanned fields without saving and clears old security codes", async () => {
  scan.read.mockResolvedValue({ pan: "5555555555554444", expiry: "11/99", cardholderName: "Scanned Owner" });
  const save = vi.fn();
  render(<SecureCardAddForm onSubmit={save} />);
  fillRequired();
  const stop = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) } });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob(["test"], { type: "image/jpeg" })));
  fireEvent.click(screen.getByRole("button", { name: "Scan card", exact: true }));
  const preview = screen.getByLabelText("Card camera preview");
  Object.defineProperties(preview, { videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
  await waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
  fireEvent.loadedData(preview);
  fireEvent.click(screen.getByRole("button", { name: "Capture card" }));
  await waitFor(() => expect(stop).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByLabelText("Card number")).toHaveValue("5555555555554444"));
  expect(screen.getByLabelText("Name on card")).toHaveValue("Scanned Owner");
  expect(screen.getByLabelText("Expiry (MM/YY)")).toHaveValue("11/99");
  expect(screen.getByLabelText("CVV")).toHaveValue("");
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("CVV"), { target: { value: "321" } });
  submit();
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
});

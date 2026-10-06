import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SecureCardAddForm } from "@/components/wallet/secure-card-add-form";
const scan = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/wallet-card-scan", () => ({ scanWalletCard: scan, pickNativeWalletCard: vi.fn() }));
vi.mock("@/lib/capacitor/platform", () => ({ isNative: () => false }));
const upload = () => fireEvent.change(screen.getByTestId("wallet-scan-photos"), { target: { files: [new File(["synthetic"], "card.png", { type: "image/png" })] } });
describe("Wallet single-screen scan", () => {
  beforeEach(() => { scan.mockReset(); });
  it("replaces placeholder characters with digits and accepts a formatted paste", () => {
    render(<SecureCardAddForm scanEnabled onSubmit={vi.fn()} />);
    const input = screen.getByTestId("secure-card-pan-input");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "XXXX XXXX XXXX XXXX");
    fireEvent.change(input, { target: { value: "XXXX 4242 4242 4242 4242" } });
    expect(input).toHaveValue("4242424242424242");
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("");
  });
  it("prefills reviewable fields, preserves manual name and never auto-saves", async () => {
    scan.mockResolvedValue({ pan: "4242424242424242", expiry: "12/30", cardholderName: "Demo Owner" });
    const save = vi.fn(); render(<SecureCardAddForm scanEnabled onSubmit={save} />);
    fireEvent.change(screen.getByLabelText("Name on card"), { target: { value: "My Name" } });
    upload();
    await waitFor(() => expect(screen.getByTestId("secure-card-pan-input")).toHaveValue("4242424242424242"));
    expect(screen.getByLabelText("Name on card")).toHaveValue("My Name");
    expect(screen.getByLabelText("Expiry (MM/YY)")).toHaveValue("12/30");
    expect(save).not.toHaveBeenCalled();
  });
  it("ignores a late result after leaving Add", async () => {
    let resolve!: (value: { pan: string }) => void;
    scan.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const save = vi.fn(); const view = render(<SecureCardAddForm scanEnabled onSubmit={save} />);
    upload(); await waitFor(() => expect(scan).toHaveBeenCalled());
    view.rerender(<SecureCardAddForm scanEnabled active={false} onSubmit={save} />);
    expect(scan.mock.calls[0][1].aborted).toBe(true);
    await act(async () => resolve({ pan: "4242424242424242" }));
    expect(screen.getByTestId("secure-card-pan-input")).toHaveValue("");
  });
  it("restores manual entry after failure without exposing OCR errors", async () => {
    scan.mockRejectedValue(new Error("private OCR output"));
    render(<SecureCardAddForm scanEnabled onSubmit={vi.fn()} />); upload();
    await screen.findByText(/We couldn't read the card/);
    expect(screen.queryByText("private OCR output")).not.toBeInTheDocument();
    expect(screen.getByTestId("secure-card-save")).toBeEnabled();
  });
});

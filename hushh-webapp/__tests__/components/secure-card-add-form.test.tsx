import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SecureCardAddForm } from "@/components/wallet/secure-card-add-form";

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

  it("removes scanner/photo/nickname entry, requires card details and links validation errors", () => {
    const save = vi.fn();
    render(<SecureCardAddForm scanEnabled onSubmit={save} />);
    expect(screen.queryByText("Scan card")).toBeNull();
    expect(screen.queryByText("Choose photo")).toBeNull();
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
    render(<SecureCardAddForm onSubmit={save} />);
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
    await act(async () => finish());
    expect(screen.getByLabelText("Card number")).toHaveValue("");
    expect(screen.getByLabelText("CVV")).toHaveValue("");
  });

  it("uses the chosen provider, keeps failed drafts retryable, and never displays raw errors", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("private card request details")).mockResolvedValue(undefined);
    render(<SecureCardAddForm onSubmit={save} initialNickname="Offer label" />);
    fillRequired();
    fireEvent.change(screen.getByLabelText("Card network (optional)"), { target: { value: "mastercard" } });
    submit();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith("Your card could not be saved. Please try again."));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ brand: "mastercard", nickname: "Offer label" }));
    expect(screen.queryByText("private card request details")).toBeNull();
    expect(screen.getByLabelText("Card number")).toHaveValue("4242424242424242");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
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
    submit();
    expect(save).not.toHaveBeenCalled();
  });
});

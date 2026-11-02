import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PhoneConflictRecovery } from "@/components/auth/phone-conflict-recovery";
import { unwindBackLayer } from "@/lib/navigation/back-layers";

vi.mock("next/navigation", () => ({ usePathname: () => "/register-phone" }));

describe("phone conflict Account options", () => {
  it("dismisses the sheet before leaving phone entry and releases its Back owner", async () => {
    const recoverPrevious = vi.fn().mockResolvedValue(undefined);
    const returnToPhoneNumber = vi.fn().mockReturnValue(true);
    const view = render(<PhoneConflictRecovery busy={false} operationError={null}
      recoverPrevious={recoverPrevious} returnToPhoneNumber={returnToPhoneNumber} />);
    fireEvent.click(screen.getByRole("button", { name: "Account options" }));
    expect(await screen.findByRole("dialog", { name: "Account options" })).toBeVisible();
    expect(recoverPrevious).not.toHaveBeenCalled();
    act(() => { expect(unwindBackLayer("/register-phone")).toBe(true); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(returnToPhoneNumber).not.toHaveBeenCalled();
    expect(unwindBackLayer("/register-phone")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Account options" }));
    view.unmount();
    expect(unwindBackLayer("/register-phone")).toBe(false);
  });

  it("cannot dispatch account sign-in from an already-open sheet while busy", async () => {
    const props = { operationError: null, recoverPrevious: vi.fn(), returnToPhoneNumber: vi.fn() };
    const view = render(<PhoneConflictRecovery {...props} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Account options" }));
    const signIn = await screen.findByRole("button", { name: "Sign in to existing account" });
    view.rerender(<PhoneConflictRecovery {...props} busy />);
    expect(signIn).toBeDisabled();
    fireEvent.click(signIn);
    expect(props.recoverPrevious).not.toHaveBeenCalled();
    view.unmount();
  });
});

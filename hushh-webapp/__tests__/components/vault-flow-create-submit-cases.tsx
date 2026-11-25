import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi, type Mock } from "vitest";
import type { VaultFlow as OwnerVaultFlow } from "@/components/vault/vault-flow";

/** Register these cases in the original suite so its auth fixtures and hooks apply. */
export function registerVaultCreateSubmitCases(
  VaultFlow: typeof OwnerVaultFlow,
  user: Parameters<typeof OwnerVaultFlow>[0]["user"],
  createVaultMock: Mock,
) {
  it("submits vault creation when Enter is pressed on a valid confirmation", async () => {
    const onRecoveryKeyDisclosureChange = vi.fn();
    const view = render(
      <VaultFlow
        user={user}
        onSuccess={vi.fn()}
        onRecoveryKeyDisclosureChange={onRecoveryKeyDisclosureChange}
      />,
    );

    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "correct horse battery staple" },
    });
    const confirmation = screen.getByLabelText("Confirm password");
    fireEvent.change(confirmation, {
      target: { value: "correct horse battery staple" },
    });

    fireEvent.submit(confirmation.closest("form")!);

    await screen.findByRole("heading", { name: /save your recovery key/i });
    expect(document.querySelector("[data-vault-recovery-key]")).toBeTruthy();
    expect(screen.getByText("HRK-0001-0203-0405-0607-0809-0A0B-0C0D-0E0F")).toBeTruthy();
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(onRecoveryKeyDisclosureChange).toHaveBeenLastCalledWith(true);
    expect(createVaultMock).toHaveBeenCalledTimes(1);
    expect(createVaultMock).toHaveBeenCalledWith(
      "correct horse battery staple",
    );

    view.unmount();
    expect(onRecoveryKeyDisclosureChange).toHaveBeenLastCalledWith(false);
  });

  it("never creates a vault while either password field has unfinished composition", async () => {
    render(<VaultFlow user={user} onSuccess={vi.fn()} />);
    const password = await screen.findByLabelText("Password");
    const confirmation = screen.getByLabelText("Confirm password");
    const form = confirmation.closest("form")!;
    const createButton = screen.getByRole("button", { name: "Create password" });
    fireEvent.change(password, { target: { value: "fixture-password" } });
    fireEvent.change(confirmation, { target: { value: "fixture-password" } });

    for (const field of [password, confirmation]) {
      fireEvent.compositionStart(field);
      expect(createButton).toBeDisabled();
      fireEvent.submit(form);
      await act(async () => {});
      expect(createVaultMock).not.toHaveBeenCalled();
      fireEvent.compositionEnd(field);
    }

    fireEvent.submit(form);
    await waitFor(() => expect(createVaultMock).toHaveBeenCalledOnce());
    expect(createVaultMock).toHaveBeenCalledWith("fixture-password");
  });

  it("does not create a vault from the Enter that confirms an IME candidate", async () => {
    render(<VaultFlow user={user} onSuccess={vi.fn()} />);
    const password = await screen.findByLabelText("Password");
    const confirmation = screen.getByLabelText("Confirm password");
    const form = confirmation.closest("form")!;
    fireEvent.change(password, { target: { value: "fixture-password-final" } });
    fireEvent.change(confirmation, { target: { value: "fixture-password-final" } });
    fireEvent.compositionStart(confirmation);
    fireEvent.keyDown(confirmation, { key: "Enter", keyCode: 229, isComposing: true });
    fireEvent.compositionEnd(confirmation);
    fireEvent.submit(form);
    await act(async () => {});
    expect(createVaultMock).not.toHaveBeenCalled();
    fireEvent.submit(form);
    await waitFor(() => expect(createVaultMock).toHaveBeenCalledWith("fixture-password-final"));
  });

}

import { authMock, vaultMock, serviceMock, makeCards, fillCard } from "./wallet-workspace-fixture";
import { WalletWorkspace } from "@/components/wallet/wallet-workspace";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("Wallet background saves", () => {
  it("closes Add immediately, prevents duplicate dispatch, and completes without stealing the selected tab", async () => {
    let finish!: (value: unknown) => void;
    serviceMock.addCard.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByTestId("wallet-card-browser");
    fireEvent.click(screen.getByTestId("one-wallet-add")); fillCard();
    const save = screen.getByTestId("secure-card-save");
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save); fireEvent.click(save);
    expect(await screen.findByTestId("wallet-pending-save")).toHaveTextContent("Saving card…");
    await waitFor(() => expect(screen.queryByTestId("secure-card-add-form")).toBeNull());
    expect(screen.getByTestId("one-wallet-add")).toBeDisabled();
    expect(serviceMock.addCard).toHaveBeenCalledOnce();
    expect(screen.getByTestId("wallet-pending-save").querySelector("button")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Shared with me", exact: true }));
    const summary = { ...makeCards(1)[0]!, cardId: "saved", nickname: "Background card", last4: "4242" };
    await act(async () => finish({ cardId: "saved", summary, cardholderName: "NEW CARD" }));
    expect(screen.getByRole("tab", { name: "Shared with me", exact: true })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "My cards", exact: true }));
    expect(screen.getByRole("button", { name: "Background card", exact: true })).toBeVisible();
    expect(screen.queryByTestId("wallet-pending-save")).toBeNull();
    expect(screen.queryByTestId("wallet-selected-card")).toBeNull();
  });
  it("retains a failed save in memory and retries the same draft without duplicating the card", async () => {
    serviceMock.addCard.mockRejectedValueOnce(new Error("Uncertain save acknowledgement"));
    render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByTestId("wallet-card-browser");
    fireEvent.click(screen.getByTestId("one-wallet-add")); fillCard();
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
    fireEvent.click(screen.getByTestId("secure-card-save"));
    const retry = await screen.findByRole("button", { name: "Retry save", exact: true });
    const original = serviceMock.addCard.mock.calls[0][0].card;
    expect(screen.getByTestId("wallet-pending-save")).toHaveTextContent("Save not confirmed");
    const summary = { ...makeCards(1)[0]!, cardId: "saved", nickname: "Retried card", last4: "4242" };
    serviceMock.addCard.mockResolvedValueOnce({ cardId: "saved", summary, cardholderName: "NEW CARD" });
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Retried card", exact: true });
    expect(serviceMock.addCard).toHaveBeenCalledTimes(2);
    expect(serviceMock.addCard.mock.calls[1][0].card).toEqual(original);
    expect(serviceMock.addCard.mock.calls[1][0].card.draftId).toBe(original.draftId);
    expect(document.querySelectorAll('[data-wallet-card-id="saved"]')).toHaveLength(1);
  });
  it.each(["lock", "owner", "hide", "epoch"])("retires pending save and retry information on %s, rejecting late completion", async boundary => {
    let finish!: (value: unknown) => void;
    serviceMock.addCard.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const workspace = render(<WalletWorkspace />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByTestId("wallet-card-browser");
    fireEvent.click(screen.getByTestId("one-wallet-add")); fillCard();
    await waitFor(() => expect(screen.getByTestId("secure-card-save")).toBeEnabled());
    fireEvent.click(screen.getByTestId("secure-card-save"));
    await screen.findByTestId("wallet-pending-save");
    let visibility: ReturnType<typeof vi.spyOn> | undefined;
    if (boundary === "lock") { vaultMock.locked = true; workspace.rerender(<WalletWorkspace />); }
    if (boundary === "owner") { authMock.user = { uid: "another_owner" }; workspace.rerender(<WalletWorkspace />); }
    if (boundary === "epoch") act(() => advanceVaultSessionEpoch());
    if (boundary === "hide") { visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange")); }
    await act(async () => finish({ cardId: "retired", summary: { ...makeCards(1)[0]!, cardId: "retired", nickname: "Retired save" }, cardholderName: "PRIVATE RETIRED NAME" }));
    expect(screen.queryByTestId("wallet-pending-save")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retired save", exact: true })).toBeNull();
    expect(document.body).not.toHaveTextContent("PRIVATE RETIRED NAME");
    visibility?.mockRestore();
  });

});

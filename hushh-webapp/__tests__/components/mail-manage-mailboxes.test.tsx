/**
 * Disconnect is the one action here that deletes data, so it names the mailbox twice: on its row and in the confirmation.
 * Nothing is disconnected until the owner confirms, and only the mailbox that was named.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MailManageMailboxes } from "@/components/gmail/mail-manage-mailboxes";

afterEach(cleanup);

describe("Manage mailboxes", () => {
  it("disconnects only the mailbox the owner named, and only after they confirm", async () => {
    const onDisconnect = vi.fn().mockResolvedValue(true);
    render(<MailManageMailboxes mailboxes={[{ id: "a", email: "a@example.test" }, { id: "b", email: "b@example.test" }]} busy={false} onDisconnect={onDisconnect} />);
    fireEvent.click(screen.getByTestId("mail-manage-mailboxes"));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect b@example.test" }));
    expect(await screen.findByText("Disconnect b@example.test?")).toBeTruthy();
    expect(onDisconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep connected" }));
    expect(onDisconnect).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect a@example.test" }));
    fireEvent.click(screen.getByTestId("mail-disconnect-confirm-action"));
    await waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce());
    expect(onDisconnect).toHaveBeenCalledWith("a");
  });
});

/**
 * The mailbox menu: every mailbox with what needs the owner, the chosen one checked, and Add account
 * only while another mailbox still fits. A lapsed mailbox offers Reconnect and cannot be chosen.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MailHeader, type MailHeaderAccount } from "@/components/gmail/mail-header";

const box = (id: string, over: Partial<MailHeaderAccount> = {}): MailHeaderAccount => ({ id, email: `${id}@example.test`, ...over });

function open(accounts: MailHeaderAccount[], extra: Partial<Parameters<typeof MailHeader>[0]> = {}) {
  const handlers = { onChoose: vi.fn(), onAddAccount: vi.fn(), onReconnectAccount: vi.fn() };
  render(<MailHeader email="a@example.test" attentionCount={4} accounts={accounts} selectedId="a" counts={{ a: 4, b: 2 }} {...handlers} {...extra} />);
  fireEvent.keyDown(screen.getByTestId("mail-account-chip"), { key: "Enter" });
  return handlers;
}
afterEach(cleanup);

describe("the mailbox menu", () => {
  it("lists each mailbox with its own count, checks the chosen one and leaves a mailbox not yet read without a count", async () => {
    open([box("a"), box("b"), box("c")]);
    const rows = await screen.findAllByTestId("mail-account-option");
    expect(rows.map((row) => row.textContent)).toEqual(["a@example.test4", "b@example.test2", "c@example.test"]);
    expect(within(rows[0]!).getByLabelText("Selected")).toBeVisible();
    expect(within(rows[1]!).queryByLabelText("Selected")).toBeNull();
  });

  it("offers Add account below three mailboxes and never at three, and has no Reconnect or Disconnect of its own", async () => {
    const two = open([box("a"), box("b")]);
    fireEvent.click(await screen.findByTestId("mail-add-account"));
    expect(two.onAddAccount).toHaveBeenCalledOnce();
    cleanup();
    open([box("a"), box("b"), box("c")]);
    await screen.findAllByTestId("mail-account-option");
    expect(screen.queryByTestId("mail-add-account")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Disconnect|^Reconnect$/ })).toBeNull();
  });

  it("counts a mailbox that needs reconnecting toward the three, and reconnects that one only", async () => {
    const handlers = open([box("a"), box("b"), box("c", { needsReconnect: true })]);
    expect(screen.queryByTestId("mail-add-account")).toBeNull();
    expect(await screen.findAllByTestId("mail-account-option")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("mail-account-reconnect"));
    expect(handlers.onReconnectAccount).toHaveBeenCalledWith("c");
    expect(handlers.onChoose).not.toHaveBeenCalled();
  });

  it("keeps the single-mailbox menu (Reconnect, Disconnect) for an owner without a mailbox list", async () => {
    const reconnect = vi.fn();
    const disconnect = vi.fn();
    render(<MailHeader email="a@example.test" attentionCount={0} onReconnect={reconnect} onDisconnect={disconnect} />);
    fireEvent.keyDown(screen.getByTestId("mail-account-chip"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

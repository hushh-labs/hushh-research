/**
 * The mailbox menu: every mailbox with what needs the owner, the chosen one checked, and Add account
 * only while another mailbox still fits. A lapsed mailbox offers Reconnect and cannot be chosen.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  it("offers Add account only below three mailboxes, counts a lapsed one toward the three, and has no Disconnect", async () => {
    const two = open([box("a"), box("b")]);
    fireEvent.click(await screen.findByTestId("mail-add-account"));
    expect(two.onAddAccount).toHaveBeenCalledOnce();
    cleanup();
    const three = open([box("a"), box("b"), box("c", { needsReconnect: true })]);
    expect(await screen.findAllByTestId("mail-account-option")).toHaveLength(2);
    expect(screen.queryByTestId("mail-add-account")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Disconnect/ })).toBeNull();
    fireEvent.click(screen.getByTestId("mail-account-reconnect"));
    expect(three.onReconnectAccount).toHaveBeenCalledWith("c");
    expect(three.onChoose).not.toHaveBeenCalled();
  });
});

/**
 * Saving a draft writes a Task, and every Task write replaces the saved-Tasks promise the
 * session hands this screen. That refresh must not reset the screen or cancel the save that
 * caused it, and a draft the Overview asked for creates nothing until it is saved.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MailFollowupsScreen, type MailDraftRequest } from "@/components/gmail/mail-followups-screen";
import type { MailFollowup } from "@/lib/mail/mail-followup-model";

const todos = vi.hoisted(() => ({ load: vi.fn(), trackMail: vi.fn(), updateMail: vi.fn() }));
vi.mock("@/lib/services/todo-list-pkm-service", () => ({ TodoListPkmService: todos }));
vi.mock("@/lib/services/pod-scheduled-tasks", () => ({
  MAIL_FOLLOWUP_TEMPLATE: "agent_email.send_followup.v1",
  PodScheduledTasksClient: class { status = async () => ({ available: false, code: null, templates: [], tasks: [], authorization_limit_at: null }); },
}));
vi.mock("@/components/gmail/mail-followups-session-watch", () => ({ checkMailFollowup: vi.fn(), useSettledMailTasks: () => undefined }));
vi.mock("next/navigation", () => ({ usePathname: () => "/one/gmail" }));

const sid = (name: string) => `ms1.${name.padEnd(24, "x")}`;
const session = { userId: "owner", vaultKey: "key", vaultOwnerToken: "token" };
const box = { account: "acct-a", connection: "conn-a", address: "neha@hushh.ai" };
const KEY = "b".repeat(64);
const finding: MailFollowup = {
  account: box.account, connection: box.connection, source_kind: "mail_thread", key: KEY, thread: sid("morgan"), source: sid("morgan"),
  title: "Choose the payment term", participant: "Morgan Lee", debtor: "morgan@example.test", waiting_on: "owner",
  fulfilment: "A payment term", quote: "Please choose a payment term.", document: null, promised_wording: null,
};
const request: MailDraftRequest = { id: "r1", sourceId: sid("morgan"), title: "Choose the payment term", expectation: "Reply to this message: Choose the payment term" };

function services() {
  return {
    draft: vi.fn(async () => ({ to: "morgan@example.test", subject: "Re: Payment terms", body: "Thirty days works for us." })),
    track: vi.fn(async () => finding),
    recent: vi.fn(async () => ({ items: [] })),
  };
}
function mount(mail = services(), draftRequest: MailDraftRequest | null = request) {
  const tree = (saved: Promise<{ tasks: unknown[] }>, req = draftRequest ?? undefined) => (
    <MailFollowupsScreen mail={mail as never} session={session} account={box.account} connection={box.connection}
      verifiedAddress={box.address} savedTasks={saved as never} draftRequest={req} />
  );
  const view = render(tree(Promise.resolve({ tasks: [] })));
  return { mail, rerenderWith: (saved: Promise<{ tasks: unknown[] }>) => view.rerender(tree(saved)), ...view };
}

beforeEach(() => {
  todos.load.mockReset().mockResolvedValue({ tasks: [] });
  todos.trackMail.mockReset().mockResolvedValue({ success: true });
  todos.updateMail.mockReset().mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe("a draft the Overview asked for", () => {
  it("opens for review and creates no Task until it is saved", async () => {
    const { mail } = mount();
    expect(await screen.findByRole("heading", { name: "Review draft" })).toBeVisible();
    expect(mail.draft).toHaveBeenCalledWith(box, request.sourceId, request.expectation, expect.anything());
    expect(screen.getByLabelText("Message")).toHaveValue("Thirty days works for us.");
    expect(todos.trackMail).not.toHaveBeenCalled();
    expect(todos.updateMail).not.toHaveBeenCalled();
  });

  it("is saved to one Task for that email even when saving refreshes the saved Tasks mid-way", async () => {
    const { mail, rerenderWith } = mount();
    await screen.findByRole("heading", { name: "Review draft" });
    const task = { id: KEY, title: finding.title, status: "pending", revision: 1, mailFollowup: finding };
    // The write replaces the session's saved-Tasks promise while the save is still running.
    todos.trackMail.mockImplementation(async () => {
      rerenderWith(Promise.resolve({ tasks: [task] }));
      return { success: true };
    });
    todos.load.mockResolvedValue({ tasks: [task] });
    fireEvent.click(screen.getByRole("button", { name: "Save for review" }));
    await waitFor(() => expect(screen.getByText("Draft saved for review.")).toBeVisible());
    expect(mail.track).toHaveBeenCalledTimes(1);
    expect(todos.trackMail).toHaveBeenCalledTimes(1);
    expect(todos.trackMail).toHaveBeenCalledWith(session, expect.objectContaining({ source: request.sourceId }));
    expect(todos.updateMail).toHaveBeenCalledWith(session, task, { draft: { to: "morgan@example.test", subject: "Re: Payment terms", body: "Thirty days works for us." } });
    expect(screen.queryByRole("heading", { name: "Review draft" })).toBeNull();
  });

  it("refuses to save for another mailbox's finding", async () => {
    const mail = services();
    mail.track.mockResolvedValue({ ...finding, connection: "conn-b" });
    mount(mail);
    await screen.findByRole("heading", { name: "Review draft" });
    fireEvent.click(screen.getByRole("button", { name: "Save for review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The mailbox changed");
    expect(todos.trackMail).not.toHaveBeenCalled();
  });
});

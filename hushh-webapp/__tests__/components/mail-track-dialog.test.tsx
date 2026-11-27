/**
 * Track a conversation. Opening or searching only reads one mailbox; the one Task is
 * created when the owner confirms, linked to the exact email. A list always belongs to
 * the query that asked for it.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MailTrackDialog, TRACK_SEARCH_DELAY_MS } from "@/components/gmail/mail-track-dialog";
import type { MailFollowup } from "@/lib/mail/mail-followup-model";

const todos = vi.hoisted(() => ({ trackMail: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/services/todo-list-pkm-service", () => ({ TodoListPkmService: todos }));

const sid = (name: string) => `ms1.${name.padEnd(24, "x")}`;
const box = { account: "acct-a", connection: "conn-a", address: "neha@hushh.ai" };
const session = { userId: "owner", vaultKey: "key", vaultOwnerToken: "token" };
const row = (name: string, subject: string, sender: string) => ({ source: sid(name), subject, sender });
const RECENT = [row("metro", "Payment pending · MetroGo", "MetroGo <receipts@metrogo.example>"), row("priya", "Proposal approved", "Priya Shah <priya@northstar.example>")];
const finding = (over: Partial<MailFollowup> = {}): MailFollowup => ({
  account: box.account, connection: box.connection, source_kind: "mail_thread", key: "a".repeat(64), thread: sid("priya"), source: sid("priya"),
  title: "Get the signed proposal", participant: "Priya Shah", debtor: "priya@northstar.example", waiting_on: "participant",
  fulfilment: "The signed proposal", quote: "I will send the signed proposal.", document: null, promised_wording: null, ...over,
});

function services() {
  return {
    recent: vi.fn(async () => ({ items: RECENT })),
    search: vi.fn(async (_box: unknown, query: string) => ({ items: RECENT.filter((item) => item.subject.toLowerCase().includes(query.toLowerCase())) })),
    track: vi.fn(async () => finding()),
  };
}
function mount(mail = services(), extra: Partial<Parameters<typeof MailTrackDialog>[0]> = {}) {
  const handlers = { onClose: vi.fn(), onTracked: vi.fn() };
  const view = render(
    <MailTrackDialog open mail={mail as never} box={box} session={session} existing={[]} {...handlers} {...extra} />,
  );
  return { mail, ...handlers, ...view };
}
const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

beforeEach(() => {
  todos.trackMail.mockReset().mockResolvedValue({ success: true });
  todos.load.mockReset().mockResolvedValue({ tasks: [] });
});
afterEach(cleanup);

describe("opening the picker", () => {
  it("shows the selected mailbox and its recent conversations before anything is typed, and creates nothing", async () => {
    const { mail } = mount();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("track-mailbox")).toHaveTextContent("neha@hushh.ai");
    expect(await within(dialog).findByRole("button", { name: /Payment pending · MetroGo/ })).toHaveTextContent("MetroGo <receipts@metrogo.example>");
    expect(mail.recent).toHaveBeenCalledTimes(1);
    expect(mail.search).not.toHaveBeenCalled();
    expect(todos.trackMail).not.toHaveBeenCalled();
  });

});

describe("searching", () => {
  it("never shows a late answer for an earlier query", async () => {
    const mail = services();
    let finishFirst!: (value: { items: typeof RECENT }) => void;
    mail.search
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(async () => ({ items: [row("later", "Invoice for the second query", "Studio <s@studio.example>")] }));
    mount(mail);
    await screen.findByRole("button", { name: /Proposal approved/ });
    const input = screen.getByPlaceholderText("Person or topic");
    fireEvent.change(input, { target: { value: "pro" } });
    await waitFor(() => expect(mail.search).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: "inv" } });
    await waitFor(() => expect(mail.search).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: /Invoice for the second query/ })).toBeVisible();
    finishFirst({ items: [row("early", "Answer for the first query", "Old <o@old.example>")] });
    await pause(TRACK_SEARCH_DELAY_MS / 5);
    expect(screen.queryByRole("button", { name: /Answer for the first query/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Invoice for the second query/ })).toBeVisible();
  });
});

describe("confirming", () => {
  async function toReview(mail = services()) {
    const view = mount(mail);
    fireEvent.click(await screen.findByRole("button", { name: /Proposal approved/ }));
    fireEvent.change(screen.getByLabelText("What are you waiting for?"), { target: { value: "The signed proposal" } });
    fireEvent.click(screen.getByRole("button", { name: "Check with Mail AI" }));
    await screen.findByRole("button", { name: "Track in Tasks" });
    return view;
  }

  it("checks the chosen email and creates one Task linked to it only when the owner confirms", async () => {
    const { mail, onClose, onTracked } = await toReview();
    expect(mail.track).toHaveBeenCalledWith(box, sid("priya"), "The signed proposal", expect.anything(), []);
    expect(todos.trackMail).not.toHaveBeenCalled();
    todos.load.mockResolvedValue({ tasks: [{ id: "task-1" }] });
    fireEvent.click(screen.getByRole("button", { name: "Track in Tasks" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(todos.trackMail).toHaveBeenCalledTimes(1);
    expect(todos.trackMail).toHaveBeenCalledWith(session, expect.objectContaining({ source: sid("priya"), connection: box.connection }));
    expect(onTracked).toHaveBeenCalledWith({ tasks: [{ id: "task-1" }] });
  });

  it("refuses a finding that belongs to another mailbox, and saves nothing", async () => {
    const mail = services();
    mail.track.mockResolvedValue(finding({ account: "acct-b" }));
    const view = mount(mail);
    fireEvent.click(await screen.findByRole("button", { name: /Proposal approved/ }));
    fireEvent.change(screen.getByLabelText("What are you waiting for?"), { target: { value: "The signed proposal" } });
    fireEvent.click(screen.getByRole("button", { name: "Check with Mail AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The mailbox changed");
    expect(screen.queryByRole("button", { name: "Track in Tasks" })).toBeNull();
    expect(todos.trackMail).not.toHaveBeenCalled();
    view.unmount();
  });


});

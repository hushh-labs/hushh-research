import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MailConnectedAccount,
  MailOverview,
  type MailOverviewProps,
} from "@/components/gmail/mail-overview";
import {
  MailOverviewError,
  type MailOverviewPage,
  type MailOverviewRow,
} from "@/lib/mail/mail-overview-client";
import { CacheService } from "@/lib/services/cache-service";

const client = vi.hoisted(() => ({
  fetchRecentMail: vi.fn(),
  searchMail: vi.fn(),
  openMailMessage: vi.fn(),
  prepareMailReply: vi.fn(),
}));
vi.mock("@/lib/mail/mail-overview-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/mail-overview-client")>()),
  ...client,
}));

const idFor = (name: string) => `ms1.${name.padEnd(24, "x")}`;

function row(name: string, extra: Partial<MailOverviewRow> = {}): MailOverviewRow {
  return {
    sourceId: idFor(name),
    subject: `Subject ${name}`,
    sender: `Sender ${name}`,
    preview: `Preview ${name}`,
    receivedAt: "2026-11-20T10:00:00+00:00",
    unread: false,
    ...extra,
  };
}

function page(
  kind: "recent" | "search",
  items: MailOverviewRow[],
  options: { more?: boolean; account?: string } = {},
): MailOverviewPage {
  return {
    account: options.account ?? "acct-1",
    scope: {
      kind,
      mailbox: kind === "recent" ? "inbox" : "all_mail",
      label: kind === "recent" ? "Inbox" : "All mail (Spam and Trash excluded)",
    },
    items,
    coverage: {
      requested: items.length,
      returned: items.length,
      moreAvailable: options.more ?? false,
      cap: 25,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const props = (extra: Partial<MailOverviewProps> = {}): MailOverviewProps => ({
  userId: "owner-1",
  accountKey: "acct-1",
  expectedAccount: "acct-1",
  vaultOwnerToken: "HCT:token",
  active: true,
  onCompose: vi.fn(),
  onReply: vi.fn(),
  onReconnect: vi.fn(),
  onRequestVaultUnlock: vi.fn(),
  ...extra,
});

const rows = (...names: string[]) => names.map((name) => row(name));
const listed = () => screen.queryAllByTestId("mail-row");

beforeEach(() => {
  CacheService.getInstance().clear();
  for (const mock of Object.values(client)) mock.mockReset();
});

describe("Mail overview: the connected account", () => {
  it("shows only the envelope for a connected Mail account", () => {
    render(<MailConnectedAccount onReconnect={vi.fn()} onDisconnect={vi.fn()} />);

    expect(
      screen.getByTestId("mail-connected-account-icon").querySelectorAll("svg"),
    ).toHaveLength(1);
  });
});

describe("Mail overview: how fresh the list is", () => {
  it("says when the list was read, and reads newer mail on Refresh without moving it unasked", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page("recent", rows("a", "b")));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(2));

    // Honest age, in this device's clock; nothing implies the list is live.
    expect(screen.getByText(/^Updated \d{1,2}:\d{2}/)).toBeInTheDocument();
    // The list does not refetch or reorder by itself while the tab stays visible.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(client.fetchRecentMail).toHaveBeenCalledTimes(1);

    const next = deferred<MailOverviewPage>();
    client.fetchRecentMail.mockReturnValueOnce(next.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    // Old rows stay put while the new read is in flight, and a second tap cannot stack another.
    const busy = await screen.findByRole("button", { name: "Refreshing…" });
    expect(busy).toBeDisabled();
    expect(listed().map((el) => el.getAttribute("data-source-id"))).toEqual([
      idFor("a"),
      idFor("b"),
    ]);

    await act(async () => {
      next.resolve(page("recent", rows("new", "a")));
    });
    await waitFor(() =>
      expect(listed().map((el) => el.getAttribute("data-source-id"))).toEqual([
        idFor("new"),
        idFor("a"),
      ]),
    );
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(client.fetchRecentMail).toHaveBeenCalledTimes(2);
  });

  it("keeps the same account's rows when a refresh fails, and says so", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page("recent", rows("a", "b")));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(2));

    client.fetchRecentMail.mockRejectedValueOnce(new MailOverviewError("network"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() =>
      expect(screen.getByText(/Couldn't refresh your mail\. Showing what we loaded earlier\./)).toBeInTheDocument(),
    );
    expect(listed()).toHaveLength(2);
  });

  it("offers no Refresh while searching, where Enter runs the search again", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a")));
    client.searchMail.mockResolvedValue(page("search", rows("hit")));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "invoice" } });
    fireEvent.submit(screen.getByRole("searchbox").closest("form")!);
    await waitFor(() => expect(client.searchMail).toHaveBeenCalled());

    await waitFor(() => expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument());
    expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument();
  });
});

describe("Mail overview: recent mail", () => {
  it("shows at most five rows of real fields, with missing fields named missing", async () => {
    client.fetchRecentMail.mockResolvedValue(
      page("recent", [
        row("a", { unread: true }),
        row("b", { subject: null, preview: null, sender: null }),
        ...rows("c", "d", "e"),
      ]),
    );

    render(<MailOverview {...props()} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading your mail…");
    await waitFor(() => expect(listed()).toHaveLength(5));
    expect(client.fetchRecentMail).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, expectedAccount: "acct-1", vaultOwnerToken: "HCT:token" }),
    );
    expect(listed()[0]).toHaveAccessibleName(/Sender a, Subject a, received .*, unread/);
    expect(within(listed()[0]).getByText("Preview a")).toBeInTheDocument();
    // No invented subject, sender or preview.
    expect(within(listed()[1]).getByText("No subject")).toBeInTheDocument();
    expect(within(listed()[1]).getByText("Unknown sender")).toBeInTheDocument();
    expect(within(listed()[1]).queryByText(/Preview/)).not.toBeInTheDocument();
    // The scope is stated, and there is no total.
    expect(screen.getByText(/Inbox · newest first/)).toBeInTheDocument();
    expect(screen.queryByText(/of \d+/)).not.toBeInTheDocument();
  });

  it("reads only while it is the visible tab, and never waits on a receipt scan", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a")));
    const { rerender } = render(<MailOverview {...props({ active: false })} />);

    expect(client.fetchRecentMail).not.toHaveBeenCalled();
    rerender(<MailOverview {...props({ active: true })} />);
    await waitFor(() => expect(listed()).toHaveLength(1));
    expect(client.fetchRecentMail).toHaveBeenCalledTimes(1);
  });

  it("offers View more only when the provider reported more, and states the cap honestly", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page("recent", rows("a", "b", "c", "d", "e"), { more: true }));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(5));

    const more = Array.from({ length: 25 }, (_, i) => row(`m${i}`));
    client.fetchRecentMail.mockResolvedValueOnce(page("recent", more, { more: true }));
    fireEvent.click(screen.getByRole("button", { name: "View more" }));

    await waitFor(() => expect(listed()).toHaveLength(25));
    expect(client.fetchRecentMail).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 25 }));
    expect(screen.queryByRole("button", { name: "View more" })).not.toBeInTheDocument();
    expect(screen.getByText("Showing the newest 25 in your Inbox. Search to find older mail.")).toBeInTheDocument();
  });

  it("offers no dead View more when the Inbox has nothing further", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a", "b")));
    render(<MailOverview {...props()} />);

    await waitFor(() => expect(listed()).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "View more" })).not.toBeInTheDocument();
  });

  it("says the Inbox is empty only when the read succeeded and found nothing", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page("recent", []));
    const { unmount } = render(<MailOverview {...props()} />);
    expect(await screen.findByText("No mail in your Inbox.")).toBeInTheDocument();
    unmount();

    // Negative control: a failed read never reads as an empty Inbox.
    CacheService.getInstance().clear();
    client.fetchRecentMail.mockRejectedValueOnce(new MailOverviewError("network"));
    render(<MailOverview {...props()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load your mail. Try again.");
    expect(screen.queryByText("No mail in your Inbox.")).not.toBeInTheDocument();
    expect(screen.queryByText(/up to date/i)).not.toBeInTheDocument();
  });
});

describe("Mail overview: search", () => {
  it("submits an explicit query to the provider-backed search, not a filter over loaded rows", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a")));
    client.searchMail.mockResolvedValue(page("search", rows("hit1", "hit2"), { more: true }));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(1));

    const field = screen.getByRole("searchbox", { name: "Search mail" });
    fireEvent.change(field, { target: { value: "  invoice from:alice  " } });
    // Typing alone searches nothing.
    expect(client.searchMail).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole("search", { name: "Search mail" }));

    await waitFor(() => expect(listed()).toHaveLength(2));
    expect(client.searchMail).toHaveBeenCalledWith(
      expect.objectContaining({ query: "invoice from:alice", expectedAccount: "acct-1" }),
    );
    expect(screen.getByText(/All mail \(Spam and Trash excluded\)/)).toBeInTheDocument();
    // The cap is stated as it is: no total, and no claim of completeness.
    expect(screen.getByText("Showing the first 2 matches. Refine your search to narrow them.")).toBeInTheDocument();
    // Keep the query editable, and return to Recent mail.
    expect(field).toHaveValue("invoice from:alice");
    fireEvent.click(screen.getByRole("button", { name: /Recent mail/ }));
    expect(screen.getByRole("heading", { name: "Recent mail" })).toBeInTheDocument();
    expect(listed()).toHaveLength(1);
    expect(field).toHaveValue("");
  });

  it("distinguishes no matches from a failed search", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a")));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(1));
    const search = (text: string) => {
      fireEvent.change(screen.getByRole("searchbox", { name: "Search mail" }), { target: { value: text } });
      fireEvent.submit(screen.getByRole("search", { name: "Search mail" }));
    };

    client.searchMail.mockResolvedValueOnce(page("search", []));
    search("nothing");
    expect(await screen.findByText("No matching emails.")).toBeInTheDocument();

    client.searchMail.mockRejectedValueOnce(new MailOverviewError("retryable"));
    search("something");
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load your mail. Try again.");
    // A failed search never shows the last query's rows, or a false "no matches".
    expect(screen.queryByText("No matching emails.")).not.toBeInTheDocument();
    expect(listed()).toHaveLength(0);
  });

  it("refuses an over-long query without calling the provider", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a")));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(1));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search mail" }), { target: { value: "é".repeat(300) } });
    fireEvent.submit(screen.getByRole("search", { name: "Search mail" }));

    expect(screen.getByRole("alert")).toHaveTextContent("That search is too long");
    expect(client.searchMail).not.toHaveBeenCalled();
  });
});

describe("Mail overview: exact opening", () => {
  const opened = (sourceId: string, body: string) => ({
    account: "acct-1",
    message: {
      sourceId,
      subject: "Invoice",
      sender: "Alice",
      receivedAt: "2026-11-20T10:00:00+00:00",
      unread: false,
      body,
      bodyTruncated: false,
    },
  });

  it("opens the message a row names, even when two rows share a subject and the order changes", async () => {
    const first = row("first", { subject: "Invoice" });
    const second = row("second", { subject: "Invoice" });
    client.fetchRecentMail.mockResolvedValueOnce(page("recent", [first, second]));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(2));

    // The same two messages come back in the opposite order, under one subject.
    client.searchMail.mockResolvedValueOnce(page("search", [second, first]));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search mail" }), { target: { value: "invoice" } });
    fireEvent.submit(screen.getByRole("search", { name: "Search mail" }));
    await waitFor(() => expect(listed()[0]).toHaveAttribute("data-source-id", idFor("second")));
    client.openMailMessage.mockResolvedValue(opened(idFor("second"), "Body of the second"));

    // The row in position one is now "second": its click must open "second".
    fireEvent.click(listed()[0]);

    expect(await screen.findByTestId("mail-message-body")).toHaveTextContent("Body of the second");
    expect(client.openMailMessage).toHaveBeenCalledTimes(1);
    expect(client.openMailMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: idFor("second"), expectedAccount: "acct-1" }),
    );
  });

  it("shows the body as text, never markup, and Back returns to the same row", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a", "b")));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(2));
    client.openMailMessage.mockResolvedValue(
      opened(idFor("b"), '<img src=x onerror="alert(1)"> <a href="https://evil.example">click</a>'),
    );

    fireEvent.click(listed()[1]);

    const body = await screen.findByTestId("mail-message-body");
    expect(body.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(body.querySelector("img, a, script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Recent mail/ }));
    await waitFor(() => expect(listed()).toHaveLength(2));
    await waitFor(() => expect(listed()[1]).toHaveFocus());
  });

  it("explains an email that can no longer be opened, and never shows a different one", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a", "b")));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(2));
    client.openMailMessage.mockRejectedValue(new MailOverviewError("source_unavailable"));

    fireEvent.click(listed()[0]);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That email can't be opened. It may have been deleted or moved.",
    );
    expect(screen.queryByTestId("mail-message-body")).not.toBeInTheDocument();
  });

  it("drops an answer that belongs to a different account than the one shown", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a")));
    render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(1));
    client.openMailMessage.mockResolvedValue({ ...opened(idFor("a"), "Another mailbox"), account: "acct-2" });

    fireEvent.click(listed()[0]);

    expect(await screen.findByRole("alert")).toHaveTextContent("Your mail account changed");
    expect(screen.queryByText("Another mailbox")).not.toBeInTheDocument();
  });
});

describe("Mail overview: account isolation and late responses", () => {
  it("never shows a previous account's rows, and ignores that account's late response", async () => {
    const slow = deferred<MailOverviewPage>();
    client.fetchRecentMail.mockReturnValueOnce(slow.promise);
    const { rerender } = render(<MailOverview {...props()} />);

    // The connected account changes while the first read is still in flight.
    client.fetchRecentMail.mockResolvedValueOnce(
      page("recent", rows("new"), { account: "acct-2" }),
    );
    rerender(<MailOverview {...props({ accountKey: "acct-2", expectedAccount: "acct-2" })} />);
    await waitFor(() => expect(listed()).toHaveLength(1));
    expect(screen.getByText("Subject new")).toBeInTheDocument();

    await act(async () => {
      slow.resolve(page("recent", rows("old")));
    });
    expect(screen.queryByText("Subject old")).not.toBeInTheDocument();
    expect(screen.getByText("Subject new")).toBeInTheDocument();
  });

  it("refuses a page the server answered from another account than the one expected", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a"), { account: "someone-else" }));

    render(<MailOverview {...props()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Your mail account changed");
    expect(listed()).toHaveLength(0);
  });

  it("keeps the same account's rows through an ordinary refresh failure, and clears them when access is lost", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page("recent", rows("a", "b", "c", "d", "e"), { more: true }));
    const onReconnect = vi.fn();
    render(<MailOverview {...props({ onReconnect })} />);
    await waitFor(() => expect(listed()).toHaveLength(5));

    // Ordinary failure: what was shown stays, with an honest notice and a retry.
    client.fetchRecentMail.mockRejectedValueOnce(new MailOverviewError("network"));
    fireEvent.click(screen.getByRole("button", { name: "View more" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Couldn't refresh your mail. Showing what we loaded earlier.",
      ),
    );
    expect(listed()).toHaveLength(5);
    expect(screen.queryByText("No mail in your Inbox.")).not.toBeInTheDocument();

    // Lost access: nothing from the old grant stays on screen; the real state is shown.
    client.fetchRecentMail.mockRejectedValueOnce(new MailOverviewError("reconnect_required"));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your mail connection needs attention");
    expect(listed()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });
});

describe("Mail overview: forgetting mail", () => {
  it("does not repaint remembered mail after the vault locks or the connection is lost", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page("recent", rows("a", "b")));
    const { rerender } = render(<MailOverview {...props()} />);
    await waitFor(() => expect(listed()).toHaveLength(2));

    // Locked: nothing from the account stays on screen, and the memory copy is gone.
    rerender(<MailOverview {...props({ vaultOwnerToken: null })} />);
    expect(listed()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();

    // Back again: the first paint shows no old rows, only a read in flight.
    const slow = deferred<MailOverviewPage>();
    client.fetchRecentMail.mockReturnValueOnce(slow.promise);
    rerender(<MailOverview {...props()} />);
    expect(listed()).toHaveLength(0);
    expect(screen.getByText("Loading your mail…")).toBeInTheDocument();
    await act(async () => {
      slow.resolve(page("recent", rows("fresh")));
    });
    expect(await screen.findByText("Subject fresh")).toBeInTheDocument();
    expect(screen.queryByText("Subject a")).not.toBeInTheDocument();
  });

  it("clearMailOverviewMemory forgets one owner's remembered mail and no one else's", async () => {
    const { clearMailOverviewMemory } = await import("@/lib/mail/use-mail-overview");
    const cache = CacheService.getInstance();
    cache.set("mail_overview_owner-1_acct-1_0", { page: "x" }, 60_000);
    cache.set("mail_overview_owner-2_acct-1_0", { page: "y" }, 60_000);

    clearMailOverviewMemory("owner-1");

    expect(cache.peek("mail_overview_owner-1_acct-1_0")).toBeNull();
    expect(cache.peek("mail_overview_owner-2_acct-1_0")).not.toBeNull();
  });
});

describe("Mail overview: compose and reply", () => {
  it("Compose is one action that enters the drafting flow, and Reply prepares the exact message's reference", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a")));
    const onCompose = vi.fn();
    const onReply = vi.fn();
    render(<MailOverview {...props({ onCompose, onReply })} />);
    await waitFor(() => expect(listed()).toHaveLength(1));

    expect(screen.getAllByRole("button", { name: "Compose" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Compose" }));
    expect(onCompose).toHaveBeenCalledOnce();
    expect(client.prepareMailReply).not.toHaveBeenCalled();

    client.openMailMessage.mockResolvedValue({
      account: "acct-1",
      message: {
        sourceId: idFor("a"),
        subject: "Invoice",
        sender: "Alice",
        receivedAt: null,
        unread: false,
        body: "Hello",
        bodyTruncated: false,
      },
    });
    fireEvent.click(listed()[0]);
    await screen.findByTestId("mail-message-body");
    expect(onReply).not.toHaveBeenCalled(); // opening never starts a reply

    const reference = {
      sourceMailRef: `rs1.${"x".repeat(40)}`,
      to: "alice@example.com",
      recipientLabel: "Alice",
      subject: "Re: Invoice",
      expiresInSeconds: 900,
    };
    client.prepareMailReply.mockResolvedValue({ account: "acct-1", reply: reference });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    // The handoff gets the reference and the stable id of the very message on
    // screen, so the reference can be renewed from the same original later.
    await waitFor(() => expect(onReply).toHaveBeenCalledWith(reference, idFor("a")));
    expect(client.prepareMailReply).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: idFor("a"), expectedAccount: "acct-1" }),
    );
  });

  it("explains why an email cannot be replied to, in the server's words, and starts nothing", async () => {
    client.fetchRecentMail.mockResolvedValue(page("recent", rows("a")));
    const onReply = vi.fn();
    render(<MailOverview {...props({ onReply })} />);
    await waitFor(() => expect(listed()).toHaveLength(1));
    client.openMailMessage.mockResolvedValue({
      account: "acct-1",
      message: { sourceId: idFor("a"), subject: "Mine", sender: "Me", receivedAt: null, unread: false, body: "x", bodyTruncated: false },
    });
    fireEvent.click(listed()[0]);
    await screen.findByTestId("mail-message-body");
    client.prepareMailReply.mockRejectedValue(
      new MailOverviewError("reply_not_possible", { serverMessage: "That email is from you, so its reply would come back to you." }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(await screen.findByText("That email is from you, so its reply would come back to you.")).toBeInTheDocument();
    expect(onReply).not.toHaveBeenCalled();
  });
});

describe("Mail overview: connection and vault states", () => {
  it("shows the real state when mail is not readable, with the matching single action", async () => {
    client.fetchRecentMail.mockRejectedValue(new MailOverviewError("reconnect_required"));
    const onReconnect = vi.fn();
    render(<MailOverview {...props({ onReconnect })} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your mail connection needs attention. Reconnect to continue.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(listed()).toHaveLength(0);
  });

  it("asks for the vault instead of reading when there is no owner token", () => {
    const onRequestVaultUnlock = vi.fn();
    render(<MailOverview {...props({ vaultOwnerToken: null, onRequestVaultUnlock })} />);

    expect(client.fetchRecentMail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(onRequestVaultUnlock).toHaveBeenCalledOnce();
  });
});

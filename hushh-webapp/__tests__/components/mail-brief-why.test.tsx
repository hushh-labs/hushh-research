/**
 * "Why this?" opens the exact message the card rests on, read fresh from the
 * connected mailbox for that account, with the quoted words marked in it.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MailWhySheet, type WhyTarget } from "@/components/gmail/mail-brief-why";
import { MailOverviewError } from "@/lib/mail/mail-overview-client";

const client = vi.hoisted(() => ({ openMailMessage: vi.fn() }));
vi.mock("@/lib/mail/mail-overview-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/mail-overview-client")>()),
  ...client,
}));

const sid = (name: string) => `ms1.${name.padEnd(24, "x")}`;
const QUOTE = "I will send the final brand assets by 21 Nov";

const target = (over: Partial<WhyTarget> = {}): WhyTarget => ({
  title: "Get the final brand assets",
  reason: "Maya said she would send them by 21 Nov and nothing has arrived.",
  evidence: [
    { sourceId: sid("promise"), from: "Maya Rao", on: "2026-11-19", direction: "received", quote: QUOTE },
    { sourceId: sid("mine"), from: "You", on: "2026-11-18", direction: "sent", quote: "Could you send the brand assets" },
  ],
  ...over,
});

const opened = (over: Record<string, unknown> = {}) => ({
  account: "acct-1",
  message: {
    sourceId: sid("promise"),
    subject: "Brand assets",
    sender: "Maya Rao",
    receivedAt: "2026-11-19T10:00:00+00:00",
    unread: false,
    body: `Hi,\n\nThanks for the call. ${QUOTE}.\n\nMaya`,
    bodyTruncated: false,
    ...over,
  },
});

function mount(t: WhyTarget | null = target(), extra: Partial<Parameters<typeof MailWhySheet>[0]> = {}) {
  const handlers = { onClose: vi.fn(), onReconnect: vi.fn(), onUnlock: vi.fn() };
  const view = render(
    <MailWhySheet target={t} vaultOwnerToken="HCT:token" expectedAccount="acct-1" {...handlers} {...extra} />,
  );
  return { ...view, ...handlers };
}

beforeEach(() => client.openMailMessage.mockReset());
afterEach(cleanup);

describe("the evidence", () => {
  it("lists the reason and each message behind the card, in the owner's own words", () => {
    mount();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Maya said she would send them/)).toBeVisible();
    expect(within(dialog).getByText(`“${QUOTE}”`)).toBeVisible();
    expect(within(dialog).getByText("Maya Rao · 19 Nov 2026")).toBeVisible();
    // The owner's own message is labelled as theirs, not as a counterpart's.
    expect(within(dialog).getByText("You wrote · 18 Nov 2026")).toBeVisible();
    expect(client.openMailMessage).not.toHaveBeenCalled();
  });

  it("reads nothing until a message is asked for", () => {
    mount(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.openMailMessage).not.toHaveBeenCalled();
  });
});

describe("View email", () => {
  it("reads the exact message for this account and marks the quoted words in it", async () => {
    client.openMailMessage.mockResolvedValue(opened());
    mount();

    fireEvent.click(screen.getAllByRole("button", { name: "View email" })[0]!);

    const body = await screen.findByTestId("brief-message-body");
    expect(client.openMailMessage).toHaveBeenCalledWith(
      expect.objectContaining({ vaultOwnerToken: "HCT:token", expectedAccount: "acct-1", sourceId: sid("promise") }),
    );
    expect(within(body).getByTestId("brief-quote-mark")).toHaveTextContent(QUOTE);
    // Plain text, never markup: the page does not render the message as HTML.
    expect(body.querySelector("a, img, script, style")).toBeNull();
  });

  it("marks the quote even when the message wraps its words differently", async () => {
    client.openMailMessage.mockResolvedValue(opened({ body: "I will send the\nfinal brand  assets by 21 Nov, promise." }));
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: "View email" })[0]!);
    expect(await screen.findByTestId("brief-quote-mark")).toHaveTextContent(/I will send the\s+final brand\s+assets by 21 Nov/);
  });

  it("goes back to the list without losing it", async () => {
    client.openMailMessage.mockResolvedValue(opened());
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: "View email" })[0]!);
    await screen.findByTestId("brief-message-body");

    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getAllByRole("button", { name: "View email" })).toHaveLength(2);
  });

  it("opens a confirmed sent email directly, with no list and no quote to mark", async () => {
    client.openMailMessage.mockResolvedValue(opened({ sourceId: sid("sentmail"), body: "Attached is the pricing sheet." }));
    mount(
      target({
        title: "Pricing sheet sent to Priya",
        reason: undefined,
        openFirst: true,
        evidence: [{ sourceId: sid("sentmail"), from: "You", on: "2026-11-22", direction: "sent", quote: "" }],
      }),
    );

    expect(await screen.findByTestId("brief-message-body")).toHaveTextContent("Attached is the pricing sheet.");
    expect(client.openMailMessage).toHaveBeenCalledWith(expect.objectContaining({ sourceId: sid("sentmail") }));
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
    expect(screen.queryByTestId("brief-quote-mark")).toBeNull();
  });
});

describe("when the message cannot be shown", () => {
  it("says it can't be opened, and retries on request", async () => {
    client.openMailMessage.mockRejectedValueOnce(new MailOverviewError("source_unavailable"));
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: "View email" })[0]!);

    expect(await screen.findByRole("alert")).toHaveTextContent("can't be opened");
    expect(screen.queryByTestId("brief-message-body")).toBeNull();
  });

  it("retries a temporary failure", async () => {
    client.openMailMessage.mockRejectedValueOnce(new MailOverviewError("retryable")).mockResolvedValueOnce(opened());
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: "View email" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("brief-message-body")).toBeVisible();
    expect(client.openMailMessage).toHaveBeenCalledTimes(2);
  });

  it("asks to reconnect, or to unlock, when that is the reason", async () => {
    client.openMailMessage.mockRejectedValueOnce(new MailOverviewError("reconnect_required"));
    const first = mount();
    fireEvent.click(screen.getAllByRole("button", { name: "View email" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(first.onReconnect).toHaveBeenCalled();
    first.unmount();

    const second = mount(target(), { vaultOwnerToken: null });
    fireEvent.click(screen.getAllByRole("button", { name: "View email" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock" }));
    expect(second.onUnlock).toHaveBeenCalled();
    expect(client.openMailMessage).toHaveBeenCalledTimes(1); // never asked without a vault token
  });

  it("never shows a message from another account", async () => {
    client.openMailMessage.mockRejectedValueOnce(new MailOverviewError("account_changed"));
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: "View email" })[0]!);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/account changed/i));
    expect(screen.queryByTestId("brief-message-body")).toBeNull();
  });
});

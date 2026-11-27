/**
 * The Mail Overview client: what it refuses to send, and what it refuses to believe.
 *
 * A row is named by an opaque source id, never a position or a Gmail id. And a
 * 200 whose body does not describe mail must fail rather than render as an empty
 * inbox, because that tells the person their mail is empty when the read failed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetch: (...args: unknown[]) => apiFetch(...args),
    getAuthHeaders: (token?: string) => (token ? { Authorization: `Bearer ${token}` } : {}),
  },
}));

import {
  fetchRecentMail,
  mailOverviewReason,
  MailOverviewError,
  openMailMessage,
  prepareMailReply,
  searchMail,
} from "@/lib/mail/mail-overview-client";

const TOKEN = "HCT:token";
const ID_A = `ms1.${"A".repeat(43)}`;
const ID_B = `ms1.${"B".repeat(43)}`;

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function page(kind: "recent" | "search", items: unknown[] = [], more = false) {
  return {
    account: "acct-1",
    scope: { kind, mailbox: kind === "recent" ? "inbox" : "all_mail", label: "Inbox" },
    items,
    coverage: { requested: 5, returned: items.length, more_available: more, cap: 25 },
  };
}

const row = (sourceId: string, extra: Record<string, unknown> = {}) => ({
  source_id: sourceId,
  subject: "Plan",
  sender: "Alice",
  preview: "Let's meet",
  received_at: "2026-11-20T10:00:00+00:00",
  unread: true,
  ...extra,
});

afterEach(() => apiFetch.mockReset());

describe("Mail Overview client: what it sends", () => {
  it("sends the vault token, the bounded limit and the expected account, nothing else", async () => {
    apiFetch.mockReturnValue(json(page("recent", [row(ID_A)])));

    await fetchRecentMail({ vaultOwnerToken: TOKEN, expectedAccount: "acct-1", limit: 99 });

    const [path, options] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/one/mail/overview/recent");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // The limit is clamped to the reader's cap; nothing names a message or a position.
    expect(JSON.parse(options.body)).toEqual({ limit: 25, expected_account: "acct-1" });
  });

  it("refuses an empty, oversized or unauthenticated request before it reaches the network", async () => {
    await expect(searchMail({ vaultOwnerToken: TOKEN, query: "   " })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    await expect(
      searchMail({ vaultOwnerToken: TOKEN, query: "é".repeat(300) }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    await expect(fetchRecentMail({ vaultOwnerToken: "  " })).rejects.toMatchObject({
      reason: "auth_missing",
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("sends a search as an explicit query, trimmed, to the search route", async () => {
    apiFetch.mockReturnValue(json(page("search", [row(ID_A)])));

    const result = await searchMail({ vaultOwnerToken: TOKEN, query: "  from:alice  " });

    expect(apiFetch.mock.calls[0][0]).toBe("/api/one/mail/overview/search");
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ query: "from:alice" });
    expect(result.items).toHaveLength(1);
  });
});

describe("Mail Overview client: what it believes", () => {
  it("reports an absent subject, sender or preview as missing, never as invented text", async () => {
    apiFetch.mockReturnValue(
      json(page("recent", [row(ID_A, { subject: null, sender: null, preview: "  " })])),
    );

    const result = await fetchRecentMail({ vaultOwnerToken: TOKEN });

    expect(result.items[0]).toMatchObject({ subject: null, sender: null, preview: null });
  });

  it("fails a 200 that does not describe mail instead of showing an empty inbox", async () => {
    const malformed = [
      {},
      { ...page("recent"), account: "" },
      { ...page("recent"), items: "none" },
      page("search"), // the wrong kind of answer for a Recent request
      page("recent", [row("message-1")]), // a Gmail-looking id is not a source id
      page("recent", [row(ID_A, { unread: "yes" })]),
      page("recent", [{ ...row(ID_A), source_id: undefined }]),
    ];
    for (const body of malformed) {
      apiFetch.mockReturnValueOnce(json(body));
      await expect(fetchRecentMail({ vaultOwnerToken: TOKEN })).rejects.toMatchObject({
        reason: "unknown",
        code: "MALFORMED_RESPONSE",
      });
    }
    // Negative control: a real, genuinely empty page is accepted as empty.
    apiFetch.mockReturnValueOnce(json(page("recent", [])));
    await expect(fetchRecentMail({ vaultOwnerToken: TOKEN })).resolves.toMatchObject({
      items: [],
    });
  });

  it("never shows one message twice, and reports the coverage the provider gave", async () => {
    apiFetch.mockReturnValue(json(page("recent", [row(ID_A), row(ID_A), row(ID_B)], true)));

    const result = await fetchRecentMail({ vaultOwnerToken: TOKEN });

    expect(result.items.map((item) => item.sourceId)).toEqual([ID_A, ID_B]);
    expect(result.coverage).toEqual({ requested: 5, returned: 2, moreAvailable: true, cap: 25 });
  });

  it("opens only the message it asked for", async () => {
    const opened = (sourceId: string) => ({
      account: "acct-1",
      message: {
        source_id: sourceId,
        subject: "Plan",
        sender: null,
        received_at: null,
        unread: false,
        body: "Hello",
        body_truncated: false,
      },
    });
    apiFetch.mockReturnValueOnce(json(opened(ID_A)));
    await expect(
      openMailMessage({ vaultOwnerToken: TOKEN, sourceId: ID_A }),
    ).resolves.toMatchObject({ message: { sourceId: ID_A, sender: null, body: "Hello" } });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ source_id: ID_A });

    // An answer for a different message is a failure, not a swap.
    apiFetch.mockReturnValueOnce(json(opened(ID_B)));
    await expect(
      openMailMessage({ vaultOwnerToken: TOKEN, sourceId: ID_A }),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });

  it("accepts only a reply reference the reviewed reply flow can use", async () => {
    const reply = (ref: string) => ({
      account: "acct-1",
      reply: {
        source_mail_ref: ref,
        to: "alice@example.com",
        recipient_label: "Alice",
        subject: "Re: Plan",
        expires_in_seconds: 900,
      },
    });
    apiFetch.mockReturnValueOnce(json(reply(`rs1.${"x".repeat(40)}`)));
    await expect(prepareMailReply({ vaultOwnerToken: TOKEN, sourceId: ID_A })).resolves.toMatchObject({
      reply: { to: "alice@example.com", subject: "Re: Plan" },
    });
    apiFetch.mockReturnValueOnce(json(reply(ID_A))); // a source id is not a reply reference
    await expect(prepareMailReply({ vaultOwnerToken: TOKEN, sourceId: ID_A })).rejects.toBeInstanceOf(
      MailOverviewError,
    );
  });
});

describe("Mail Overview client: failures", () => {
  it.each([
    ["CONNECT_REQUIRED", 409, "connect_required"],
    ["RECONNECT_REQUIRED", 409, "reconnect_required"],
    ["PERMISSION_DENIED", 403, "reconnect_required"],
    ["ACCOUNT_CHANGED", 409, "account_changed"],
    ["SOURCE_CHANGED", 410, "source_unavailable"],
    ["SOURCE_REF_INVALID", 422, "source_invalid"],
    ["MAIL_READS_UNAVAILABLE", 403, "unavailable"],
    ["AGENT_PRIVATE_RUNTIME_REQUIRED", 409, "private_runtime"],
    ["MAIL_REPLY_UNAVAILABLE", 403, "reply_unavailable"],
    ["REPLY_TARGET_IS_OWNER", 422, "reply_not_possible"],
    ["RETRYABLE", 503, "retryable"],
  ])("%s becomes %s, so each state reads differently", async (code, status, reason) => {
    expect(mailOverviewReason(status, code)).toBe(reason);
    apiFetch.mockReturnValue(json({ detail: { code, message: "Authored." } }, status));
    await expect(fetchRecentMail({ vaultOwnerToken: TOKEN })).rejects.toMatchObject({
      reason,
      serverMessage: "Authored.",
    });
  });

  it("tells a cancelled request from a failed one, and a network error from both", async () => {
    const controller = new AbortController();
    controller.abort();
    apiFetch.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "AbortError" }));
    await expect(
      fetchRecentMail({ vaultOwnerToken: TOKEN, signal: controller.signal }),
    ).rejects.toMatchObject({ reason: "aborted" });
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    await expect(fetchRecentMail({ vaultOwnerToken: TOKEN })).rejects.toMatchObject({
      reason: "network",
    });
    apiFetch.mockReturnValueOnce(Promise.resolve(new Response("<html>", { status: 502 })));
    await expect(fetchRecentMail({ vaultOwnerToken: TOKEN })).rejects.toMatchObject({
      reason: "retryable",
    });
  });
});

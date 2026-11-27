/**
 * "Updated" is the time of the last mail read that succeeded for this account,
 * and nothing else. A failed, superseded or wrong-account read, a search, and a
 * repaint from cache never move it, so it can never claim fresher mail than the
 * rows on screen.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MailOverviewError,
  type MailOverviewPage,
  type MailOverviewRow,
} from "@/lib/mail/mail-overview-client";
import { useMailOverview } from "@/lib/mail/use-mail-overview";
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
const row = (name: string): MailOverviewRow => ({
  sourceId: idFor(name),
  subject: `Subject ${name}`,
  sender: `Sender ${name}`,
  preview: null,
  receivedAt: "2026-11-20T10:00:00+00:00",
  unread: false,
});
const page = (names: string[], account = "acct-1", kind: "recent" | "search" = "recent"): MailOverviewPage => ({
  account,
  scope: { kind, mailbox: kind === "recent" ? "inbox" : "all_mail", label: "Inbox" },
  items: names.map(row),
  coverage: { requested: 5, returned: names.length, moreAvailable: true, cap: 25 },
});

const T0 = Date.UTC(2026, 10, 23, 15, 0, 0);
const MINUTE = 60_000;

function mount() {
  return renderHook(() =>
    useMailOverview({
      userId: "owner-1",
      accountKey: "acct-1",
      expectedAccount: "acct-1",
      vaultOwnerToken: "HCT:token",
      connected: true,
      active: true,
    }),
  );
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  CacheService.getInstance().clear();
  vi.useFakeTimers({ now: T0 });
  for (const mock of Object.values(client)) mock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Updated moves only after a successful read", () => {
  it("is unset until the first read succeeds", async () => {
    client.fetchRecentMail.mockRejectedValue(new MailOverviewError("network"));
    const { result } = mount();
    await settle();

    expect(result.current.recent.error).not.toBeNull();
    expect(result.current.recent.fetchedAt).toBe(0);
  });

  it("takes the time of the read that succeeded", async () => {
    client.fetchRecentMail.mockResolvedValue(page(["a"]));
    const { result } = mount();
    await settle();

    expect(result.current.recent.fetchedAt).toBe(T0);
  });

  it("does not move when a refresh fails, and the rows it still shows keep their own time", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page(["a", "b"]));
    const { result } = mount();
    await settle();
    expect(result.current.recent.fetchedAt).toBe(T0);

    vi.setSystemTime(T0 + 5 * MINUTE);
    client.fetchRecentMail.mockRejectedValueOnce(new MailOverviewError("network"));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.recent.error).not.toBeNull();
    expect(result.current.recent.page?.items).toHaveLength(2);
    expect(result.current.recent.fetchedAt).toBe(T0);
  });

  it("moves to the later read once a refresh succeeds, and to nothing in between", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page(["a"]));
    const { result } = mount();
    await settle();

    vi.setSystemTime(T0 + 6 * MINUTE);
    client.fetchRecentMail.mockResolvedValueOnce(page(["new", "a"]));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.recent.fetchedAt).toBe(T0 + 6 * MINUTE);
    expect(result.current.recent.page?.items[0].sourceId).toBe(idFor("new"));
    expect(result.current.recent.error).toBeNull();
  });

  it("does not move while a refresh is still in flight", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page(["a"]));
    const { result } = mount();
    await settle();

    vi.setSystemTime(T0 + 7 * MINUTE);
    let release!: (value: MailOverviewPage) => void;
    client.fetchRecentMail.mockReturnValueOnce(new Promise<MailOverviewPage>((r) => (release = r)));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refresh();
    });

    expect(result.current.recent.refreshing).toBe(true);
    expect(result.current.recent.fetchedAt).toBe(T0);
    await act(async () => {
      release(page(["a"]));
      await pending;
    });
    expect(result.current.recent.fetchedAt).toBe(T0 + 7 * MINUTE);
  });

  it("does not move for a read answered by a different account", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page(["a"]));
    const { result } = mount();
    await settle();

    vi.setSystemTime(T0 + 8 * MINUTE);
    client.fetchRecentMail.mockResolvedValueOnce(page(["intruder"], "acct-OTHER"));
    await act(async () => {
      await result.current.refresh();
    });

    // Another account's answer is dropped, and the rows it would have replaced
    // are withdrawn rather than shown under a time that no longer describes them.
    expect(result.current.recent.error?.reason).toBe("account_changed");
    expect(result.current.recent.page).toBeNull();
    expect(result.current.recent.fetchedAt).toBe(T0);
  });

  it("does not move for a search, whose results are a different list", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page(["a"]));
    const { result } = mount();
    await settle();

    vi.setSystemTime(T0 + 9 * MINUTE);
    client.searchMail.mockResolvedValueOnce(page(["hit"], "acct-1", "search"));
    await act(async () => {
      await result.current.submitSearch("invoice");
    });

    expect(result.current.search?.page?.items).toHaveLength(1);
    expect(result.current.recent.fetchedAt).toBe(T0);
  });

  it("moves for a View more that succeeds and not for one that fails", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page(["a"]));
    const { result } = mount();
    await settle();

    vi.setSystemTime(T0 + 10 * MINUTE);
    client.fetchRecentMail.mockRejectedValueOnce(new MailOverviewError("retryable"));
    await act(async () => {
      await result.current.viewMore();
    });
    expect(result.current.recent.fetchedAt).toBe(T0);

    vi.setSystemTime(T0 + 11 * MINUTE);
    client.fetchRecentMail.mockResolvedValueOnce(page(["a", "b", "c"]));
    await act(async () => {
      await result.current.viewMore();
    });
    expect(result.current.recent.fetchedAt).toBe(T0 + 11 * MINUTE);
  });

  it("repaints from cache with the time that read actually finished, not the time of the repaint", async () => {
    client.fetchRecentMail.mockResolvedValueOnce(page(["a"]));
    const first = mount();
    await settle();
    expect(first.result.current.recent.fetchedAt).toBe(T0);
    first.unmount();

    // Back on the Overview three minutes later, the cached rows paint at once.
    vi.setSystemTime(T0 + 3 * MINUTE);
    let release!: (value: MailOverviewPage) => void;
    client.fetchRecentMail.mockReturnValueOnce(new Promise<MailOverviewPage>((r) => (release = r)));
    const second = mount();

    expect(second.result.current.recent.page).not.toBeNull();
    expect(second.result.current.recent.refreshing).toBe(true);
    expect(second.result.current.recent.fetchedAt).toBe(T0);

    // And only the revalidation that succeeds moves it.
    await act(async () => {
      release(page(["a"]));
    });
    await settle();
    expect(second.result.current.recent.fetchedAt).toBe(T0 + 3 * MINUTE);
  });
});

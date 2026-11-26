/**
 * What the brief hook promises: it reads only for a connected, showing mailbox;
 * another account's answer is never shown; a failed read never claims fresher
 * mail than what is on screen; and the brief and the confirmed sends fail apart.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MailBrief, MailCompleted } from "@/lib/mail/mail-brief-client";
import { MailOverviewError } from "@/lib/mail/mail-overview-client";
import { useMailBrief } from "@/lib/mail/use-mail-brief";
import { CacheService } from "@/lib/services/cache-service";

const client = vi.hoisted(() => ({ fetchMailBrief: vi.fn(), fetchMailCompleted: vi.fn() }));
vi.mock("@/lib/mail/mail-brief-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/mail-brief-client")>()),
  ...client,
}));

const T0 = Date.UTC(2026, 10, 26, 9, 0, 0);
const MINUTE = 60_000;

const briefOf = (account = "acct-1", titles: string[] = ["Get the signed document"]): MailBrief => ({
  account,
  generatedAt: new Date(T0).toISOString(),
  coverage: { messages: 9, windowDays: 21, mayBePartial: false },
  attention: titles.map((title, index) => ({
    id: `att_${index}`,
    kind: "follow_up" as const,
    title,
    reason: "They promised it.",
    context: null,
    person: "Maya Rao",
    due: null,
    term: null,
    action: { kind: "draft_followup" as const, sourceId: `ms1.${"a".repeat(24)}`, draft: null },
    evidence: [
      {
        sourceId: `ms1.${"a".repeat(24)}`,
        from: "Maya Rao",
        on: "2026-11-19",
        direction: "received" as const,
        quote: "I will send the final brand assets",
      },
    ],
  })),
  updates: [],
});
const completedOf = (account = "acct-1"): MailCompleted => ({ account, items: [] });

type Props = { accountKey?: string; expectedAccount?: string | null; active?: boolean; connected?: boolean; token?: string | null };
function mount(props: Props = {}) {
  return renderHook(
    (p: Props) =>
      useMailBrief({
        userId: "owner-1",
        accountKey: p.accountKey ?? "acct-1",
        expectedAccount: p.expectedAccount === undefined ? "acct-1" : p.expectedAccount,
        vaultOwnerToken: p.token === undefined ? "HCT:token" : p.token,
        connected: p.connected ?? true,
        active: p.active ?? true,
      }),
    { initialProps: props },
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
  client.fetchMailBrief.mockReset().mockResolvedValue(briefOf());
  client.fetchMailCompleted.mockReset().mockResolvedValue(completedOf());
});
afterEach(() => vi.useRealTimers());

describe("when it reads", () => {
  it("reads both parts once for a connected mailbox that is showing", async () => {
    const { result } = mount();
    expect(result.current.brief.status).toBe("loading");
    await settle();

    expect(client.fetchMailBrief).toHaveBeenCalledTimes(1);
    expect(client.fetchMailCompleted).toHaveBeenCalledTimes(1);
    expect(result.current.brief).toMatchObject({ status: "ready", fetchedAt: T0 });
    expect(result.current.brief.data?.attention.map((item) => item.title)).toEqual(["Get the signed document"]);
    expect(client.fetchMailBrief.mock.calls[0]?.[0]).toMatchObject({ vaultOwnerToken: "HCT:token", expectedAccount: "acct-1" });
  });

  it("reads nothing while hidden, disconnected or without a vault token", async () => {
    for (const props of [{ active: false }, { connected: false }, { token: null }] as Props[]) {
      mount(props);
      await settle();
    }
    expect(client.fetchMailBrief).not.toHaveBeenCalled();
    expect(client.fetchMailCompleted).not.toHaveBeenCalled();
  });

  it("repaints from memory and revalidates only after a minute", async () => {
    const first = mount();
    await settle();
    first.unmount();
    client.fetchMailBrief.mockClear();
    client.fetchMailCompleted.mockClear();

    vi.setSystemTime(T0 + 30_000);
    const quick = mount();
    expect(quick.result.current.brief.data?.attention).toHaveLength(1); // at once, no spinner
    await settle();
    expect(client.fetchMailBrief).not.toHaveBeenCalled();
    quick.unmount();

    vi.setSystemTime(T0 + 2 * MINUTE);
    const later = mount();
    await settle();
    expect(client.fetchMailBrief).toHaveBeenCalledTimes(1);
    expect(later.result.current.brief.fetchedAt).toBe(T0 + 2 * MINUTE);
  });
});

describe("honest failure", () => {
  it("keeps the brief and the confirmed sends apart: one failing is never the other failing", async () => {
    client.fetchMailBrief.mockRejectedValue(new MailOverviewError("brief_unavailable"));
    const { result } = mount();
    await settle();

    expect(result.current.brief).toMatchObject({ status: "error", data: null });
    expect(result.current.brief.error?.reason).toBe("brief_unavailable");
    expect(result.current.completed).toMatchObject({ status: "ready" });
  });

  it("keeps what is on screen when a refresh fails, and does not move the time it claims", async () => {
    const { result } = mount();
    await settle();
    expect(result.current.brief.fetchedAt).toBe(T0);

    vi.setSystemTime(T0 + 5 * MINUTE);
    client.fetchMailBrief.mockRejectedValue(new MailOverviewError("brief_unavailable"));
    act(() => result.current.refresh());
    await settle();

    expect(result.current.brief.error?.reason).toBe("brief_unavailable");
    expect(result.current.brief.data?.attention).toHaveLength(1);
    expect(result.current.brief.fetchedAt).toBe(T0);
    // The part that succeeded did move.
    expect(result.current.completed.fetchedAt).toBe(T0 + 5 * MINUTE);
    const returning = mount({ active: false });
    expect(returning.result.current.brief.fetchedAt).toBe(T0);
    expect(returning.result.current.completed.fetchedAt).toBe(T0 + 5 * MINUTE);
  });

  it("moves the time only when a refresh succeeds, and shows the newer items", async () => {
    const { result } = mount();
    await settle();

    vi.setSystemTime(T0 + 6 * MINUTE);
    client.fetchMailBrief.mockResolvedValue(briefOf("acct-1", ["Choose the payment term", "Get the signed document"]));
    act(() => result.current.refresh());
    await settle();

    expect(result.current.brief.fetchedAt).toBe(T0 + 6 * MINUTE);
    expect(result.current.brief.data?.attention).toHaveLength(2);
    expect(result.current.brief.error).toBeNull();
  });

  it("drops the old items when access is lost, rather than leaving mail it can no longer read", async () => {
    const { result } = mount();
    await settle();

    client.fetchMailBrief.mockRejectedValue(new MailOverviewError("reconnect_required"));
    act(() => result.current.refresh());
    await settle();

    expect(result.current.brief).toMatchObject({ status: "error", data: null, fetchedAt: 0 });
    expect(result.current.completed.data).toBeNull();
    const returning = mount({ active: false });
    expect(returning.result.current.brief.data).toBeNull();
    expect(returning.result.current.completed.data).toBeNull();
  });
});

describe("one mailbox at a time", () => {
  it("never shows an answer from a different Google account", async () => {
    client.fetchMailBrief.mockResolvedValue(briefOf("someone-else"));
    client.fetchMailCompleted.mockResolvedValue(completedOf("someone-else"));
    const { result } = mount();
    await settle();

    expect(result.current.brief).toMatchObject({ status: "error", data: null });
    expect(result.current.brief.error?.reason).toBe("account_changed");
    expect(result.current.completed.data).toBeNull();
    expect(result.current.brief.fetchedAt).toBe(0);
  });

  it("restores B before its refresh and rejects the late B response after selecting C", async () => {
    const select = (id: string) => ({ accountKey: id, expectedAccount: id });
    const serve = (id: string) => {
      client.fetchMailBrief.mockResolvedValue(briefOf(id, [id]));
      client.fetchMailCompleted.mockResolvedValue(completedOf(id));
    };
    serve("A");
    const screen = mount(select("A"));
    await settle();
    serve("B");
    screen.rerender(select("B"));
    await settle();
    serve("A");
    screen.rerender(select("A"));
    await settle();
    vi.setSystemTime(T0 + 2 * MINUTE);
    let finish!: (value: MailBrief) => void;
    client.fetchMailBrief.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    client.fetchMailCompleted.mockResolvedValue(completedOf("B"));
    screen.rerender(select("B"));
    expect(screen.result.current.brief.data?.attention[0]?.title).toBe("B");
    expect(screen.result.current.brief.refreshing).toBe(true);
    serve("C");
    screen.rerender(select("C"));
    expect(screen.result.current.brief.data).toBeNull();
    await settle();
    await act(async () => finish(briefOf("B", ["late B"])));
    expect(screen.result.current.brief.data?.attention[0]?.title).toBe("C");
  });

  it("starts clean for another mailbox and ignores a read still running for the last one", async () => {
    let release!: (value: MailBrief) => void;
    client.fetchMailBrief.mockReturnValueOnce(new Promise<MailBrief>((resolve) => (release = resolve)));
    const { result, rerender } = mount();
    await settle();

    client.fetchMailBrief.mockResolvedValue(briefOf("acct-2", ["Reply to Morgan"]));
    client.fetchMailCompleted.mockResolvedValue(completedOf("acct-2"));
    rerender({ accountKey: "acct-2", expectedAccount: "acct-2" });
    await settle();
    expect(result.current.brief.data?.attention.map((item) => item.title)).toEqual(["Reply to Morgan"]);

    // The first mailbox's late answer cannot land on the second.
    await act(async () => release(briefOf("acct-1", ["Stale item from the first mailbox"])));
    await settle();
    expect(result.current.brief.data?.attention.map((item) => item.title)).toEqual(["Reply to Morgan"]);
  });
});

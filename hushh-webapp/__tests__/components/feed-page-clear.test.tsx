import { feedPageTestMocks } from "./fixtures/feed-page-setup";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { FeedActionable } from "@/lib/feed/use-feed-actionables";
import { FEED_SEARCH_OPEN_EVENT } from "@/lib/feed/feed-search-events";
import { bumpFeedPresentationRevision } from "@/lib/cache/feed-invalidation-epoch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedPage } from "@/components/feed/feed-page";
const mocks = feedPageTestMocks();
import { CacheService } from "@/lib/services/cache-service";

beforeEach(() => {
  CacheService.getInstance().clear();
  mocks.resourceMissing = false;
  mocks.historyLoading = false;
  mocks.historyError = null;
  mocks.actionablesLoading = false;
  mocks.actionablesError = null;
  mocks.progressLoading = false;
  mocks.progressError = null;
});

it("publishes a received request outcome while reading older Feed history", async () => {
  const original = mocks.data;
  const renderPage = () => <div data-app-scroll-root="true"><FeedPage /></div>;
  const view = render(renderPage());
  try {
    const originalRow = await screen.findByText("row-5");
    const root = view.container.querySelector<HTMLElement>("[data-app-scroll-root]")!;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 500));
    vi.spyOn(originalRow, "getBoundingClientRect").mockImplementation(() =>
      new DOMRect(0, screen.queryByText("row-6") ? 152 : 100, 320, 52));
    mocks.readStarted.mockClear();
    root.scrollTop = 150;
    fireEvent.scroll(root);
    mocks.data = {
      ...original,
      items: [
        { ...original.items[0], id: "7", source_domain: "kai", event_type: "kai_analysis_completed" },
        { ...original.items[0], id: "6", source_domain: "connected_systems", event_type: "document_share_payment_confirmed" },
        ...original.items,
      ],
    };
    view.rerender(renderPage());
    expect(await screen.findByText("row-6")).toBeInTheDocument();
    expect(screen.getByText("row-5")).toBeInTheDocument();
    expect(screen.queryByText("row-7")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New activity" })).toBeInTheDocument();
    expect(root.scrollTop).toBe(202);
    expect(mocks.readStarted).not.toHaveBeenCalled();
    root.scrollTop = 0;
    fireEvent.scroll(root);
    expect(mocks.readStarted).toHaveBeenCalledWith("feed-user", "6");
  } finally {
    mocks.data = original;
    view.unmount();
  }
});
import { resolveLocalOnboardingHandler, prepareLocalOnboardingAction } from "@/lib/agent/local-onboarding-actions";


describe("Feed connection action ID binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRequests.mockResolvedValue([
      { id: "req-a", counterpartDisplayName: "Alex" },
      { id: "req-b", counterpartDisplayName: "Alex" },
      { id: "req-c", counterpartDisplayName: "Casey" },
    ]);
    mocks.acceptRequest.mockResolvedValue(undefined);
    mocks.rejectRequest.mockResolvedValue(undefined);
  });

  it.each(["accept", "reject"])("binds %s to the selected incoming ID", async (verb) => {
    render(<FeedPage />);
    const handler = resolveLocalOnboardingHandler(`connect.${verb}_request`)!;
    expect((await handler({ person: "Alex", requestId: "req-b" })).status).toBe("blocked");
    expect(mocks.listRequests).not.toHaveBeenCalled();
    const slots = { person: "Alex", requestId: "req-b" };
    const preparation = await prepareLocalOnboardingAction(`connect.${verb}_request`, slots);
    expect(preparation?.status).toBe("ready");
    if (preparation?.status !== "ready") throw new Error("Preparation failed");
    expect(preparation.binding).toMatchObject({ owner: "feed-user", requestId: "req-b", person: "Alex" });
    expect(mocks.acceptRequest).not.toHaveBeenCalled();
    expect(mocks.rejectRequest).not.toHaveBeenCalled();
    const result = await handler(slots, { directiveId: "confirmed", preparedBinding: preparation.binding });
    expect(result.status).toBe("succeeded");
    expect(verb === "accept" ? mocks.acceptRequest : mocks.rejectRequest).toHaveBeenCalledWith({
      idToken: "firebase-token", requestId: "req-b",
    });
  });

  it.each([
    { person: "Alex", requestId: "foreign-or-stale" },
    { person: "Casey", requestId: "req-a" },
    { person: "Alex", requestId: "" },
    { person: "Alex" },
  ])("refuses unresolved or mismatched request %j", async (slots) => {
    render(<FeedPage />);
    const handler = resolveLocalOnboardingHandler("connect.accept_request")!;
    expect((await handler(slots, { directiveId: "confirmed" })).status).toBe("blocked");
    expect(mocks.acceptRequest).not.toHaveBeenCalled();
    expect(mocks.rejectRequest).not.toHaveBeenCalled();
  });

  it("retains unique name-only requests", async () => {
    render(<FeedPage />);
    const handler = resolveLocalOnboardingHandler("connect.reject_request")!;
    expect((await handler({ person: "Casey" }, { directiveId: "confirmed" })).status).toBe("succeeded");
    expect(mocks.rejectRequest).toHaveBeenCalledWith({ idToken: "firebase-token", requestId: "req-c" });
  });

  it("rechecks a prepared request and blocks changed or foreign bindings", async () => {
    render(<FeedPage />);
    const slots = { person: "Casey", requestId: "req-c" };
    const preparation = await prepareLocalOnboardingAction("connect.reject_request", slots);
    if (preparation?.status !== "ready") throw new Error("Preparation failed");
    const handler = resolveLocalOnboardingHandler("connect.reject_request")!;
    expect((await handler(slots, { directiveId: "confirmed", preparedBinding: { ...preparation.binding, owner: "someone-else" } })).status).toBe("blocked");
    mocks.listRequests.mockResolvedValue([]);
    expect((await handler(slots, { directiveId: "confirmed", preparedBinding: preparation.binding })).status).toBe("blocked");
    expect(mocks.rejectRequest).not.toHaveBeenCalled();
  });

  it("keeps scope-bearing acceptance in the existing review", async () => {
    mocks.listRequests.mockResolvedValue([{ id: "req-s", counterpartDisplayName: "Sam", scopes: [{ scopeHandle: "private" }] }]);
    render(<FeedPage />);
    expect(await prepareLocalOnboardingAction("connect.accept_request", { person: "Sam", requestId: "req-s" })).toMatchObject({ status: "blocked", gate: "navigation", waitForUser: true });
    expect(mocks.acceptRequest).not.toHaveBeenCalled();
  });
});

async function renderAfterAutomaticRead() {
  const view = render(<FeedPage />);
  await waitFor(() => expect(mocks.markRead).toHaveBeenCalled());
  mocks.markRead.mockClear();
  mocks.readStarted.mockClear();
  mocks.readSettled.mockClear();
  mocks.readFailed.mockClear();
  mocks.dispatchFeedStateChanged.mockClear();
  return view;
}

describe("Feed history interactions", () => {
  it("releases a quiet row's reading anchor when the raw refreshed page is accepted at the top", async () => {
    const root = document.createElement("div");
    root.dataset.appScrollRoot = "true";
    document.body.append(root);
    try {
      const share = { ...mocks.data.items[0]!, id: "5", source_domain: "location",
        event_type: "location_share_created", created_at: "2026-01-02T00:00:00Z",
        metadata: { feed_group_key: "share-a", feed_audience: "recipient" } };
      const other = { ...mocks.data.items[0]!, id: "4", created_at: "2026-01-03T00:00:00Z" };
      mocks.data = { items: [other, share], next_cursor: null, unread_count: 0 };
      const view = render(<FeedPage />);
      await screen.findByText("row-5");
      act(() => { root.scrollTop = 600; root.dispatchEvent(new Event("scroll")); });
      const ended = { ...share, id: "6", event_type: "location_share_expired", created_at: "2026-01-04T00:00:00Z",
        metadata: { ...share.metadata, feed_silent: true } };
      mocks.data = { ...mocks.data, items: [ended, other] };
      await act(async () => view.rerender(<FeedPage />));
      expect(screen.getAllByText(/^row-/).map(node => node.textContent)).toEqual(["row-4", "row-6"]);
      act(() => { root.scrollTop = 0; root.dispatchEvent(new Event("scroll")); });
      mocks.data = { ...mocks.data, items: [{ ...ended }, other] };
      await act(async () => view.rerender(<FeedPage />));
      expect(screen.getAllByText(/^row-/).map(node => node.textContent)).toEqual(["row-6", "row-4"]);
    } finally { root.remove(); }
  });
  it("keeps loaded history usable while another lane is still loading", async () => {
    mocks.actionablesLoading = true;
    render(<FeedPage />);
    await screen.findByText("row-5");
    expect(screen.getByRole("region", { name: "Needs you status" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("No activity yet")).toBeNull();
    expect(screen.queryByLabelText("Loading feed")).toBeNull();
  });

  it("offers recovery for a failed lane while another cold lane is pending", () => {
    mocks.resourceMissing = true;
    mocks.historyLoading = true;
    mocks.actionablesError = "Unavailable";
    render(<FeedPage />);
    expect(screen.getByText("Some activity could not load. Other updates are still loading.")).toBeVisible();
    expect(screen.queryByText("No activity yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.retryActionables).toHaveBeenCalled();
  });
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    mocks.useRealFeedRow = false;
    mocks.actionables = [];
    mocks.useActionTestRow = false;
    mocks.currentUser = mocks.user;
    mocks.user.getIdToken.mockResolvedValue("firebase-token");
    mocks.markRead.mockResolvedValue(undefined);
    mocks.clear.mockResolvedValue(undefined);
    mocks.clearSmsEmergencies.mockResolvedValue(undefined);
    mocks.dismiss.mockResolvedValue({ token: "dismissal-token", itemIds: null });
    mocks.restore.mockResolvedValue(true);
    mocks.data = {
      items: [
        {
          id: "5",
          source_domain: "connections",
          event_type: "connection_accepted",
          actor_label: "Alex",
          metadata: {},
          read: false,
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      next_cursor: null,
      unread_count: 1,
    };
  });

  describe("automatic history pagination", () => {
    const observers: Array<{
      notify: (visible: boolean) => void;
      disconnect: ReturnType<typeof vi.fn>;
      options?: IntersectionObserverInit;
    }> = [];

    beforeEach(() => {
      observers.length = 0;
      mocks.list.mockReset();
      mocks.data.next_cursor = "older-1";
      vi.stubGlobal("IntersectionObserver", class {
        disconnect = vi.fn();
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          observers.push({
            notify: (visible) => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
            disconnect: this.disconnect,
            options,
          });
        }
        observe() {}
      });
    });

    afterEach(() => vi.unstubAllGlobals());

    const olderRow = (id: string) => ({ ...mocks.data.items[0], id });

    it("prefetches at the app scroll end once per page and stops at the final cursor", async () => {
      let resolvePage!: (page: { items: ReturnType<typeof olderRow>[]; next_cursor: string | null; unread_count: number }) => void;
      mocks.list.mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
      const root = document.createElement("div");
      root.dataset.appScrollRoot = "true";
      document.body.append(root);
      const view = render(<FeedPage />, { container: root });
      await waitFor(() => expect(observers.length).toBeGreaterThan(0));
      const first = observers.at(-1)!;
      expect(first.options?.root).toBe(root);
      expect(first.options?.rootMargin).toBe("240px 0px");
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
      act(() => first.notify(false));
      expect(mocks.list).not.toHaveBeenCalled();
      act(() => { first.notify(true); first.notify(true); });
      await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
      expect(mocks.list).toHaveBeenLastCalledWith({ idToken: "firebase-token", cursor: "older-1", limit: 20, isEffectCurrent: expect.any(Function) });
      await act(async () => resolvePage({ items: [olderRow("4")], next_cursor: "older-2", unread_count: 0 }));
      await screen.findByText("row-4");
      await waitFor(() => expect(observers.at(-1)).not.toBe(first));
      mocks.list.mockResolvedValueOnce({ items: [olderRow("3")], next_cursor: null, unread_count: 0 });
      const last = observers.at(-1)!;
      act(() => last.notify(true));
      await screen.findByText("row-3");
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(last.disconnect).toHaveBeenCalled();
      act(() => { first.notify(true); last.notify(true); });
      expect(mocks.list).toHaveBeenCalledTimes(2);
      view.unmount();
      root.remove();
    });

    it("discards a pending older page after chat history is invalidated", async () => {
      let resolvePage!: (value: { items: ReturnType<typeof olderRow>[]; next_cursor: string | null; unread_count: number }) => void;
      mocks.list.mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve; }));
      const view = render(<FeedPage />);
      await waitFor(() => expect(observers.length).toBeGreaterThan(0));
      act(() => observers.at(-1)!.notify(true));
      await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
      act(() => bumpFeedPresentationRevision(mocks.user.uid));
      await act(async () => resolvePage({ items: [olderRow("4")], next_cursor: null, unread_count: 0 }));
      expect(screen.queryByText("row-4")).not.toBeInTheDocument();
      expect(screen.queryByText("Couldn't load more.")).not.toBeInTheDocument();
      view.unmount();
    });

    it("continues usable history while an unrelated lane is slow", async () => {
      mocks.actionablesLoading = true;
      mocks.list.mockResolvedValueOnce({ items: [olderRow("4")], next_cursor: null, unread_count: 0 });
      render(<FeedPage />);
      await waitFor(() => expect(observers.length).toBeGreaterThan(0));
      act(() => observers.at(-1)!.notify(true));
      await screen.findByText("row-4");
      expect(screen.getByRole("region", { name: "Needs you status" })).toHaveAttribute("aria-busy", "true");
    });

    it("continues from the restored older-page cursor on a same-session return", async () => {
      mocks.list.mockResolvedValueOnce({ items: [olderRow("4")], next_cursor: "older-2", unread_count: 0 });
      const root = document.createElement("div");
      root.dataset.appScrollRoot = "true";
      document.body.append(root);
      const first = render(<FeedPage />, { container: root });
      await waitFor(() => expect(observers.length).toBeGreaterThan(0));
      act(() => observers.at(-1)!.notify(true));
      await screen.findByText("row-4");
      first.unmount();
      mocks.list.mockClear();
      mocks.list.mockResolvedValueOnce({ items: [olderRow("3")], next_cursor: null, unread_count: 0 });
      const priorCount = observers.length;
      const secondRoot = document.createElement("div");
      root.append(secondRoot);
      const second = render(<FeedPage />, { container: secondRoot });
      await screen.findByText("row-4");
      await waitFor(() => expect(observers.length).toBeGreaterThan(priorCount));
      act(() => observers.at(-1)!.notify(true));
      await screen.findByText("row-3");
      expect(mocks.list).toHaveBeenCalledExactlyOnceWith({ idToken: "firebase-token", cursor: "older-2", limit: 20, isEffectCurrent: expect.any(Function) });
      second.unmount();
      root.remove();
    });

    it("pauses automatic reads after an error and resumes through explicit Retry", async () => {
      mocks.list.mockRejectedValueOnce(new Error("offline"));
      render(<FeedPage />);
      await waitFor(() => expect(observers.length).toBeGreaterThan(0));
      const first = observers.at(-1)!;
      act(() => first.notify(true));
      const retry = await screen.findByRole("button", { name: "Retry" });
      act(() => first.notify(true));
      expect(mocks.list).toHaveBeenCalledTimes(1);
      mocks.list.mockResolvedValueOnce({ items: [olderRow("4")], next_cursor: null, unread_count: 0 });
      fireEvent.click(retry);
      await screen.findByText("row-4");
      expect(mocks.list).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("pauses if a backend page repeats its cursor instead of looping", async () => {
      mocks.list.mockResolvedValueOnce({ items: [olderRow("4")], next_cursor: "older-1", unread_count: 0 });
      render(<FeedPage />);
      await waitFor(() => expect(observers.length).toBeGreaterThan(0));
      const first = observers.at(-1)!;
      act(() => first.notify(true));
      await screen.findByRole("button", { name: "Retry" });
      act(() => first.notify(true));
      expect(mocks.list).toHaveBeenCalledTimes(1);
    });

    it("retains the manual fallback when IntersectionObserver is unavailable", async () => {
      vi.stubGlobal("IntersectionObserver", undefined);
      mocks.list.mockResolvedValueOnce({ items: [olderRow("4")], next_cursor: null, unread_count: 0 });
      render(<FeedPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
      await screen.findByText("row-4");
      expect(mocks.list).toHaveBeenCalledTimes(1);
    });
  });

  it("does not acknowledge unseen activity when search opens during token acquisition", async () => {
    let resolve!: (token: string) => void;
    mocks.markRead.mockClear();
    mocks.user.getIdToken.mockReturnValue(new Promise<string>(done => { resolve=done; }));
    render(<FeedPage/>);
    await waitFor(()=>expect(resolve).toBeDefined());
    act(()=>window.dispatchEvent(new Event(FEED_SEARCH_OPEN_EVENT)));
    await act(async()=>resolve("firebase-token"));
    expect(mocks.markRead).not.toHaveBeenCalled();
    mocks.user.getIdToken.mockResolvedValue("firebase-token");
  });

  it("keeps each active emergency separate and uses dated receipts for ended incidents", async () => {
    const sms = (id: string, sender: string, live = false): FeedActionable => ({
      id, title: sender, person: { displayName: sender, photoUrl: null },
      description: live ? "Emergency SMS · Active" : "Emergency SMS · Revoked",
      icon: () => null, iconTone: "capability", actions: [], sortAt: live ? 2 : 1,
      smsEmergency: { senderId: sender }, emphasis: live ? "emergency" : undefined,
      displayTimestamp: Date.parse("2026-08-12T09:00:00Z"),
    });
    mocks.actionables = [sms("a1", "Alex", true), sms("a3", "Alex", true), sms("a2", "Alex"), sms("b1", "Blair"), sms("b2", "Blair"), {
      id: "request", title: "Pending request", description: "Needs a decision", icon: () => null,
      iconTone: "capability", actions: [], sortAt: 0,
    }];
    await renderAfterAutomaticRead();
    const live = within(screen.getByRole("region", { name: "Live" }));
    expect(live.getByTestId("feed-actionable-a1")).toBeInTheDocument();
    expect(live.getByTestId("feed-actionable-a3")).toBeInTheDocument();
    expect(live.queryByTestId("feed-sms-alert-group")).toBeNull();
    expect(screen.queryByTestId("feed-actionable-a2")).toBeNull();
    expect(screen.getByText("row-5")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(screen.getByTestId("feed-actionable-request")).toBeInTheDocument();
  });

  it("pins server-confirmed incidents outside loaded history across agent scopes", async () => {
    const original = mocks.data;
    const incidents = ["old-live-one", "old-live-two"].map(id => ({ ...original.items[0], id,
      source_domain:"location", event_type:"location_share_created", activity_group_id:`location-grant:${id}`,
      metadata:{grant_id:id,share_kind:"sos",feed_audience:"recipient",current_location_status:"active"},
      created_at:"2025-01-01T00:00:00Z" }));
    mocks.data = { ...original, live_incidents:{items:incidents,next_cursor:null} } as typeof mocks.data;
    mocks.actionables = [];
    try {
      render(<FeedPage />);
      const live = within(await screen.findByRole("region", { name:"Live" }));
      expect(live.getByText("row-old-live-one")).toBeVisible();
      expect(live.getByText("row-old-live-two")).toBeVisible();
      act(() => window.dispatchEvent(new Event(FEED_SEARCH_OPEN_EVENT)));
      fireEvent.change(screen.getByRole("combobox", { name:"Agent scope" }), {target:{value:"finance"}});
      expect(live.getByText("row-old-live-one")).toBeVisible();
      expect(screen.getAllByText("row-old-live-one")).toHaveLength(1);
    } finally { mocks.data = original; }
  });

  it("acknowledges a newly observed receipt after a same-ID update between fetch queries", async () => {
    const receipt = { up_to_id: "5", through_time: "2026-01-03T00:00:00Z", fingerprint: "a".repeat(32) };
    mocks.data = { ...mocks.data, read_snapshot: receipt } as typeof mocks.data;
    const view = render(<FeedPage />);
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith(expect.objectContaining({ snapshotFingerprint: receipt.fingerprint })));
    mocks.markRead.mockClear();
    mocks.data = { ...mocks.data, read_snapshot: { ...receipt, fingerprint: "b".repeat(32) } } as typeof mocks.data;
    view.rerender(<FeedPage />);
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith(expect.objectContaining({ snapshotFingerprint: "b".repeat(32) })));
    mocks.markRead.mockClear();
    mocks.data = { ...mocks.data, read_snapshot: { ...receipt, fingerprint: "b".repeat(32), through_time: "2026-01-04T00:00:00Z" } } as typeof mocks.data;
    view.rerender(<FeedPage />);
    await act(async () => {});
    expect(mocks.markRead).not.toHaveBeenCalled();
  });

  it("settles a cached KYC review after the same workflow has a confirmed sent reply", async () => {
    mocks.actionables = [{ id: "kyc-review", operationKey: "kyc-workflow:one", title: "Information request",
      description: "", icon: () => null, iconTone: "capability", actions: [], sortAt: 1 }];
    mocks.data.items = [{ ...mocks.data.items[0], source_domain: "connected_systems", event_type: "mail_message_sent",
      activity_group_id: "kyc-workflow:one" } as typeof mocks.data.items[number]];
    await renderAfterAutomaticRead();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(screen.getByText("row-5")).toBeInTheDocument();
  });

  it("opens the selected legacy receipt instead of an unselected location workspace", async () => {
    mocks.useRealFeedRow = true;
    mocks.data.items = [
      {
        ...mocks.data.items[0],
        source_domain: "location",
        event_type: "location_share_created",
        actor_label: "Ankit",
        metadata: {
          feed_audience: "recipient",
          counterpart_label: "Ankit",
          duration_hours: 2,
        },
      },
    ];
    await renderAfterAutomaticRead();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Ankit shared their location with you",
      }),
    );

    await waitFor(() => expect(mocks.activityDetail).toHaveBeenCalledWith(expect.objectContaining({ itemId: "5" })));
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("opens the owner's shared files in place instead of routing", async () => {
    mocks.useRealFeedRow = true;
    mocks.data.items = [
      {
        ...mocks.data.items[0],
        source_domain: "connected_systems",
        event_type: "document_share_files_sent",
        actor_label: "Ankit",
        metadata: {
          request_id: "6b4d3c1e-2f5a-4b6c-8d7e-9f0a1b2c3d4e",
          counterpart_label: "Ankit",
          shared_count: 12,
        },
      },
    ];
    await renderAfterAutomaticRead();
    expect(screen.queryByTestId("shared-files-sheet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open One sent 12 files to Ankit" }));

    const sheet = screen.getByTestId("shared-files-sheet");
    expect(sheet).toHaveAttribute("data-request-id", "6b4d3c1e-2f5a-4b6c-8d7e-9f0a1b2c3d4e");
    expect(sheet).toHaveAttribute("data-count", "12");
    expect(mocks.routerPush).not.toHaveBeenCalled();
  });

  it("opens an unread Circle conversation directly through its validated destination", async () => {
    mocks.useRealFeedRow = true;
    mocks.data.items = [{...mocks.data.items[0],source_domain:"location",event_type:"location_circle_message",metadata:{circle_id:"11111111-2222-4333-8444-555555555555",circle_name:"Family"}}];
    await renderAfterAutomaticRead();
    fireEvent.click(screen.getByRole("button",{name:"Open Family"}));
    expect(mocks.routerPush).toHaveBeenCalledWith(expect.stringContaining("circleChat=1"));
    expect(mocks.activityDetail).not.toHaveBeenCalled();
  });

  it("lets a confirmed terminal receipt supersede a cached Live alert for only that grant", async () => {
    mocks.actionables=[{id:"sms-emergency:one",operationKey:"location-grant:one",title:"Emergency alert from Ankit",description:"",icon:()=>null,iconTone:"capability",emphasis:"emergency",smsEmergency:{senderId:"sender"},sortAt:1,actions:[]}];
    mocks.data.items=[{...mocks.data.items[0],source_domain:"location",event_type:"location_share_expired",activity_group_id:"location-grant:one"} as typeof mocks.data.items[number]];
    await renderAfterAutomaticRead();
    expect(screen.queryByRole("region",{name:"Live"})).toBeNull();
    expect(screen.getByText("row-5")).toBeInTheDocument();
  });

  it("refreshes the displayed details when the server updates an existing notification", async () => {
    mocks.useRealFeedRow = true;
    mocks.data.items = [
      {
        ...mocks.data.items[0],
        source_domain: "location",
        event_type: "location_share_created",
        actor_label: "Ankit",
        metadata: {
          feed_audience: "recipient",
          counterpart_label: "Ankit",
          duration_hours: 2,
        },
      },
    ];
    const view = await renderAfterAutomaticRead();
    expect(
      screen.getByText("Ankit shared their location with you"),
    ).toBeInTheDocument();

    mocks.data = {
      ...mocks.data,
      items: [
        {
          ...mocks.data.items[0],
          metadata: { ...mocks.data.items[0].metadata, duration_hours: 3 },
        },
      ],
    };
    await act(async () => view.rerender(<FeedPage />));

    expect(
      screen.getByText("3 hours"),
    ).toBeInTheDocument();
    expect(screen.queryByText("2 hours")).toBeNull();
  });

  it("retires an unsafe legacy timestamp watermark without hiding a later id", async () => {
    window.localStorage.setItem(
      "hushh:feed-cleared-at:feed-user",
      "2026-01-02T00:00:00.000Z",
    );
    mocks.data = {
      ...mocks.data,
      items: [
        {
          ...mocks.data.items[0],
          id: "6",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    await renderAfterAutomaticRead();

    expect(screen.getByText("row-6")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        window.localStorage.getItem("hushh:feed-cleared-at:feed-user"),
      ).toBeNull(),
    );
  });

  it("keeps an old device clear hidden while transferring it to the server", async () => {
    window.localStorage.setItem("hushh:feed-cleared-through-id:feed-user", "5");
    mocks.clear.mockImplementation(() => new Promise(() => undefined));

    render(<FeedPage />);

    expect(mocks.feedRowRender).not.toHaveBeenCalled();
    expect(screen.queryByText("row-5")).toBeNull();
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledWith({
      idToken: "firebase-token",
      userId: "feed-user", isEffectCurrent: expect.any(Function),
      upToId: "5",
    }));
    await waitFor(() =>
      expect(screen.getByText("No activity yet")).toBeInTheDocument(),
    );
  });

  it("requires confirmation, commits Clear to the server, and keeps a later id visible", async () => {
    const view = await renderAfterAutomaticRead();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear feed notifications",
      }),
    );
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.clearSmsEmergencies).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm clear feed notifications",
      }),
    );
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Feed cleared",
      ),
    );

    expect(mocks.clear).toHaveBeenCalledWith({
      idToken: "firebase-token",
      userId: "feed-user", isEffectCurrent: expect.any(Function),
      upToId: "5",
    });
    expect(mocks.clear.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clearSmsEmergencies.mock.invocationCallOrder[0],
    );
    expect(
      window.localStorage.getItem("hushh:feed-cleared-through-id:feed-user"),
    ).toBeNull();

    mocks.data = {
      ...mocks.data,
      items: [
        {
          ...mocks.data.items[0],
          id: "6",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        mocks.data.items[0],
      ],
    };
    await act(async () => view.rerender(<FeedPage />));

    expect(screen.getByText("row-6")).toBeInTheDocument();
    expect(screen.queryByText("row-5")).toBeNull();
  });

  it("releases the local Clear barrier only after the server confirms that clear version", async () => {
    mocks.clear.mockResolvedValueOnce("100");
    const view = await renderAfterAutomaticRead();
    fireEvent.click(screen.getByRole("button", { name: "Clear feed notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear feed notifications" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Feed cleared"));
    expect(screen.queryByText("row-5")).toBeNull();
    mocks.data = { ...mocks.data, clear_version: "100", items: [{ ...mocks.data.items[0], created_at: "2026-01-03T00:00:00.000Z" }] } as typeof mocks.data;
    await act(async () => view.rerender(<FeedPage />));
    await waitFor(() => expect(screen.getByText("row-5")).toBeInTheDocument());
  });

  it("removes only after server acknowledgement and restores through Undo", async () => {
    mocks.useActionTestRow = true;
    let confirmDismiss: (() => void) | undefined;
    mocks.dismiss.mockImplementationOnce(() => new Promise((resolve) => {
      confirmDismiss = () => resolve({ token: "dismissal-token", itemIds: ["5"] });
    }));
    await renderAfterAutomaticRead();

    fireEvent.click(screen.getByRole("button", { name: "row-5" }));
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith({
      idToken: "firebase-token", userId: "feed-user", isEffectCurrent: expect.any(Function), itemId: "5",
    }));
    expect(screen.getByRole("button", { name: "row-5" })).toBeInTheDocument();

    await act(async () => { confirmDismiss?.(); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "row-5" })).toBeNull());
    const undo = mocks.toastSuccess.mock.calls.find((call) => call[0] === "Removed from Feed")?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined;
    expect(undo?.action?.onClick).toBeTypeOf("function");
    await act(async () => { undo?.action?.onClick?.(); });
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith({
      idToken: "firebase-token", userId: "feed-user", isEffectCurrent: expect.any(Function), itemId: "5",
      dismissalToken: "dismissal-token",
    }));
    expect(screen.getByRole("button", { name: "row-5" })).toBeInTheDocument();
  });

  it("keeps a row hidden when its Undo token is stale", async () => {
    mocks.useActionTestRow = true;
    mocks.restore.mockResolvedValueOnce(false);
    await renderAfterAutomaticRead();

    fireEvent.click(screen.getByRole("button", { name: "row-5" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "row-5" })).toBeNull());
    const undo = mocks.toastSuccess.mock.calls.find((call) => call[0] === "Removed from Feed")?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined;
    await act(async () => { undo?.action?.onClick?.(); });

    expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({
      itemId: "5", dismissalToken: "dismissal-token",
    }));
    expect(screen.queryByRole("button", { name: "row-5" })).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith("This item can no longer be restored.");
  });

  it("leaves a row visible when server dismissal fails", async () => {
    mocks.useActionTestRow = true;
    mocks.dismiss.mockRejectedValueOnce(new Error("backend unavailable"));
    await renderAfterAutomaticRead();

    fireEvent.click(screen.getByRole("button", { name: "row-5" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't remove this item. Try again.",
    ));
    expect(screen.getByRole("button", { name: "row-5" })).toBeInTheDocument();
  });

  it("does not claim removal when the server acknowledges no dismissed row", async () => {
    mocks.useActionTestRow = true;
    mocks.dismiss.mockResolvedValueOnce(null);
    await renderAfterAutomaticRead();

    fireEvent.click(screen.getByRole("button", { name: "row-5" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't confirm removal. Try again.",
    ));
    expect(mocks.refresh).toHaveBeenCalledWith({ force: true });
    expect(screen.getByRole("button", { name: "row-5" })).toBeInTheDocument();
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(
      "Removed from Feed", expect.anything(),
    );
    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalledWith("action");
  });

  it("does not reveal an older consent bundle row from stale cache after dismissal", async () => {
    mocks.useActionTestRow = true;
    mocks.data.items = [
      { ...mocks.data.items[0], id: "6", source_domain: "consent", event_type: "consent_granted", metadata: { bundle_id: "same-request" } },
      { ...mocks.data.items[0], id: "5", source_domain: "consent", event_type: "consent_granted", metadata: { bundle_id: "same-request" } },
    ];
    await renderAfterAutomaticRead();
    expect(screen.getByRole("button", { name: "row-6" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "row-5" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "row-6" }));
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith({
      idToken: "firebase-token", userId: "feed-user", isEffectCurrent: expect.any(Function), itemId: "6",
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "row-6" })).toBeNull());
    expect(screen.queryByRole("button", { name: "row-5" })).toBeNull();
  });

  it("does not reveal an older Drive outcome after removing the displayed outcome", async () => {
    mocks.useActionTestRow = true;
    mocks.data.items = [
      { ...mocks.data.items[0], id: "6", source_domain: "connected_systems", event_type: "document_share_outcome", metadata: { request_id: "request-1", user_facing_status: "completed" } },
      { ...mocks.data.items[0], id: "5", source_domain: "connected_systems", event_type: "document_share_outcome", metadata: { request_id: "request-1", user_facing_status: "no_match" } },
    ];
    await renderAfterAutomaticRead();
    expect(screen.getByRole("button", { name: "row-6" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "row-5" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "row-6" }));
    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith({
      idToken: "firebase-token", userId: "feed-user", isEffectCurrent: expect.any(Function), itemId: "6",
    }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "row-6" })).toBeNull());
    expect(screen.queryByRole("button", { name: "row-5" })).toBeNull();
  });

  it("does not show the older Drive decision after removing 'No files were shared'", async () => {
    mocks.useActionTestRow = true;
    mocks.data.items = [
      { ...mocks.data.items[0], id: "11", source_domain: "connected_systems", event_type: "document_share_outcome", metadata: { request_id: "request-x", user_facing_status: "no_files_shared" } },
      { ...mocks.data.items[0], id: "10", source_domain: "connected_systems", event_type: "document_share_decided", metadata: { request_id: "request-x", user_facing_status: "pending" } },
    ];
    // The server hides the decision it was folding behind the outcome.
    mocks.dismiss.mockResolvedValueOnce({ token: "dismissal-token", itemIds: ["10", "11"] });
    await renderAfterAutomaticRead();
    expect(screen.getByRole("button", { name: "row-11" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "row-10" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "row-11" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "row-11" })).toBeNull());
    expect(screen.queryByRole("button", { name: "row-10" })).toBeNull();
  });

  it("does not show the old Pay row after removing the payment confirmation", async () => {
    mocks.useActionTestRow = true;
    mocks.data.items = [
      { ...mocks.data.items[0], id: "31", source_domain: "connected_systems", event_type: "document_share_payment_confirmed", metadata: { request_id: "request-y" } },
      { ...mocks.data.items[0], id: "30", source_domain: "connected_systems", event_type: "document_share_payment_ready", metadata: { request_id: "request-y", user_facing_status: "pending" } },
    ];
    mocks.dismiss.mockResolvedValueOnce({ token: "dismissal-token", itemIds: ["30", "31"] });
    await renderAfterAutomaticRead();
    expect(screen.queryByRole("button", { name: "row-30" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "row-31" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "row-31" })).toBeNull());
    expect(screen.queryByRole("button", { name: "row-30" })).toBeNull();
  });

  it("retires a pending Undo when the account signs out", async () => {
    mocks.useActionTestRow = true;
    mocks.toastSuccess.mockReturnValueOnce("undo-toast");
    const view = await renderAfterAutomaticRead();
    fireEvent.click(screen.getByRole("button", { name: "row-5" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "row-5" })).toBeNull());
    const undo = mocks.toastSuccess.mock.calls.find((call) => call[0] === "Removed from Feed")?.[1] as
      | { action?: { onClick?: () => void } }
      | undefined;

    try {
      mocks.currentUser = null;
      await act(async () => view.rerender(<FeedPage />));
      expect(mocks.toastDismiss).toHaveBeenCalledWith("undo-toast");
      mocks.currentUser = { uid: "next-user", getIdToken: vi.fn().mockResolvedValue("next-token") };
      await act(async () => view.rerender(<FeedPage />));
      await act(async () => { undo?.action?.onClick?.(); });

      expect(undo?.action?.onClick).toBeTypeOf("function");
      expect(mocks.restore).not.toHaveBeenCalled();
    } finally {
      mocks.currentUser = mocks.user;
    }
  });

  it("saves the SOS clear even when only SOS cards are showing", async () => {
    mocks.data.items = [];
    render(<FeedPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Clear feed notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear feed notifications" }));

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Feed cleared"));
    expect(mocks.clearSmsEmergencies).toHaveBeenCalledTimes(1);
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("says the Feed was not cleared if the SOS clear throws", async () => {
    await renderAfterAutomaticRead();
    // A server failure does not reject (the hook keeps the clear on this
    // device); any unexpected error still reaches the page as a failed Clear.
    mocks.clearSmsEmergencies.mockRejectedValueOnce(new Error("unexpected"));

    fireEvent.click(screen.getByRole("button", { name: "Clear feed notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm clear feed notifications" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Couldn't clear your feed."));
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith("Feed cleared");
  });

  it("opens on activity without device notices and retires the old sound preference", async () => {
    const legacyKey = "hushh:feed-sound-enabled:feed-user";
    const otherKey = "hushh:feed-sound-enabled:other-owner";
    window.localStorage.setItem(legacyKey, "1");
    window.localStorage.setItem(otherKey, "1");

    const view = await renderAfterAutomaticRead();
    const contents = within(view.container.querySelector("main")!);
    expect(contents.getByText("row-5")).toBeVisible();
    expect(contents.queryByText("Reconnect notifications")).not.toBeInTheDocument();
    expect(contents.queryByRole("button", { name: /Feed sound/i })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(legacyKey)).toBeNull();
    expect(window.localStorage.getItem(otherKey)).toBe("1");
  });

  it("keeps the clear action compact on phone and desktop layouts", async () => {
    await renderAfterAutomaticRead();

    const clearButton = screen.getByRole("button", {
      name: "Clear feed notifications",
    });
    expect(clearButton).toHaveClass("w-auto", "max-w-full", "px-4");
    expect(clearButton).not.toHaveClass("w-full");
  });

  // Regression (localhost run 2026-09-28): the red Clear action
  // sat directly under the Needs you row, reading as an answer to it.
  it("keeps Clear quiet and after the history, destructive only once armed", async () => {
    const view = await renderAfterAutomaticRead();
    const clearButton = screen.getByRole("button", { name: "Clear feed notifications" });
    const daySections = view.container.querySelectorAll("section[aria-label]");
    const lastHistorySection = daySections[daySections.length - 1]!;
    expect(lastHistorySection).toBeTruthy();
    expect(lastHistorySection.contains(clearButton)).toBe(false);
    expect(lastHistorySection.compareDocumentPosition(clearButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(clearButton.className).not.toMatch(/text-destructive/);
    fireEvent.click(clearButton);
    expect(screen.getByRole("button", { name: "Confirm clear feed notifications" }).className)
      .toMatch(/text-destructive/);
  });

  it("does not dismiss revoked SOS cards or hide history when server Clear fails", async () => {
    await renderAfterAutomaticRead();
    mocks.clear.mockRejectedValueOnce(new Error("backend unavailable"));

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear feed notifications",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Confirm clear feed notifications",
      }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't clear your feed.",
      ),
    );
    expect(mocks.clearSmsEmergencies).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem("hushh:feed-cleared-through-id:feed-user"),
    ).toBeNull();
    expect(screen.getByText("row-5")).toBeInTheDocument();
  });
});

describe("Feed document price step", () => {
  function pricePrompt(overrides: Record<string, unknown> = {}) {
    return {
      open: true,
      requesterLabel: "Kushal Trivedi",
      paymentRequired: true,
      lockedAmountCents: null,
      initialAmountCents: null,
      priceOnly: false,
      purpose: "Tax returns",
      recipientEmail: "kushal@example.invalid",
      periodStart: null,
      periodEnd: null,
      detailsPending: false,
      busy: false,
      error: null,
      submit: vi.fn(),
      cancel: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.documentPricePrompt = undefined;
  });

  it("shows the owner the estimate the requester saw, and still sends the owner's price", () => {
    const prompt = pricePrompt({ estimateCents: 2500 });
    mocks.documentPricePrompt = prompt;
    render(<FeedPage />);

    expect(screen.getByText("Requester saw an estimate of $25")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Allow · $10" }));
    expect(prompt.submit).toHaveBeenCalledExactlyOnceWith(1000);
  });

  it("prices normally when no estimate is known", () => {
    const prompt = pricePrompt();
    mocks.documentPricePrompt = prompt;
    render(<FeedPage />);

    expect(screen.queryByText(/Requester saw an estimate/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow · $10" }));
    expect(prompt.submit).toHaveBeenCalledExactlyOnceWith(1000);
  });
});

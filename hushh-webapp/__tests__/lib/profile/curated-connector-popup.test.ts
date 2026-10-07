import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCuratedPopupAttempt,
  createCuratedPopupAttempt,
  isCuratedConnectorId,
  isCuratedPopupAttempt,
  isCuratedPopupReturn,
  isCuratedPopupSettlement,
  navigateCuratedOAuthPopup,
  notifyCuratedPopup,
  openCuratedOAuthPopup,
  readCuratedPopupAttempt,
  waitForCuratedPopup,
} from "@/lib/profile/curated-connector-popup";

const ATTEMPT_KEY = "one_curated_popup_attempt_v1";
const SETTLEMENT_KEY = "one_curated_popup_settlement_v1";
const AUTHORIZE_URL = "https://mcp.notion.com/authorize?state=signed-state";
const realLocation = window.location;

describe("curated connector popup boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    if (typeof window.localStorage?.setItem !== "function") {
      const store = new Map<string, string>();
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
          get length() {
            return store.size;
          },
          clear: () => store.clear(),
          getItem: (key: string) => store.get(key) ?? null,
          key: (index: number) => Array.from(store.keys())[index] ?? null,
          removeItem: (key: string) => {
            store.delete(key);
          },
          setItem: (key: string, value: string) => {
            store.set(key, value);
          },
        },
      });
    }
    window.localStorage.clear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "https://uat.one.hushh.ai" },
    });
  });
  afterEach(() => {
    Object.defineProperty(window, "location", { configurable: true, value: realLocation });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const attempt = (connectorId = "notion") => ({
    connectorId,
    attemptId: "synthetic-attempt-id",
    expiresAt: Date.now() + 60_000,
  });
  const popup = () =>
    ({
      closed: false,
      close: vi.fn(),
      location: { replace: vi.fn() },
    }) as unknown as Window & { closed: boolean; close: ReturnType<typeof vi.fn>; location: { replace: ReturnType<typeof vi.fn> } };
  const settlement = (connectorId = "notion") => ({
    ...attempt(connectorId),
    type: "curated_oauth_settlement",
    outcome: "succeeded",
  });

  it("accepts only operator-curated connector ids", () => {
    for (const id of ["notion", "hubspot", "attio", "crm_v2"]) expect(isCuratedConnectorId(id)).toBe(true);
    for (const id of [
      "google_drive",
      "google_calendar",
      "custom_mcp",
      "Notion",
      "1notion",
      "n",
      "no-tion",
      "",
      `a${"b".repeat(64)}`,
      undefined,
      42,
    ])
      expect(isCuratedConnectorId(id)).toBe(false);
    expect(isCuratedPopupAttempt(attempt("google_drive"))).toBe(false);
    expect(isCuratedPopupAttempt(attempt("custom_abc"))).toBe(false);
    expect(() => createCuratedPopupAttempt("google_drive", "synthetic-attempt-id")).toThrow();
    expect(() => createCuratedPopupAttempt("notion", "short")).toThrow();
    expect(createCuratedPopupAttempt("notion", "synthetic-attempt-id")).toMatchObject({
      connectorId: "notion",
      attemptId: "synthetic-attempt-id",
    });
  });
  it("accepts only bounded redacted terminal messages", () => {
    expect(isCuratedPopupSettlement(settlement())).toBe(true);
    for (const patch of [
      { connectorId: "google_drive" },
      { expiresAt: 0 },
      { expiresAt: Date.now() + 660_000 },
      { accessToken: "secret" },
      { outcome: "pending" },
      { type: "drive_oauth_settlement" },
    ])
      expect(isCuratedPopupSettlement({ ...settlement(), ...patch })).toBe(false);
  });
  it("opens the window through the shared opener with a neutral placeholder", () => {
    const target = { document: { title: "", body: { textContent: "" } } } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(target);
    expect(openCuratedOAuthPopup()).toBe(target);
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0]).toBe("about:blank");
    expect(open.mock.calls[0]?.[1]).toMatch(/^one-curated-/);
    expect(target.document.body.textContent).not.toMatch(/notion|hubspot|attio|google/i);
    open.mockReturnValue(null);
    expect(openCuratedOAuthPopup()).toBeNull();
  });
  it("severs the popup's reference back to this window before anything loads in it", () => {
    // A provider's pages are not ours and none is known to send an opener
    // policy: a page in its flow must not be able to navigate this window
    // (window.opener.location = ...) and drop the memory-only vault key.
    const target = { opener: window, document: { title: "", body: { textContent: "" } } } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(target);
    openCuratedOAuthPopup();
    expect(target.opener).toBeNull();
  });
  it("still opens the popup when the opener cannot be cleared", () => {
    const target = { document: { title: "", body: { textContent: "" } } } as unknown as Window;
    Object.defineProperty(target, "opener", { get: () => window, set: () => { throw new Error("read-only"); } });
    vi.spyOn(window, "open").mockReturnValue(target);
    expect(openCuratedOAuthPopup()).toBe(target);
  });
  it("writes the marker from the opener, then navigates the popup", () => {
    const target = popup();
    const current = attempt();
    navigateCuratedOAuthPopup(target, current, AUTHORIZE_URL);
    expect(target.location.replace).toHaveBeenCalledExactlyOnceWith(AUTHORIZE_URL);
    expect(readCuratedPopupAttempt()).toEqual(current);
    expect(window.localStorage.getItem(ATTEMPT_KEY)).not.toContain("signed-state");
  });
  it.each([
    ["a plain-http url", "http://mcp.notion.com/authorize"],
    ["embedded credentials", "https://user:pass@mcp.notion.com/authorize"],
    ["an embedded username", "https://user@mcp.notion.com/authorize"],
    ["this app's own origin", "https://uat.one.hushh.ai/authorize"],
    ["a javascript url", "javascript:alert(1)"],
  ])("refuses %s without writing a marker or navigating", (_label, url) => {
    const target = popup();
    expect(() => navigateCuratedOAuthPopup(target, attempt(), url)).toThrow();
    expect(target.location.replace).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ATTEMPT_KEY)).toBeNull();
  });
  it("refuses a closed popup or an invalid attempt", () => {
    const closed = popup();
    closed.closed = true;
    expect(() => navigateCuratedOAuthPopup(closed, attempt(), AUTHORIZE_URL)).toThrow();
    expect(closed.location.replace).not.toHaveBeenCalled();
    const open = popup();
    expect(() => navigateCuratedOAuthPopup(open, attempt("google_drive"), AUTHORIZE_URL)).toThrow();
    expect(() => navigateCuratedOAuthPopup(open, { ...attempt(), expiresAt: 1 }, AUTHORIZE_URL)).toThrow();
    expect(open.location.replace).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(ATTEMPT_KEY)).toBeNull();
  });
  it("routes only the current attempt's signed-state shape and never a Drive marker", () => {
    const current = attempt();
    window.localStorage.setItem(ATTEMPT_KEY, JSON.stringify(current));
    const state = `${current.attemptId}.${"a".repeat(64)}`;
    expect(isCuratedPopupReturn(state)).toBe(true);
    for (const other of [
      null,
      `another-valid-attempt.${"a".repeat(64)}`,
      `${current.attemptId}.short`,
      `${state}.extra`,
    ])
      expect(isCuratedPopupReturn(other)).toBe(false);
    window.localStorage.clear();
    window.localStorage.setItem(
      "one_drive_popup_attempt_v1",
      JSON.stringify({ ...current, connectorId: "google_drive" }),
    );
    expect(isCuratedPopupReturn(state)).toBe(false);
  });
  it("removes malformed and expired markers before routing", () => {
    const state = `${attempt().attemptId}.${"a".repeat(64)}`;
    for (const marker of [
      "{not-json",
      JSON.stringify({ ...attempt(), expiresAt: Date.now() - 1 }),
      JSON.stringify(attempt("google_drive")),
    ]) {
      window.localStorage.setItem(ATTEMPT_KEY, marker);
      expect(isCuratedPopupReturn(state)).toBe(false);
      expect(window.localStorage.getItem(ATTEMPT_KEY)).toBeNull();
    }
  });
  it("clears only its own attempt when a newer one is stored", () => {
    const prior = attempt();
    const newer = { ...attempt(), attemptId: "newer-synthetic-attempt-id" };
    window.localStorage.setItem(ATTEMPT_KEY, JSON.stringify(newer));
    clearCuratedPopupAttempt(prior);
    expect(readCuratedPopupAttempt()).toEqual(newer);
    clearCuratedPopupAttempt(newer);
    expect(window.localStorage.getItem(ATTEMPT_KEY)).toBeNull();
  });
  it("posts a redacted settlement to the opener with the exact origin and a storage fallback", async () => {
    const postMessage = vi.fn();
    const opener = window.opener;
    Object.defineProperty(window, "opener", { configurable: true, value: { postMessage } });
    try {
      const current = attempt();
      window.localStorage.setItem(ATTEMPT_KEY, JSON.stringify(current));
      notifyCuratedPopup(current, "succeeded");
      expect(postMessage).toHaveBeenCalledExactlyOnceWith(
        { type: "curated_oauth_settlement", ...current, outcome: "succeeded" },
        "https://uat.one.hushh.ai",
      );
      expect(Object.keys(postMessage.mock.calls[0]?.[0] as object).sort()).toEqual(
        ["attemptId", "connectorId", "expiresAt", "outcome", "type"],
      );
      expect(window.localStorage.getItem(ATTEMPT_KEY)).toBeNull();
      expect(window.localStorage.getItem(SETTLEMENT_KEY)).toContain('"outcome":"succeeded"');
      await vi.advanceTimersByTimeAsync(3_000);
      expect(window.localStorage.getItem(SETTLEMENT_KEY)).toBeNull();
    } finally {
      Object.defineProperty(window, "opener", { configurable: true, value: opener });
    }
  });
  it("does not notify for an invalid attempt", () => {
    const postMessage = vi.fn();
    const opener = window.opener;
    Object.defineProperty(window, "opener", { configurable: true, value: { postMessage } });
    try {
      notifyCuratedPopup({ ...attempt("google_drive") }, "succeeded");
      expect(postMessage).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(SETTLEMENT_KEY)).toBeNull();
    } finally {
      Object.defineProperty(window, "opener", { configurable: true, value: opener });
    }
  });
  it("requires exact origin, window, connector and attempt; settles once", async () => {
    const target = popup();
    const done = vi.fn();
    const current = attempt();
    const result = waitForCuratedPopup(target, current, new AbortController().signal).then(done);
    const send = (data: unknown, origin = window.location.origin, source: Window = target) =>
      window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
    send(settlement(), "https://attacker.invalid");
    send(settlement(), window.location.origin, window);
    send({ ...settlement(), attemptId: "other-valid-attempt" });
    send(settlement("hubspot"));
    send({ ...settlement(), type: "drive_oauth_settlement" });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    send({ ...settlement(), expiresAt: current.expiresAt });
    send({ ...settlement(), expiresAt: current.expiresAt });
    await result;
    expect(done).toHaveBeenCalledOnce();
    expect(target.close).toHaveBeenCalledOnce();
  });
  it("accepts the storage fallback only on its own key", async () => {
    const target = popup();
    const current = attempt();
    const done = vi.fn();
    const result = waitForCuratedPopup(target, current, new AbortController().signal).then(done);
    const value = JSON.stringify({ ...current, type: "curated_oauth_settlement", outcome: "succeeded" });
    window.dispatchEvent(new StorageEvent("storage", { key: "one_drive_popup_settlement_v1", newValue: value }));
    window.dispatchEvent(new StorageEvent("storage", { key: SETTLEMENT_KEY, newValue: "{not-json" }));
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: SETTLEMENT_KEY, newValue: value }));
    await result;
    expect(done).toHaveBeenCalledOnce();
  });
  it.each(["abort", "cancel", "expire"])("reconciles %s without claiming provider success", async (kind) => {
    const target = popup();
    const controller = new AbortController();
    const cancel = new AbortController();
    const result = waitForCuratedPopup(target, attempt(), controller.signal, cancel.signal);
    if (kind === "abort") controller.abort();
    else if (kind === "cancel") cancel.abort();
    else await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBeUndefined();
    expect(target.close).toHaveBeenCalledOnce();
  });
});

it("reconciles a closed curated popup promptly and releases its timers", async () => {
  vi.useFakeTimers();
  const target = { closed: false, close: vi.fn() } as unknown as Window;
  const controller = new AbortController();
  const current = createCuratedPopupAttempt("notion", "synthetic-attempt-id");
  let finished = false;
  const result = waitForCuratedPopup(target, current, controller.signal).then(() => { finished = true; });
  Object.assign(target, { closed: true });
  await vi.advanceTimersByTimeAsync(1000);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(finished).toBe(true);
  expect(target.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OAUTH_POPUP_FEATURES,
  openOAuthWindow,
} from "@/lib/connections/oauth-window";
import { openGoogleOAuthPopup } from "@/lib/google/google-oauth-popup";
import { openGmailOAuthPopup } from "@/lib/profile/gmail-oauth-popup";
import { openDriveOAuthPopup } from "@/lib/profile/drive-oauth-popup";

const fakeWindow = () => {
  const store = new Map<string, string>();
  const storage = {
    setItem: (key: string, value: string) => void store.set(key, value),
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => void store.delete(key),
  };
  return {
    close: vi.fn(),
    focus: vi.fn(),
    document: { title: "", body: { textContent: "", style: { cssText: "" } } },
    sessionStorage: storage,
    localStorage: storage,
  } as unknown as Window;
};

describe("openOAuthWindow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prefers a sized popup and never navigates the current window", () => {
    const popup = fakeWindow();
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    const before = window.location.href;
    expect(openOAuthWindow("consent")).toEqual({ target: popup, mode: "popup" });
    expect(open).toHaveBeenCalledExactlyOnceWith("about:blank", "consent", OAUTH_POPUP_FEATURES);
    expect(window.location.href).toBe(before);
  });

  it("falls back to a new tab when the popup is refused", () => {
    const tab = fakeWindow();
    const open = vi
      .spyOn(window, "open")
      .mockImplementation((_url, _target, features) => (features ? null : tab));
    expect(openOAuthWindow("consent")).toEqual({ target: tab, mode: "tab" });
    expect(open).toHaveBeenNthCalledWith(2, "about:blank", "_blank", undefined);
  });

  it("treats a throwing window.open as refused and returns null when both are refused", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => {
      throw new Error("blocked by policy");
    });
    const before = window.location.href;
    expect(openOAuthWindow("consent")).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
    expect(window.location.href).toBe(before);
  });

  it.each([
    ["Calendar", () => openGoogleOAuthPopup({ version: 1, attemptId: "synthetic-calendar-attempt", service: "calendar", startedAt: Date.now(), ownerId: "owner" })],
    ["Mail", () => openGmailOAuthPopup({ version: 1, attemptId: "synthetic-mail-attempt", startedAt: Date.now(), ownerId: "owner", purpose: "read" })],
    ["Drive", () => openDriveOAuthPopup()],
  ])("%s uses the same popup-then-tab opener", (_name, openConnector) => {
    const tab = fakeWindow();
    const open = vi
      .spyOn(window, "open")
      .mockImplementation((_url, _target, features) => (features ? null : tab));
    expect(openConnector()).toBe(tab);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith("about:blank", "_blank", undefined);
  });
});

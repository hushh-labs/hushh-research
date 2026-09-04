import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearGmailOAuthPopupAttempt,
  openGmailOAuthPopup,
  readGmailOAuthPopupAttempt,
  type GmailOAuthPopupAttempt,
} from "@/lib/profile/gmail-oauth-popup";

const FALLBACK_ATTEMPT_KEY = "one_gmail_oauth_popup_attempt_fallback_v1";

function makeStorage(options?: { throwOnSet?: boolean }): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (options?.throwOnSet) {
        throw new Error("storage blocked");
      }
      values.set(key, value);
    },
  };
}

function makeAttempt(): GmailOAuthPopupAttempt {
  return {
    version: 1,
    attemptId: "gmail-ios-test",
    startedAt: Date.now(),
  };
}

describe("gmail-oauth-popup", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("keeps the retained popup open when sessionStorage is blocked but localStorage works", () => {
    const attempt = makeAttempt();
    const fallbackStorage = makeStorage();
    const popup = {
      close: vi.fn(),
      document: { title: "" },
      focus: vi.fn(),
      localStorage: fallbackStorage,
      sessionStorage: makeStorage({ throwOnSet: true }),
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    expect(openGmailOAuthPopup(attempt)).toBe(popup);

    expect(popup.close).not.toHaveBeenCalled();
    expect(fallbackStorage.getItem(FALLBACK_ATTEMPT_KEY)).toBe(
      JSON.stringify(attempt),
    );
  });

  it("shows progress instead of leaving the trusted popup blank", () => {
    const attempt = makeAttempt();
    const popup = {
      close: vi.fn(),
      document: {
        title: "",
        body: { textContent: "", style: { cssText: "" } },
      },
      focus: vi.fn(),
      localStorage: makeStorage(),
      sessionStorage: makeStorage(),
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);

    openGmailOAuthPopup(attempt);

    expect(popup.document.title).toBe("Connecting Gmail");
    expect(popup.document.body?.textContent).toBe("Opening secure Google sign-in…");
  });

  it("keeps the retained popup open when reading sessionStorage itself throws", () => {
    const attempt = makeAttempt();
    const fallbackStorage = makeStorage();
    const popup = {
      close: vi.fn(),
      document: { title: "" },
      focus: vi.fn(),
      localStorage: fallbackStorage,
    } as unknown as Window;
    Object.defineProperty(popup, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("sessionStorage getter blocked");
      },
    });
    vi.spyOn(window, "open").mockReturnValue(popup);

    expect(openGmailOAuthPopup(attempt)).toBe(popup);

    expect(popup.close).not.toHaveBeenCalled();
    expect(fallbackStorage.getItem(FALLBACK_ATTEMPT_KEY)).toBe(
      JSON.stringify(attempt),
    );
  });

  it("reads and clears the fallback popup attempt marker", () => {
    const attempt = makeAttempt();
    window.localStorage.setItem(FALLBACK_ATTEMPT_KEY, JSON.stringify(attempt));

    expect(readGmailOAuthPopupAttempt()).toEqual(attempt);

    clearGmailOAuthPopupAttempt();
    expect(readGmailOAuthPopupAttempt()).toBeNull();
  });
});

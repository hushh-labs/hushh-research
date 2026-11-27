import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearGmailConnectReturn,
  readGmailConnectReturn,
  rememberGmailConnectReturn,
} from "@/lib/profile/gmail-connect-return";

const KEY = "hushh.gmail.connect_return.v1";

describe("where a full-page Mail sign-in returns to", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("remembers only an owner, the KYC route and a time, never a code, state or address", () => {
    rememberGmailConnectReturn("owner-1", "/one/kyc");

    const stored = JSON.parse(window.sessionStorage.getItem(KEY)!);
    expect(Object.keys(stored).sort()).toEqual(["ownerId", "returnTo", "startedAt", "version"]);
    expect(stored).toMatchObject({ version: 1, ownerId: "owner-1", returnTo: "/one/kyc" });
    expect(readGmailConnectReturn("owner-1")).toBe("/one/kyc");
  });

  it("returns nothing for a connection that started anywhere else", () => {
    expect(readGmailConnectReturn("owner-1")).toBeNull();
  });

  it("belongs to one owner: another owner's mark is discarded, not honored", () => {
    rememberGmailConnectReturn("owner-1", "/one/kyc");

    expect(readGmailConnectReturn("owner-2")).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("is kept for the sign-in that precedes the callback, when the owner is not known yet", () => {
    rememberGmailConnectReturn("owner-1", "/one/kyc");

    expect(readGmailConnectReturn(null)).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).not.toBeNull();
    expect(readGmailConnectReturn("owner-1")).toBe("/one/kyc");
  });

  it("expires after fifteen minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00Z"));
    rememberGmailConnectReturn("owner-1", "/one/kyc");

    vi.setSystemTime(new Date("2026-11-26T10:14:00Z"));
    expect(readGmailConnectReturn("owner-1")).toBe("/one/kyc");
    vi.setSystemTime(new Date("2026-11-26T10:16:00Z"));
    expect(readGmailConnectReturn("owner-1")).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it.each([
    ["an external address", "https://evil.example/one/kyc"],
    ["another app route", "/one/gmail"],
    ["a path that only starts like KYC", "/one/kyc/../profile"],
    ["nothing", ""],
  ])("never honors %s as a place to return to", (_label, returnTo) => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, ownerId: "owner-1", returnTo, startedAt: Date.now() }),
    );

    expect(readGmailConnectReturn("owner-1")).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("discards unreadable or old-format state", () => {
    window.sessionStorage.setItem(KEY, "{not json");
    expect(readGmailConnectReturn("owner-1")).toBeNull();
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ version: 2, ownerId: "owner-1", returnTo: "/one/kyc", startedAt: Date.now() }),
    );
    expect(readGmailConnectReturn("owner-1")).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("clears on request, and does not throw when session storage is unavailable", () => {
    rememberGmailConnectReturn("owner-1", "/one/kyc");
    clearGmailConnectReturn();
    expect(readGmailConnectReturn("owner-1")).toBeNull();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberGmailConnectReturn("owner-1", "/one/kyc")).not.toThrow();
    expect(() => clearGmailConnectReturn()).not.toThrow();
    vi.restoreAllMocks();
  });
});

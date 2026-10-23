/**
 * Resuming an approved Azure update ("Continue to Microsoft sign-in") signs in
 * beside the app, like setup, and the hand-back tells the opening tab which
 * update job to follow. The return page passes `inPlace`, because it already
 * is the popup.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: vi.fn(() => false),
  assign: vi.fn(),
  upgrade: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: mocks.native } }));
vi.mock("@/lib/utils/browser-navigation", () => ({ assignWindowLocation: mocks.assign }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { beginAzureByocUpgrade: mocks.upgrade, beginAzureByocAuthorize: vi.fn() },
}));

import {
  AZURE_SIGN_IN_CHANNEL,
  UPDATE_POPUP_CLOSED_NOTICE,
  announceAzureSetupStarted,
  captureSignInPopupOwner,
  openSignInPopup,
  useAzureSetupStartedSignal,
  useAzureSignIn,
} from "@/lib/one/azure-sign-in";
import { announceAzureCleanupReturn, listenForAzureCleanupReturn } from "@/lib/one/azure-cleanup-return";

const SIGN_IN = "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=u";

let popup: { closed: boolean; location: { assign: ReturnType<typeof vi.fn> }; focus: () => void; close: () => void };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native.mockReturnValue(false);
  mocks.upgrade.mockResolvedValue({ authorizationUrl: SIGN_IN });
  popup = { closed: false, location: { assign: vi.fn() }, focus: vi.fn(), close: vi.fn() };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the update sign-in beside the app", () => {
  it("retires an older cleanup's ownership when another action reuses the named popup", () => {
    const first = openSignInPopup();
    const original = captureSignInPopupOwner(first);
    expect(original()).toBe(true);
    expect(openSignInPopup()).toBe(first);
    expect(original()).toBe(false);
    expect(captureSignInPopupOwner(first)()).toBe(true);
  });
  it("hands cleanup back only to the current owner, operation and phase, without triggering setup", async () => {
    const expected = { ownerId: "owner", operationId: "cleanup-1", phase: "execute" as const };
    const refresh = vi.fn(); const setup = vi.fn(); let current = true;
    renderHook(() => useAzureSetupStartedSignal(setup));
    const stop = listenForAzureCleanupReturn(expected, () => current, refresh);
    try {
      for (const changed of [{ ownerId: "other" }, { operationId: "old" }, { phase: "inspect" as const }]) {
        await expect(announceAzureCleanupReturn({ ...expected, ...changed }, new AbortController().signal, 40)).resolves.toBe(false);
      }
      expect(refresh).not.toHaveBeenCalled(); expect(setup).not.toHaveBeenCalled();
      await expect(announceAzureCleanupReturn(expected, new AbortController().signal, 1000)).resolves.toBe(true);
      await expect(announceAzureCleanupReturn(expected, new AbortController().signal, 1000)).resolves.toBe(true);
      expect(refresh).toHaveBeenCalledTimes(1);
      current = false;
      await expect(announceAzureCleanupReturn(expected, new AbortController().signal, 40)).resolves.toBe(false);
    } finally { stop(); }
  });

  it("disposes a cancelled cleanup announcement without an acknowledgement or focus change", async () => {
    const abort = new AbortController();
    const focus = vi.spyOn(window, "focus");
    const announced = announceAzureCleanupReturn({ ownerId: "owner", operationId: "cleanup-1", phase: "inspect" }, abort.signal, 1000);
    abort.abort();
    await expect(announced).resolves.toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  it("opens the update sign-in in a popup and words an early close for the update", async () => {
    const { result } = renderHook(() => useAzureSignIn());
    await act(async () => {
      await result.current.start("upgrade");
    });
    expect(popup.location.assign).toHaveBeenCalledWith(SIGN_IN);
    expect(mocks.assign).not.toHaveBeenCalled();
    popup.closed = true;
    await waitFor(() => expect(result.current.notice).toBe(UPDATE_POPUP_CLOSED_NOTICE), { timeout: 3000 });
  });

  it("keeps the sign-in in this window on the return page, which already is the popup", async () => {
    const { result } = renderHook(() => useAzureSignIn({ inPlace: true }));
    await act(async () => {
      await result.current.start("upgrade");
    });
    expect(window.open).not.toHaveBeenCalled();
    expect(mocks.assign).toHaveBeenCalledWith(SIGN_IN);
  });

  it("hands back which update job started, and setup stays as it was", async () => {
    const heard: unknown[] = [];
    renderHook(() => useAzureSetupStartedSignal((started) => heard.push(started)));
    await expect(announceAzureSetupStarted({ upgradeJobId: "job-3", timeoutMs: 2000 })).resolves.toBe(true);
    await expect(announceAzureSetupStarted({ timeoutMs: 2000 })).resolves.toBe(true);
    await waitFor(() => expect(heard).toContainEqual({ kind: "setup", jobId: null }));
    expect(heard[0]).toEqual({ kind: "upgrade", jobId: "job-3" });
    // Same-origin only, and it never carries a code or a token.
    const spy = new BroadcastChannel(AZURE_SIGN_IN_CHANNEL);
    const raw: unknown[] = [];
    spy.onmessage = (event) => raw.push(event.data);
    await announceAzureSetupStarted({ upgradeJobId: "job-4", timeoutMs: 2000 });
    spy.close();
    expect(raw[0]).toEqual({ type: "azure-setup-started", kind: "upgrade", jobId: "job-4" });
  });

  it("neither acts on nor answers a hand-back of a kind the tab does not follow", async () => {
    const setupHeard: unknown[] = [];
    const updateHeard: unknown[] = [];
    renderHook(() => useAzureSetupStartedSignal((started) => setupHeard.push(started), "setup"));
    // Nobody follows the update: its popup must hear no answer and keep its own progress.
    await expect(announceAzureSetupStarted({ upgradeJobId: "job-5", timeoutMs: 1200 })).resolves.toBe(false);
    expect(setupHeard).toEqual([]);

    renderHook(() => useAzureSetupStartedSignal((started) => updateHeard.push(started), "upgrade"));
    await expect(announceAzureSetupStarted({ upgradeJobId: "job-6", timeoutMs: 2000 })).resolves.toBe(true);
    await waitFor(() => expect(updateHeard).toEqual([{ kind: "upgrade", jobId: "job-6" }]));
    expect(setupHeard).toEqual([]);
    await expect(announceAzureSetupStarted({ timeoutMs: 2000 })).resolves.toBe(true);
    await waitFor(() => expect(setupHeard).toEqual([{ kind: "setup", jobId: null }]));
    expect(updateHeard).toHaveLength(1);
  });
});

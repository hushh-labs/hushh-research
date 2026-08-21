// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";

import {
  ShareUnavailableError,
  isShareCancellationError,
  shareLink,
} from "@/lib/share/share-link";
import { copyToClipboard } from "@/lib/utils/clipboard";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn() },
}));

vi.mock("@capacitor/share", () => ({
  Share: { share: vi.fn() },
}));

vi.mock("@/lib/utils/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

const payload = {
  title: "Join me on One",
  text: "Join me on One so we can connect.",
  dialogTitle: "Invite to One",
  url: "https://one.hushh.ai/",
};

function setWebShare(handler: ((data: ShareData) => Promise<void>) | null) {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    writable: true,
    value: handler ?? undefined,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  setWebShare(null);
});

describe("shareLink on the installed iOS and Android apps", () => {
  it("uses the native sheet and reports it", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Share.share).mockResolvedValue({} as never);

    await expect(shareLink(payload)).resolves.toBe("native-share");
    expect(Share.share).toHaveBeenCalledWith({
      title: payload.title,
      text: payload.text,
      dialogTitle: payload.dialogTitle,
      url: payload.url,
    });
  });

  it("prefers the native sheet even where Web Share also exists", async () => {
    // Android's webview exposes navigator.share. Inside the shell the native
    // sheet is still the right one -- it is the sheet the OS themes and the
    // one the person expects from every other app on the device.
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Share.share).mockResolvedValue({} as never);
    const webShare = vi.fn().mockResolvedValue(undefined);
    setWebShare(webShare);

    await expect(shareLink(payload)).resolves.toBe("native-share");
    expect(webShare).not.toHaveBeenCalled();
  });

  it("omits url entirely when there is no link, rather than sending undefined", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Share.share).mockResolvedValue({} as never);

    await shareLink({ ...payload, url: undefined });
    expect(Share.share).toHaveBeenCalledWith(
      expect.not.objectContaining({ url: expect.anything() }),
    );
  });

  it("treats a whitespace-only url as no url", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Share.share).mockResolvedValue({} as never);

    await shareLink({ ...payload, url: "   " });
    expect(Share.share).toHaveBeenCalledWith(
      expect.not.objectContaining({ url: expect.anything() }),
    );
  });
});

describe("shareLink on the web", () => {
  it("uses Web Share where the browser has it", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    const webShare = vi.fn().mockResolvedValue(undefined);
    setWebShare(webShare);

    await expect(shareLink(payload)).resolves.toBe("web-share");
    expect(webShare).toHaveBeenCalledWith({
      title: payload.title,
      text: payload.text,
      url: payload.url,
    });
  });

  it("falls back to the clipboard on a desktop browser without Web Share", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    await expect(shareLink(payload)).resolves.toBe("copied");
    // The link has to survive the fallback: on this rung nothing appends it,
    // so text alone would put an invite with no way in on the clipboard.
    expect(copyToClipboard).toHaveBeenCalledWith(
      `${payload.text}\n${payload.url}`,
    );
  });

  it("copies the text alone when there is no link", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    await shareLink({ ...payload, url: undefined });
    expect(copyToClipboard).toHaveBeenCalledWith(payload.text);
  });

  it("throws ShareUnavailableError when every rung is missing", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.mocked(copyToClipboard).mockResolvedValue(false);

    await expect(shareLink(payload)).rejects.toBeInstanceOf(
      ShareUnavailableError,
    );
  });

  it("does not mistake an unavailable device for a cancelled share", async () => {
    // These two are the whole reason the caller branches: one is silent, the
    // other has to say something.
    expect(isShareCancellationError(new ShareUnavailableError())).toBe(false);
  });
});

describe("isShareCancellationError", () => {
  it("recognises the Web Share abort", () => {
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    expect(isShareCancellationError(abort)).toBe(true);
  });

  it("recognises the Capacitor cancellation, in both spellings", () => {
    expect(isShareCancellationError(new Error("Share canceled"))).toBe(true);
    expect(isShareCancellationError(new Error("Share cancelled"))).toBe(true);
    expect(isShareCancellationError(new Error("  share CANCELLED  "))).toBe(
      true,
    );
  });

  it("does not swallow a real failure", () => {
    expect(isShareCancellationError(new Error("Network request failed"))).toBe(
      false,
    );
    expect(isShareCancellationError(null)).toBe(false);
    expect(isShareCancellationError(undefined)).toBe(false);
    expect(isShareCancellationError("Share cancelled")).toBe(false);
  });
});

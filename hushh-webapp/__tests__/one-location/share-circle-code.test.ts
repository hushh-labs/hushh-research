// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";

import {
  circleShareLabel,
  isShareCancellationError,
  shareNamedCircleCode,
} from "@/lib/one-location/share-circle-code";
import { copyToClipboard } from "@/lib/utils/clipboard";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: vi.fn(),
  },
}));

vi.mock("@capacitor/share", () => ({
  Share: {
    share: vi.fn(),
  },
}));

vi.mock("@/lib/utils/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

const payload = {
  title: "Join Meena Family on One",
  text: "Use code 2345-6789-ABCD. Joining does not share your location automatically.",
  dialogTitle: "Share Circle code",
};

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: undefined,
  });
});

describe("Circle code sharing parity", () => {
  it("uses the native share sheet on both Capacitor mobile platforms", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);

    await expect(shareNamedCircleCode(payload)).resolves.toBe("native-share");
    expect(Share.share).toHaveBeenCalledWith(payload);
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("treats Capacitor's iOS and Android dismissal error as cancellation", () => {
    expect(isShareCancellationError(new Error("Share canceled"))).toBe(true);
    expect(
      isShareCancellationError(new DOMException("Cancelled", "AbortError")),
    ).toBe(true);
    expect(
      isShareCancellationError(new Error("Native share unavailable")),
    ).toBe(false);
  });

  it("uses Web Share when the browser supports it", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    const webShare = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: webShare,
    });

    await expect(shareNamedCircleCode(payload)).resolves.toBe("web-share");
    expect(webShare).toHaveBeenCalledWith({
      title: payload.title,
      text: payload.text,
    });
  });

  it("falls back to the shared clipboard without adding the code to a URL", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    await expect(shareNamedCircleCode(payload)).resolves.toBe("copied");
    expect(copyToClipboard).toHaveBeenCalledWith(payload.text);
    expect(payload.text).not.toContain("http");
  });

  const payloadWithUrl = {
    ...payload,
    url: "https://uat.one.hushh.ai/circle/join?code=2345-6789-ABCD",
  };

  it("passes the join link to the native share sheet when provided", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);

    await expect(shareNamedCircleCode(payloadWithUrl)).resolves.toBe(
      "native-share",
    );
    expect(Share.share).toHaveBeenCalledWith(payloadWithUrl);
  });

  it("passes the join link to Web Share when provided", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    const webShare = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: webShare,
    });

    await expect(shareNamedCircleCode(payloadWithUrl)).resolves.toBe(
      "web-share",
    );
    expect(webShare).toHaveBeenCalledWith({
      title: payload.title,
      text: payload.text,
      url: payloadWithUrl.url,
    });
  });

  it("appends the join link to the clipboard fallback when provided", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.mocked(copyToClipboard).mockResolvedValue(true);

    await expect(shareNamedCircleCode(payloadWithUrl)).resolves.toBe("copied");
    expect(copyToClipboard).toHaveBeenCalledWith(
      `${payload.text}\n${payloadWithUrl.url}`,
    );
  });

  it("carries the join link exactly once across every delivery path", async () => {
    // WhatsApp/Messages append `url` to `text`, so a link repeated inside the
    // text is delivered twice. Every path must yield exactly one occurrence.
    const occurrences = (value: string) =>
      value.split(payloadWithUrl.url).length - 1;

    expect(occurrences(payloadWithUrl.text)).toBe(0);

    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    await shareNamedCircleCode(payloadWithUrl);
    const native = vi.mocked(Share.share).mock.calls[0]![0]!;
    expect(
      occurrences(`${native.text ?? ""}${native.url ?? ""}`),
    ).toBe(1);

    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.mocked(copyToClipboard).mockResolvedValue(true);
    await shareNamedCircleCode(payloadWithUrl);
    expect(
      occurrences(vi.mocked(copyToClipboard).mock.calls[0]![0]!),
    ).toBe(1);
  });
});

describe("circleShareLabel", () => {
  it("only appends 'Circle' when the name does not already end in it", () => {
    // Onboarding names every first Circle `<First>'s Circle`, which used to be
    // delivered as "JHUMMA's Circle Circle".
    expect(circleShareLabel("JHUMMA's Circle")).toBe("JHUMMA's Circle");
    expect(circleShareLabel("  Family circles  ")).toBe("Family circles");
    expect(circleShareLabel("K Family")).toBe("K Family Circle");
    // "Encircle" ends in the letters but is not the word.
    expect(circleShareLabel("Encircle")).toBe("Encircle Circle");
    expect(circleShareLabel("   ")).toBe("Circle");
  });
});

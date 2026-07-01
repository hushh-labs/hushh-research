import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "@/lib/utils/clipboard";

describe("copyToClipboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("removes fallback textarea after failed execCommand copy", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });

    await expect(copyToClipboard("copy me")).resolves.toBe(false);

    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
  it("uses navigator clipboard when available", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  await expect(copyToClipboard("copy me")).resolves.toBe(true);

  expect(writeText).toHaveBeenCalledWith("copy me");
});
});

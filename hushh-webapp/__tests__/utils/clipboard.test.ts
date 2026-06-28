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
    vi.spyOn(document, "execCommand").mockReturnValue(false);

    await expect(copyToClipboard("copy me")).resolves.toBe(false);

    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });
});

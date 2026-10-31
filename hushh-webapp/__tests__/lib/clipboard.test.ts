// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "@/lib/utils/clipboard";

afterEach(() => vi.unstubAllGlobals());

describe("session-scoped clipboard recovery", () => {
  it("does not copy an already dismissed draft", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyToClipboard("old invitation", () => false)).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "only starts a fallback while the draft is still current: %s",
    async (keepCurrent) => {
      let reject!: (error: Error) => void;
      const writeText = vi.fn().mockReturnValue(
        new Promise((_, no) => {
          reject = no;
        }),
      );
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const execCommand = vi.fn().mockReturnValue(true);
      const original = Object.getOwnPropertyDescriptor(document, "execCommand");
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: execCommand,
      });
      let current = true;
      try {
        const pending = copyToClipboard("invitation", () => current);
        expect(writeText).toHaveBeenCalledExactlyOnceWith("invitation");
        current = keepCurrent;
        reject(new Error("Clipboard API unavailable"));
        expect(await pending).toBe(keepCurrent);
        expect(execCommand).toHaveBeenCalledTimes(keepCurrent ? 1 : 0);
        expect(document.querySelector("textarea")).toBeNull();
      } finally {
        if (original) Object.defineProperty(document, "execCommand", original);
        else Reflect.deleteProperty(document, "execCommand");
      }
    },
  );
});

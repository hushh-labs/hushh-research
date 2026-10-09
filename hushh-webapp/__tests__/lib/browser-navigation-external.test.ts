import { afterEach, describe, expect, it, vi } from "vitest";

import { openExternalUrlWhenResolved } from "@/lib/utils/browser-navigation";

type FakeTab = { opener: unknown; closed: boolean; location: { replace: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> };

function fakeTab(): FakeTab {
  const tab: FakeTab = {
    opener: window,
    closed: false,
    location: { replace: vi.fn() },
    close: vi.fn(() => {
      tab.closed = true;
    }),
  };
  return tab;
}

describe("openExternalUrlWhenResolved", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens the tab straight from the click, then points it at the resolved link", async () => {
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    let resolveUrl: (url: string) => void = () => undefined;
    const pending = openExternalUrlWhenResolved(
      () => new Promise<string>((resolve) => (resolveUrl = resolve)),
    );
    // Opened before the lookup finished, which is what a browser requires.
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).not.toHaveBeenCalled();

    resolveUrl("https://invoice.stripe.com/i/acct_1/live_a");
    await pending;
    expect(tab.location.replace).toHaveBeenCalledWith("https://invoice.stripe.com/i/acct_1/live_a");
  });

  it("closes the tab and reports the failure when the link cannot be resolved", async () => {
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    await expect(
      openExternalUrlWhenResolved(() => Promise.reject(new Error("no longer available"))),
    ).rejects.toThrow("no longer available");
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it("still opens the link when the browser blocked the early tab", async () => {
    const open = vi.spyOn(window, "open").mockReturnValueOnce(null).mockReturnValue(null);
    await openExternalUrlWhenResolved(async () => "https://billing.example.test/invoices/1");
    expect(open).toHaveBeenLastCalledWith(
      "https://billing.example.test/invoices/1",
      "_blank",
      "noopener,noreferrer",
    );
  });
});

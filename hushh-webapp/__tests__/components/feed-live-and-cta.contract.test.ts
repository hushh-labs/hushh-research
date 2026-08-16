import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Source contracts for four fixes that a render test cannot reach: a CSS paint
 * rule, a cache flag threaded through a callback, a timer's owner, and the
 * absence of a fabricated sort key.
 */

const WEBAPP_ROOT = path.resolve(__dirname, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(WEBAPP_ROOT, relativePath), "utf8");
}

describe("top chrome paints its own background", () => {
  it("has no priming gate holding the header transparent", () => {
    const styles = read("app/globals.css");

    // `data-ambient-chrome-primed` was never set by anything in the app, so
    // `html:not([data-ambient-chrome-primed="true"])` matched forever — and at
    // (0,2,1) it beat the (0,1,0) `.ambient-chrome-mask--top` rule. The top bar
    // mixed its background to 0%: the page scrolled visibly through the title.
    expect(styles).not.toContain("[data-ambient-chrome-primed");
    expect(styles).not.toContain("--ambient-chrome-wash: 0%");

    // The intended material still applies, unchanged.
    expect(styles).toContain(
      "--ambient-chrome-wash: var(--ambient-chrome-fade-solid)",
    );
    expect(styles).toContain("--ambient-chrome-fade-solid: 94%");
  });
});

describe("Feed stays live", () => {
  it("forwards the force flag so a refresh is not answered from cache", () => {
    const feedPage = read("components/feed/feed-page.tsx");

    // FeedService keeps its own short-TTL cache in front of the request, so a
    // load that drops `force` returns the page it already had.
    expect(feedPage).toContain("load: async (options)");
    expect(feedPage).toContain("force: options?.force");
    expect(feedPage).toContain("refresh({ force: true })");
  });

  it("owns its cadence in a hook, not a timer inside the component", () => {
    const feedPage = read("components/feed/feed-page.tsx");
    const actionables = read("lib/feed/use-feed-actionables.ts");
    const unreadCount = read("lib/feed/use-feed-unread-count.ts");

    expect(feedPage).not.toContain("setInterval(");
    expect(actionables).not.toContain("setInterval(");
    expect(unreadCount).not.toContain("setInterval(");

    // One signal for the list, the "Needs you" lane, and the tab badge, so the
    // badge can never claim unread items over a list that never re-asked.
    for (const source of [feedPage, actionables, unreadCount]) {
      expect(source).toContain("useFeedLiveRefresh");
    }
  });

  it("never fabricates a sort key that moves on every recompute", () => {
    const actionables = read("lib/feed/use-feed-actionables.ts");

    // `sortAt: Date.now()` minted a new "now" each time the memo ran, so rows
    // without a real timestamp leapt back above rows that had one — every 45s,
    // now that the list actually refreshes.
    expect(actionables).not.toMatch(/sortAt:[^,\n]*Date\.now\(\)/);
    expect(actionables).toContain("firstSeenAt(");
  });
});

describe("the ask flow's primary action keeps the action colour", () => {
  it("never repaints Send with the success token", () => {
    const hub = read("components/one-location/redesign/location-redesign-hub.tsx");

    const sendButton = hub.slice(
      hub.indexOf("const isFormValid = vm.selectedRequestOwnerIds.length > 0"),
      hub.indexOf('"Send request"'),
    );
    expect(sendButton.length).toBeGreaterThan(0);
    expect(sendButton).toContain("bg-[color:var(--app-accent)]");
    // Green is a status, and this screen already says it twice — in the banner
    // above and in each person's row turning to "Asked".
    expect(sendButton).not.toContain("--app-success");
  });

  it("re-arms Send from the selection instead of latching it shut", () => {
    const hub = read("components/one-location/redesign/location-redesign-hub.tsx");

    expect(hub).toContain("sentSelectionRef");
    expect(hub).toContain("setJustSent(await vm.onSendRequest(reason))");
    // The latch must not be part of what disables the button, or one send
    // retires the control for the life of the screen.
    expect(hub).not.toContain("disabled={!isFormValid || sending || justSent}");
  });
});

describe("quick-action tones come from tokens", () => {
  it("uses the semantic colour variables rather than light-mode hexes", () => {
    const quickActions = read("components/one-location/redesign/quick-actions.tsx");

    expect(quickActions).not.toContain("#34C759");
    expect(quickActions).not.toContain("#FF3B30");
    expect(quickActions).toContain("var(--app-success)");
    expect(quickActions).toContain("var(--app-destructive)");
  });
});

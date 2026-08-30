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

  it("proves Feed through warm same-session navigation", () => {
    const verifier = read("scripts/testing/verify-signed-in-routes.mjs");

    expect(verifier).toContain("SAME_SESSION_SHELL_ROUTES = new Set([");
    expect(verifier).toMatch(
      /SAME_SESSION_SHELL_ROUTES = new Set\(\[[\s\S]*?"\/one\/feed"/,
    );
    expect(verifier).toContain('case "/one/feed":');
    expect(verifier).toContain('requestAppNavigation(page, "/one/feed")');
  });

  it("keys the whole Feed session to the authenticated account", () => {
    const feedPage = read("components/feed/feed-page.tsx");

    expect(feedPage).toContain('key={user?.uid ?? "signed-out"}');
  });

  it("reports real Feed readiness through the native route beacon", () => {
    const route = read("app/one/feed/page.tsx");
    const feedPage = read("components/feed/feed-page.tsx");

    expect(route).not.toContain('dataState="loaded"');
    expect(feedPage).toContain("const beaconDataState = contentLoading");
    expect(feedPage).toContain(
      'errorCode={showColdError ? "FEED_LOAD_FAILED" : null}',
    );
  });
});

describe("the ask flow's primary action keeps the action colour", () => {
  it("never repaints Send with the success token", () => {
    const hub = read(
      "components/one-location/redesign/location-redesign-hub.tsx",
    );

    const sendButton =
      hub.match(
        /<Button\s+onClick=\{sendRequest\}[\s\S]*?>\s*Send request\s*<\/Button>/,
      )?.[0] ?? "";
    expect(sendButton.length).toBeGreaterThan(0);
    expect(sendButton).toContain("bg-[color:var(--app-accent)]");
    // Green is a status, and the outcome is already said twice elsewhere —
    // the Sonner toast the send raises, and each person's row turning to
    // "Asked". A third telling on the button would be the one that cannot be
    // dismissed.
    expect(sendButton).not.toContain("--app-success");
  });

  it("re-arms Send from the selection instead of latching it shut", () => {
    const hub = read(
      "components/one-location/redesign/location-redesign-hub.tsx",
    );

    // Reported from the field as "can't send req to rest after 1 cycle".
    // The guarantee used to be "the latch is cleared when a new person is
    // picked"; it is now the stronger "there is no latch". `justSent` and the
    // `sentSelectionRef` that retired it went with the confirmation banner —
    // see the Request-sent contract in one-location-copy-pass.
    expect(hub).not.toMatch(/const \[justSent/);
    expect(hub).not.toMatch(/setJustSent\(/);
    expect(hub).not.toContain("sentSelectionRef");

    // What Send is allowed to depend on: the current selection, and whether a
    // send is already in flight. Nothing that outlives one round.
    expect(hub).toContain(
      "disabled={!isRequestFormValid || sendingRequest}",
    );
    // And the step still advances only on a resolved success, so a failed send
    // cannot present as a completed one.
    expect(hub).toContain("const sent = await vm.onSendRequest(reason)");
    expect(hub).toContain("if (sent) setStep(\"person\")");
  });
});

describe("quick-action tones come from tokens", () => {
  it("uses the semantic colour variables rather than light-mode hexes", () => {
    const quickActions = read(
      "components/one-location/redesign/quick-actions.tsx",
    );

    expect(quickActions).not.toContain("#34C759");
    expect(quickActions).not.toContain("#FF3B30");
    expect(quickActions).toContain("var(--app-success)");
    expect(quickActions).toContain("var(--app-destructive)");
  });
});

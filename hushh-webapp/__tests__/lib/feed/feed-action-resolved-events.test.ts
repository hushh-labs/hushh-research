import { describe, expect, it, vi } from "vitest";

import {
  CONSENT_STATE_CHANGED_EVENT,
} from "@/lib/consent/consent-events";
import {
  FEED_STATE_CHANGED_EVENT,
} from "@/lib/feed/feed-events";
import {
  notifyFeedActionResolved,
} from "@/lib/feed/use-feed-actionables";

describe("notifyFeedActionResolved", () => {
  it("refreshes both inputs of the Feed navigation badge immediately", () => {
    const consentListener = vi.fn();
    const feedListener = vi.fn();

    window.addEventListener(
      CONSENT_STATE_CHANGED_EVENT,
      consentListener,
    );
    window.addEventListener(
      FEED_STATE_CHANGED_EVENT,
      feedListener,
    );

    try {
      notifyFeedActionResolved();

      expect(consentListener).toHaveBeenCalledTimes(1);
      expect(feedListener).toHaveBeenCalledTimes(1);

      const event =
        consentListener.mock.calls[0]?.[0] as CustomEvent;

      expect(event.detail).toEqual({
        source: "feed_actionable",
      });
    } finally {
      window.removeEventListener(
        CONSENT_STATE_CHANGED_EVENT,
        consentListener,
      );
      window.removeEventListener(
        FEED_STATE_CHANGED_EVENT,
        feedListener,
      );
    }
  });
});

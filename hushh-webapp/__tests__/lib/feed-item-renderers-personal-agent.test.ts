import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * The private-agent lifecycle rows are the only place a person watches their own
 * agent being created, so an unrendered event type is not a cosmetic gap — it shows
 * "Something happened in your account", which is worse than silence.
 *
 * These assert the whole vocabulary the backend emits, so adding an event type
 * without a case here fails rather than quietly falling through to the default.
 */

// Mirrors the constants in personal_agent_provisioning_service.py.
const BACKEND_EVENT_TYPES = [
  "personal_agent_reserved",
  "personal_agent_provisioning",
  "personal_agent_ready",
  "personal_agent_failed",
  "personal_agent_provisioning_capped",
  "personal_agent_reaped",
] as const;

function item(eventType: string, metadata: Record<string, unknown> = {}): FeedItem {
  return {
    id: "feed-1",
    source_domain: "consent",
    event_type: eventType,
    actor_label: null,
    metadata,
    read: false,
    created_at: "2026-08-03T00:00:00Z",
  };
}

const GENERIC_FALLBACK = "Something happened in your account.";

describe("private-agent feed rows", () => {
  it("renders every event type the backend emits, never the generic fallback", () => {
    for (const eventType of BACKEND_EVENT_TYPES) {
      const p = presentFeedItem(item(eventType));
      expect(p.domainLabel, `${eventType} domain label`).toBe("Private agent");
      expect(p.description, `${eventType} fell through to the default`).not.toBe(
        GENERIC_FALLBACK,
      );
      expect(p.label.length, `${eventType} label`).toBeGreaterThan(0);
    }
  });

  it("presents the fleet cap as a queue, not a failure", () => {
    // The cap is our constraint and the row stays pending, so telling the person
    // something went wrong would be false.
    const p = presentFeedItem(item("personal_agent_provisioning_capped"));
    expect(p.label).toContain("queue");
    expect(p.description).toContain("starts automatically");
    expect(p.href).toBeNull();
  });

  it("says a reaped pod is resting, never deleted", () => {
    // Only compute is torn down; identity and registry row survive.
    const p = presentFeedItem(item("personal_agent_reaped"));
    expect(p.description).not.toMatch(/delet|remov|lost/i);
    expect(p.href).not.toBeNull();
  });

  it("never renders a raw reason code for a failure", () => {
    const p = presentFeedItem(
      item("personal_agent_failed", { reason: "traceback: KeyError('token')" }),
    );
    expect(p.description).not.toContain("KeyError");
    expect(p.description).not.toContain("traceback");
  });

  it("still falls back for a genuinely unknown event type", () => {
    expect(presentFeedItem(item("something_new_we_do_not_know")).description).toBe(
      GENERIC_FALLBACK,
    );
  });
});

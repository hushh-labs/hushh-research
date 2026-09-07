import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import type { FeedItem } from "@/lib/services/feed-service";

/**
 * Provisioning is fire-and-forget in the backend and invisible everywhere else,
 * so these feed rows are the ONLY place a person watches their own private agent
 * being created.
 *
 * `personal_agent_connecting` had no case at all, and it covers the longest wait
 * in the journey — the host exists, the pod is booting, the key is in flight. It
 * fell through to the default and rendered "Something happened in your account."
 * The minutes a person spends most anxious about whether this worked had the
 * worst copy in the app.
 *
 * The coverage test below is the part that matters going forward: it reads the
 * backend's own event constants, so the NEXT lifecycle event added there fails
 * here instead of silently rendering the generic line to real people.
 */

const PROVISIONING_SERVICE = join(
  __dirname,
  "..",
  "..",
  "..",
  "consent-protocol",
  "hushh_mcp",
  "services",
  "personal_agent_provisioning_service.py",
);

function backendEventTypes(): string[] {
  const source = readFileSync(PROVISIONING_SERVICE, "utf8");
  const matches = source.matchAll(/^FEED_EVENT_[A-Z_]+ = "(personal_agent_[a-z_]+)"/gm);
  return [...matches].map((m) => m[1]);
}

const GENERIC = "Something happened in your account.";

function render(eventType: string) {
  const item: FeedItem = {
    id: "feed-1",
    source_domain: "consent",
    event_type: eventType,
    actor_label: null,
    metadata: {},
    read: false,
    created_at: new Date().toISOString(),
  };
  return presentFeedItem(item);
}

describe("private agent lifecycle copy", () => {
  it("finds the backend's event constants (guards the guard)", () => {
    // If the regex ever stops matching, every coverage assertion below would pass
    // vacuously — which is the failure mode this whole file exists to prevent.
    const types = backendEventTypes();
    expect(types.length).toBeGreaterThanOrEqual(6);
    expect(types).toContain("personal_agent_connecting");
  });

  it.each(backendEventTypes())("%s never falls through to the generic line", (eventType) => {
    const described = render(eventType);
    expect(described.description).not.toBe(GENERIC);
    expect(described.label).not.toBe("Activity");
  });

  it.each(backendEventTypes())("%s is labelled as the private agent", (eventType) => {
    expect(render(eventType).domainLabel).toBe("Private agent");
  });

  it("explains what is actually happening while the pod starts up", () => {
    const described = render("personal_agent_connecting");
    expect(described.label).toBe("Your private agent is starting up");
    // The two facts that are true at this exact moment, and that are the product:
    // the person's own compute is running, and the key is what keeps it theirs.
    expect(described.description).toContain("your own private compute".slice(4));
    expect(described.description).toContain("key");
  });

  it("promises nothing to click while there is nothing to click", () => {
    // A live link here would land on an agent that cannot answer yet.
    expect(render("personal_agent_connecting").href).toBeNull();
  });
});

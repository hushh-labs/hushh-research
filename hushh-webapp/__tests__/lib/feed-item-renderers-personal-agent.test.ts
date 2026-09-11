import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { presentFeedItem } from "@/lib/feed/feed-item-renderers";
import { PERSONAL_AGENT_EVENT_TYPES, type FeedItem } from "@/lib/services/feed-service";

/**
 * The private-agent lifecycle rows are the only place a person watches their own
 * agent being created, so an unrendered event type is not a cosmetic gap — it shows
 * "Something happened in your account", which is worse than silence.
 *
 * These assert the whole vocabulary the backend emits, so adding an event type
 * without a case here fails rather than quietly falling through to the default.
 *
 * That claim used to be false. The list was hand-copied from the backend and had
 * drifted to six of seven, missing `personal_agent_connecting` — which is the
 * longest, most anxious minutes of the journey, and the one whose renderer was
 * added specifically so it would stop saying "Something happened in your account".
 * A mirror that has to be updated by hand is not a guard; it is a second copy that
 * agrees with the first only until someone forgets.
 *
 * So the vocabulary is now READ from the backend's own constants. If a name is
 * added, renamed or removed in Python, this test sees it on the next run without
 * anyone remembering to come here.
 */

const PROVISIONING_SERVICE = join(
  __dirname,
  "..",
  "..",
  "..",
  "consent-protocol",
  "hushh_mcp",
  "services",
  "personal_agent_provisioning_service.py"
);

/**
 * Parse `FEED_EVENT_* = "..."` out of the backend service.
 *
 * Deliberately throws rather than skipping when the file cannot be read. A parity
 * check that silently opts out when it cannot find its counterpart reports success
 * over nothing — the precise failure this file exists to prevent.
 */
function backendEventTypes(): string[] {
  const source = readFileSync(PROVISIONING_SERVICE, "utf8");
  const names = [...source.matchAll(/^FEED_EVENT_[A-Z_]+\s*=\s*"([a-z_]+)"/gm)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error(
      `No FEED_EVENT_* constants found in ${PROVISIONING_SERVICE}. ` +
        "If the constants moved, point this test at their new home rather than deleting it."
    );
  }
  return names;
}

const BACKEND_EVENT_TYPES = backendEventTypes();

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

// Main's deliberate change: no pretend explanation for an event this build has
// no line for — an empty description beats copy that reads like a bug. The row
// still labels itself "Activity".
const GENERIC_FALLBACK = "";

describe("private-agent feed vocabulary parity", () => {
  it("the frontend list matches the backend's own constants exactly", () => {
    // The assertion the hand-copied list could never make. Drift in either
    // direction is a defect: an extra name here renders a row nothing emits, a
    // missing one shows the generic fallback for a real lifecycle moment.
    expect([...PERSONAL_AGENT_EVENT_TYPES].sort()).toEqual([...BACKEND_EVENT_TYPES].sort());
  });

  it("covers the whole lifecycle, including the connecting state", () => {
    // Named explicitly because this is the one that went missing, and because
    // `connecting` is where a person waits longest with nothing else to look at.
    expect(BACKEND_EVENT_TYPES).toContain("personal_agent_connecting");
    expect(BACKEND_EVENT_TYPES).toContain("personal_agent_updated");
  });
});

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
  });

  it("does not promise a recovery no code performs", () => {
    // This assertion used to be `toContain("starts automatically")`, and that
    // sentence was not true: a capped row is left at `pending` (the cap is
    // checked before the first registry write) and the reconcile sweep retries
    // only `provisioning` and `failed`.
    //
    // Adding `pending` to that sweep would be worse than the wrong sentence --
    // `pending` is also the state of someone who verified a phone and never
    // connected an AI key, so the sweep would start building agents for people
    // with no model to run them, which is exactly what the AI-connection gate
    // exists to prevent. So the copy changed, not the sweep.
    const p = presentFeedItem(item("personal_agent_provisioning_capped"));
    expect(p.description).not.toContain("automatically");
    // And it offers the one action that genuinely restarts provisioning, rather
    // than asking the person to wait for something that will not happen.
    expect(p.href).toBeTruthy();
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

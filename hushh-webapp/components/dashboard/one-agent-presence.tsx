"use client";

import { useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";

/**
 * "Your Agent One" — the first place a human SEES their own sovereign agent.
 *
 * Honest by construction. It reads the flag-safe status endpoint
 * (GET /api/one/personal-agent/status), which never 404s and never claims more
 * than is true, and it fails safe to "reserved" so it can never break the home.
 *
 * Provisioning has real intermediate states, so this renders all five the endpoint
 * can report — "reserved" while the agent identity is held and ready to activate,
 * "provisioning" and "connecting" while it is being stood up, "active" once the pod
 * is live, "failed" when setup did not finish. Anything else — an older or newer
 * backend, a garbled payload, a network error — lands on "reserved", which is the
 * only state that is safe to assert without evidence.
 */

const AGENT_STATES = [
  "reserved",
  "provisioning",
  "connecting",
  "active",
  "failed",
] as const;

type AgentState = (typeof AGENT_STATES)[number];

/**
 * One idea per line: the badge names the state, the body says the one thing the
 * badge does not — matching the feed's provisioning copy, which deliberately never
 * repeats "your private agent" in both halves.
 */
const COPY: Record<
  AgentState,
  { badge: string; body: string; dotClass: string }
> = {
  reserved: {
    badge: "Reserved",
    body: "Reserved and ready to activate — your private agent, isolated to you alone.",
    dotClass: "bg-amber-500",
  },
  provisioning: {
    badge: "Setting up",
    body: "Being set up in the background. Nothing for you to do.",
    dotClass: "bg-amber-500",
  },
  connecting: {
    badge: "Connecting",
    body: "Almost there — coming online now.",
    dotClass: "bg-amber-500",
  },
  active: {
    badge: "Live",
    body: "Live and yours — always on, isolated to you alone.",
    dotClass: "bg-emerald-500",
  },
  failed: {
    // Calm, not alarming: there is nothing here for the person to fix, and the
    // activity feed already carries the detail.
    badge: "Not ready",
    body: "Setup did not finish. Nothing was lost, and we will try again.",
    dotClass: "bg-amber-500",
  },
};

/**
 * Narrow an untrusted payload to a state this build renders. Uses an explicit list
 * rather than `in COPY`, so an inherited key ("toString") can never be mistaken for
 * a state and render an empty card.
 */
function toAgentState(value: unknown): AgentState {
  return (AGENT_STATES as readonly string[]).includes(value as string)
    ? (value as AgentState)
    : "reserved";
}

export function OneAgentPresence() {
  // Follows the deployment while it is in flight and stops once it settles.
  // This used to be a one-shot fetch on mount, which meant the chip froze for
  // exactly the minutes it had something to say: a person watching their agent
  // be built saw "reserved" until they reloaded the page.
  const { state: followed } = useAgentDeploymentFollow();
  const state: AgentState = toAgentState(followed);

  const copy = COPY[state];

  return (
    <section
      aria-label="Your Agent One"
      className="flex items-center gap-3 rounded-[22px] border border-accent/15 bg-accent-surface/50 px-4 py-3.5 sm:px-5"
    >
      <span
        className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${copy.dotClass}`}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[14px] font-semibold text-foreground">
            <span aria-hidden className="mr-1">
              🤫
            </span>
            Your Agent One
          </span>
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {copy.badge}
          </span>
        </span>
        <span className="mt-0.5 block text-[13px] leading-snug text-muted-foreground">
          {copy.body}
        </span>
      </span>
    </section>
  );
}

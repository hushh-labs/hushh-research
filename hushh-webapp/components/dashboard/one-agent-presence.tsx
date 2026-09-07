"use client";

import { isAgentAsleep, isAgentNotAnswering } from "@/lib/feed/agent-presence-policy";
import { classifyAgentRecovery } from "@/lib/feed/agent-recovery";
import { useRouter } from "next/navigation";
import { ROUTES } from "@/lib/navigation/routes";
import { useState } from "react";

import { ApiService } from "@/lib/services/api-service";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { useVault } from "@/lib/vault/vault-context";
import { useAgentDeploymentFollow } from "@/lib/feed/use-agent-deployment-follow";
import { useProactiveAgentWake } from "@/lib/feed/use-proactive-agent-wake";

/**
 * "Your Agent One" — the first place a human SEES their own sovereign agent.
 *
 * Honest by construction. It reads the flag-safe status endpoint
 * (GET /api/one/personal-agent/status), which never 404s and never claims more
 * than is true, and it renders NOTHING when it has nothing true to say.
 *
 * Provisioning has real intermediate states, so this renders all five the endpoint
 * can report: "reserved" while the agent identity is held and ready to activate,
 * "provisioning" and "connecting" while it is being stood up, "active" once the pod
 * is live, "failed" when setup did not finish.
 *
 * Anything else (an older or newer backend, a garbled payload, a network error)
 * renders nothing at all. It used to land on "reserved" in the name of failing
 * safe, but "reserved" is not neutral: it asserts that infrastructure is held and
 * ready. A person with no agent was told they had one waiting. Silence is the only
 * state that is genuinely safe to assert without evidence.
 *
 * Presence (asleep, not answering) is a separate axis from lifecycle and comes from
 * `agent-presence-policy.ts`. Asking one expression to answer both is what caused a
 * sleeping pod, the normal condition of the default tier, to read as a failure.
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
 * One word per state. Founder directive 2026-09-02: this is a status INDICATOR, not
 * a card -- "we just need a small status indicator of asleep booting online etc".
 * The sentences this table used to carry (what a pod is, why it sleeps, where it
 * lives) were true and are now said once during setup instead of on every visit.
 */
const COPY: Record<AgentState, { badge: string; dotClass: string }> = {
  reserved: { badge: "Reserved", dotClass: "bg-amber-500" },
  provisioning: { badge: "Setting up", dotClass: "bg-amber-500" },
  connecting: { badge: "Connecting", dotClass: "bg-amber-500" },
  // NOT "always on". The default tier is economy: the pod sleeps between sessions
  // and wakes on demand (`gcp_backend.py`, minScale 0 by founder directive).
  active: { badge: "Online", dotClass: "bg-emerald-500" },
  failed: { badge: "Not ready", dotClass: "bg-amber-500" },
};

/**
 * Narrow an untrusted payload to a state this build renders, or to `null` when
 * there is nothing to render. Uses an explicit list rather than `in COPY`, so an
 * inherited key ("toString") can never be mistaken for a state.
 *
 * WHY THIS NO LONGER FAILS SAFE TO "reserved"
 *
 * It was not failing safe. "reserved" is not a neutral placeholder -- it carries
 * the sentence "Reserved and ready to activate", which is a positive claim about
 * infrastructure. A person with no agent, or with a live one whose poll happened
 * to fail, was told their identity was held and ready. That is a confident answer
 * to a question we could not answer.
 *
 * The follow hook already models the distinction correctly: it holds `null` until
 * a poll succeeds and keeps the last known value on a transient failure
 * (`use-agent-deployment-follow.ts`). Coercing that `null` here threw away the one
 * honest state and replaced it with a fabricated one. Returning `null` lets the
 * caller say nothing, which is the only thing that is true.
 */
function toAgentState(value: unknown): AgentState | null {
  return (AGENT_STATES as readonly string[]).includes(value as string)
    ? (value as AgentState)
    : null;
}

export function OneAgentPresence() {
  const [rebuilding, setRebuilding] = useState(false);
  const { vaultOwnerToken } = useVault();
  // Follows the deployment while it is in flight and stops once it settles.
  // This used to be a one-shot fetch on mount, which meant the chip froze for
  // exactly the minutes it had something to say: a person watching their agent
  // be built saw "reserved" until they reloaded the page.
  //
  // No `userId` on purpose: the Feed owns registering the deployment in the
  // background-work rail, and one owner is better than two components agreeing.
  // The chip is a reader here, not a second reporter.
  const {
    state: followed,
    health,
    cloud,
    hushhId,
    deploymentTarget,
    update,
  } = useAgentDeploymentFollow();
  const state: AgentState | null = toAgentState(followed);
  // Warm the pod from the home surface too, on mount and on app resume, so a returning
  // person's agent is already awake by the time they open the composer. This only
  // warms an active-but-asleep pod (the chip's own "it wakes the moment you use it"
  // promise, kept early); it shares ONE module-level cooldown with the chat surface, so
  // mounting it in both places cannot double-wake. No UI of its own here.
  // The wake hook is also the fresher READER. `useAgentDeploymentFollow` stops
  // polling once the row is terminal, so its `health` freezes at whatever it saw
  // first -- which is why this chip kept saying "Asleep" for a pod that had been
  // awake for ten minutes (founder, 2026-09-02: "why is it still asleep!"). The
  // wake route answers with the pod's live state every time it is touched, and
  // while a tab is visible it is touched on a keep-alive, so prefer it.
  const { isWaking, livePresence } = useProactiveAgentWake({
    state: followed as string | null,
    health,
  });
  const router = useRouter();

  // Nothing known yet, so nothing claimed. Rendering the chip with a fabricated
  // state was the previous behavior and it is what made "Reserved" appear for
  // people who had no agent at all.
  if (state === null) return null;

  const copy = COPY[state];
  // Shown ONLY when the backend sent a real verdict. It omits health rather than
  // defaulting to "healthy" (see `personal_agent.py`), and a client that invented one
  // would be making exactly the claim the backend refused to make. Absent stays absent.
  //
  // An ALLOWLIST via `isAgentNotAnswering`, not `health !== "healthy"`. The old test
  // swept up `sleeping`, which is the steady state of an economy pod and explicitly
  // not a fault, so every idle agent was reported as broken.
  const notAnswering =
    state === "active" && livePresence !== "awake" && isAgentNotAnswering(health);
  // Asleep is worth SAYING rather than hiding: it is the honest reason a first turn
  // takes a moment, and a person who knows their agent sleeps reads that pause as
  // normal instead of as a stall.
  // Live answer wins over the frozen poll, in both directions: "awake" clears a
  // stale sleeping read, and nothing invents sleep the pod did not report.
  const asleep =
    state === "active" && livePresence !== "awake" && isAgentAsleep(health);
  const waking = state === "active" && (isWaking || livePresence === "waking");
  // A software update in flight. The previous build keeps serving throughout, so
  // this is "still yours, being refreshed", not a warning.
  const updating = state === "active" && update.inProgress;
  const label = notAnswering
    ? "Not responding"
    : updating
      ? "Updating"
      : waking
        ? "Waking"
        : asleep
          ? "Asleep"
          : copy.badge;
  const dotClass = notAnswering
    ? "bg-amber-500"
    : updating
      ? "bg-sky-500 animate-pulse"
      : waking
        ? "bg-amber-400 animate-pulse"
        : asleep
          ? "bg-emerald-500/50"
          : copy.dotClass;
  const updateNote = updating
    ? "A newer build is being installed; it keeps answering meanwhile."
    : update.failed
      ? `The last update did not finish${update.error ? `: ${update.error}` : ""}.`
      : update.available === true
        ? `An update is available (${update.target ?? "newer build"}); it installs on its own.`
        : null;
  // Where it lives, kept as a tooltip rather than two more lines on the screen.
  const whereItLives = cloud
    ? `In your project ${cloud.project}${cloud.region ? ` (${cloud.region})` : ""}${
        cloud.credentialMode === "user_adc"
          ? ", thinking with your own project's Vertex AI"
          : ""
      }`
    : deploymentTarget === "gcp"
      ? "Hosted by hussh, sealed to your agent's own keys"
      : undefined;
  // Repair, reachable where the failure is SHOWN. It runs through the SAME
  // shared recovery classifier the chat banner uses (they used to disagree:
  // this chip minted a new identity with no probe). Wake/reconnect preserves
  // the agent's identity and memory; a project that is gone routes to cloud
  // reconnect; only a confirmed-gone-but-reachable host earns a new-identity
  // rebuild (founder finding + north-star identity rule, 2026-08-21).
  const canRebuild = state === "failed";
  const handleRebuild = async () => {
    setRebuilding(true);
    try {
      const outcome = await classifyAgentRecovery({ podHushhId: hushhId });
      if (outcome.kind === "reconnected" || outcome.kind === "waking") {
        return; // the follow hook re-narrates; nothing minted
      }
      if (outcome.kind === "needs_reinit") {
        router.push(ROUTES.ONE_SETUP_CLOUD);
        return;
      }
      if (outcome.kind === "error") {
        toast.error("Could not reach your agent just now. Try again in a moment.");
        return;
      }
      // rebuildable: confirmed gone, cloud reachable -> a new identity is warranted.
      if (!vaultOwnerToken) {
        toast.error("Unlock your vault first, then press Rebuild again.");
        return;
      }
      await ApiService.provisionPersonalAgent({ vaultOwnerToken });
    } catch {
      toast.error("Could not start the rebuild. Try again in a moment.");
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <section
      aria-label="Your Agent One"
      title={updateNote ? [whereItLives, updateNote].filter(Boolean).join(" · ") : whereItLives}
      data-testid="one-agent-presence"
      className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/30 px-3 py-1"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass}`} aria-hidden />
      <span className="text-[12px] font-medium text-muted-foreground">
        Agent One
      </span>
      <span className="text-[12px] text-foreground" data-testid="one-agent-status">
        {label}
      </span>
      {canRebuild ? (
        <button
          type="button"
          onClick={() => void handleRebuild()}
          disabled={rebuilding}
          className="ml-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-amber-700 underline underline-offset-2 hover:text-amber-800 disabled:opacity-60 dark:text-amber-400"
          data-testid="one-agent-rebuild"
        >
          {rebuilding ? "Reconnecting…" : "Reconnect"}
        </button>
      ) : null}
    </section>
  );
}

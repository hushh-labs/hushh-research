import type {
  CapabilitySetupState,
  CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";

/**
 * Consumer-facing presentation of a {@link CapabilityStatus}.
 *
 * Copy here is in One's voice and deliberately plain — no system nouns (no
 * "vault", "token", "OAuth", "PKM"). The visual `tone` maps to neutral emphasis
 * levels, NOT colored tile chrome (the premium card model forbids tinting outer
 * chrome to signal state — emphasis comes from copy + elevation).
 */
export type CapabilityStatusTone = "ready" | "action" | "attention" | "muted";

export interface CapabilityStatusDisplay {
  /** Short badge label, e.g. "Ready", "Set up", "2 to review", "Unlock to see". */
  label: string;
  tone: CapabilityStatusTone;
  /** Whether tapping the tile should route into a setup action vs just open it. */
  isActionable: boolean;
}

const STATE_TONE: Record<CapabilitySetupState, CapabilityStatusTone> = {
  unknown: "muted",
  blocked: "action",
  "not-started": "action",
  "in-progress": "action",
  completed: "ready",
  skipped: "muted",
  "needs-attention": "attention",
};

/**
 * Map a resolved capability status to consumer-facing display.
 *
 * `pendingCount` is woven into the `needs-attention` label so the user sees the
 * exact number to review. `blocked` renders an honest, plain-language reason
 * rather than a misleading "Setup needed".
 */
export function getCapabilityStatusDisplay(
  status: CapabilityStatus,
  options?: { isExploreOnly?: boolean }
): CapabilityStatusDisplay {
  const tone = STATE_TONE[status.state];
  const isExploreOnly = options?.isExploreOnly === true;

  switch (status.state) {
    case "completed":
      // Explore-only capabilities are "set up" by looking once, so a completed
      // one reads "Explored" rather than "Ready" — it was never configured, it
      // was explored.
      return {
        label: isExploreOnly ? "Explored" : "Ready",
        tone,
        isActionable: false,
      };
    case "skipped":
      return { label: "Set up later", tone, isActionable: true };
    case "not-started":
    case "in-progress":
      // Explore-only and not yet explored: invite a look, not a setup step.
      return {
        label: isExploreOnly ? "Explore" : "Set up",
        tone,
        isActionable: true,
      };
    case "needs-attention":
      return {
        label:
          status.pendingCount > 0
            ? `${status.pendingCount} to review`
            : "Needs a look",
        tone,
        isActionable: true,
      };
    case "blocked":
      return { label: blockedLabel(status), tone, isActionable: true };
    case "unknown":
    default:
      return {
        label: status.requiresUnlock ? "Unlock to see" : "Checking…",
        tone,
        isActionable: false,
      };
  }
}

function blockedLabel(status: CapabilityStatus): string {
  switch (status.prerequisite) {
    case "vault":
      return "Unlock to set up";
    case "oauth":
      return "Connect to set up";
    case "auth":
      return "Sign in to set up";
    default:
      return "Set up";
  }
}

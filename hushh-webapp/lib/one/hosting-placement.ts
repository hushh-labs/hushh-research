/**
 * Where a person's agent runs, as the hub reports it, plus the setup facts the
 * cloud step shows while an own-cloud agent is on its way to direct.
 *
 * `unplaced` (2026-10-06): the person never chose, or detached since choosing.
 * They get the tier chooser and never the hub runtime. Shared is only ever a
 * recorded choice, so nothing here treats a missing mode as Shared.
 */

export type HostingMode =
  | "shared"
  | "byoc"
  | "hussh_pods"
  | "pending"
  | "unplaced"
  | "unknown";

const HOSTING_MODES: ReadonlySet<string> = new Set([
  "shared",
  "byoc",
  "hussh_pods",
  "pending",
  "unplaced",
  "unknown",
]);

/** A mode word from the hub; anything unrecognised is `unknown`, never Shared. */
export function readHostingMode(value: unknown): HostingMode {
  return typeof value === "string" && HOSTING_MODES.has(value)
    ? (value as HostingMode)
    : "unknown";
}

/** The begun-setup stage entry (`byoc_setup_intent`), when the job is only an intent. */
export type ConsentPendingEntry = { provider: "gcp" | "azure" | null; project: string };

export function consentPendingEntry(
  job: { status: string; stage: string; stages: ReadonlyArray<Record<string, unknown>> } | null,
): ConsentPendingEntry | null {
  if (!job || job.status !== "pending" || job.stage !== "consent_pending") return null;
  const entry = job.stages.find((item) => item.stage === "consent_pending") ?? {};
  const provider = entry.provider === "gcp" || entry.provider === "azure" ? entry.provider : null;
  return { provider, project: typeof entry.project === "string" ? entry.project : "" };
}

/** Why the automatic attach after a recorded setup stopped, in plain words. */
export function attachBlockedCopy(code: string | null | undefined): {
  message: string;
  needsPhone: boolean;
} | null {
  if (!code) return null;
  if (code === "PHONE_NOT_VERIFIED" || code === "AGENT_RECORD_REQUIRED") {
    return {
      message: "Verify your phone number and your agent starts in your cloud right away.",
      needsPhone: true,
    };
  }
  if (code === "MODEL_ACCESS_UNAVAILABLE") {
    return {
      message: "Your cloud does not give your agent a model yet. Your setup is kept.",
      needsPhone: false,
    };
  }
  return {
    message: "Your cloud is ready, and your agent has not started yet. Your setup is kept.",
    needsPhone: false,
  };
}

/** The org-policy blocker the hub records when direct access is refused. */
export type DirectIngressBlocker = { code: string; message: string | null; retryable: boolean };

export function directIngressBlocker(status: unknown): DirectIngressBlocker | null {
  if (!status || typeof status !== "object") return null;
  const blocker = (status as { directIngressBlocker?: unknown }).directIngressBlocker;
  if (typeof blocker === "string" && blocker.trim()) {
    return { code: blocker.trim(), message: null, retryable: true };
  }
  if (!blocker || typeof blocker !== "object") return null;
  const { code, message, retryable } = blocker as Record<string, unknown>;
  if (typeof code !== "string" || !code.trim()) return null;
  return {
    code: code.trim(),
    message: typeof message === "string" && message.trim() ? message.trim() : null,
    retryable: retryable !== false,
  };
}

async function postOwnerRetry(path: string): Promise<boolean> {
  const { ApiService } = await import("@/lib/services/api-service");
  try {
    const token = await ApiService.getFirebaseIdToken();
    const response = await ApiService.apiFetch(path, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Ask the hub for one more direct-access attempt for the caller's own agent
 * (`POST /api/one/personal-agent/direct-ingress/retry`). Resolves either way:
 * the screen re-reads the agent's status afterwards, which is the truth.
 */
export function retryDirectIngress(): Promise<boolean> {
  return postOwnerRetry("/api/one/personal-agent/direct-ingress/retry");
}

/**
 * Run the attach of the caller's recorded cloud setup again
 * (`POST /api/one/runtime/byoc/attach/retry`). The attach runs in the background,
 * so this resolves at once; the screen re-reads the setup status afterwards.
 */
export function retryOwnerCloudAttach(): Promise<boolean> {
  return postOwnerRetry("/api/one/runtime/byoc/attach/retry");
}

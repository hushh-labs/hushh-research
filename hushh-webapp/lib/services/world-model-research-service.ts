import { z } from "zod";
import { ApiError, apiJson } from "@/lib/services/api-client";
import { oneChatKeyHeaders } from "@/lib/vault/one-chat-key";
import { profileReportSchema } from "@/lib/services/profile-research-service";
import type { PwmOwnerDecisions } from "@/lib/services/world-model-decision-service";

export const pwmPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    email_enabled: z.boolean(),
    consent_version: z.literal("pwm-native-v1"),
  })
  .strict();
export type PwmPreferences = z.infer<typeof pwmPreferencesSchema>;
const identity = z
  .object({
    state: z.enum([
      "owner_linked",
      "candidate_for_review",
      "ambiguous",
      "no_match",
    ]),
    reason: z.string().max(600),
    probability: z.null(),
    selected_candidate_id: z.string().nullable(),
    supporting_anchor_ids: z.array(z.string()).max(12),
    next_step: z.enum(["search", "review", "request_owner_anchor", "finish"]),
  })
  .strict();
const coverage = z
  .object({
    topic: z.string().max(160),
    status: z.enum([
      "findings",
      "checked_no_findings",
      "unavailable",
      "not_attempted",
    ]),
    attempt_ids: z.array(z.number().int().min(1).max(32)).max(32),
    explanation: z.string().max(600),
  })
  .strict();
export const pwmResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("offered"),
      pkm_written: z.literal(false),
      draft_id: z.string().uuid(),
      report: profileReportSchema,
      grounded_answers: z
        .array(
          z
            .object({
              answer: z.string().max(100_000),
              sources: z
                .array(
                  z
                    .object({
                      title: z.string().max(160),
                      url: z.string().url(),
                    })
                    .strict(),
                )
                .max(200),
              search_suggestions: z.array(z.string().max(40_000)).max(2),
            })
            .strict(),
        )
        .max(32),
      search_suggestions: z.array(z.string().max(40_000)).max(64),
      research: z
        .object({
          identity,
          coverage: z.array(coverage).length(20),
          gaps: z.array(z.string().max(600)).max(20),
          checked_topics: z.array(z.string()).max(20),
          searches_used: z.number().int().min(0).max(32),
          candidates: z
            .array(
              z
                .object({
                  id: z.string(),
                  label: z.string().max(600),
                  anchor_ids: z.array(z.string()),
                  blocking_conflicts: z.array(z.string().max(600)),
                })
                .strict(),
            )
            .max(6),
          source_use: z.literal("google_grounded_display_only"),
          provider: z.literal("vertex_google_search"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      status: z.enum(["pending", "paused"]),
      pkm_written: z.literal(false),
      restart_required: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      pkm_written: z.literal(false),
      research_exhausted: z.boolean().optional(),
      draft_id: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      status: z.enum([
        "disabled",
        "not_ready",
        "insufficient_identity",
        "saved",
        "consent_required",
      ]),
      pkm_written: z.literal(false),
      draft_id: z.string().uuid().optional(),
    })
    .strict(),
]);
export type PwmResult = z.infer<typeof pwmResultSchema>;
export type PwmAuthority = {
  vaultKey: string;
  vaultOwnerToken: string;
  signal?: AbortSignal;
  assertCurrent?: () => Promise<void>;
};

async function request(
  input: PwmAuthority,
  path: string,
  method = "GET",
  body?: unknown,
) {
  await input.assertCurrent?.();
  const headers = await oneChatKeyHeaders(input.vaultKey);
  await input.assertCurrent?.();
  const result = await apiJson(`/api/one/world-model/${path}`, {
    method,
    cache: "no-store",
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${input.vaultOwnerToken}`,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await input.assertCurrent?.();
  return result;
}
function pause(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
/** A hidden tab does not poll; research resumes when the owner returns. */
function whenVisible(signal: AbortSignal) {
  if (typeof document === "undefined" || !document.hidden)
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", show);
      signal.removeEventListener("abort", abort);
    };
    const show = () => {
      if (document.hidden) return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    document.addEventListener("visibilitychange", show);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
/** A POST may start paid research; automatic retries never come faster. */
const MIN_POST_INTERVAL_MS = 60_000;
/** Without a usable Retry-After, a refused POST waits this long. */
const RATE_LIMITED_POST_MS = 600_000;
/** A refused read slows to this cadence. */
const RATE_LIMITED_READ_MS = 60_000;
const DRIVER_POLL_MS = 5_000;
/** Tabs that are not driving research only read, and only this often. */
const FOLLOWER_POLL_MS = 15_000;
const POLL_BUDGET_MS = 3_600_000;
const MAX_FAILURES = 5;

type Step = { path: "ensure" | "jobs"; method: "GET" | "POST" };
type Observation = PwmAuthority & {
  signal: AbortSignal;
  onResult: (result: PwmResult) => void;
  ownerDecisions?: PwmOwnerDecisions;
};
type Session = {
  next: Step;
  deadline: number;
  lastPostAt: number;
  postBlockedUntil: number;
  failures: number;
};
type ResearchLocks = {
  request<T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
};

/** Web Locks keep one research driver per owner across this browser's tabs. */
function researchLocks(): ResearchLocks | null {
  const locks =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as { locks?: Partial<ResearchLocks> }).locks;
  return locks && typeof locks.request === "function"
    ? (locks as ResearchLocks)
    : null;
}

/** Seconds from a typed 429 body, when the server sends one. */
function retryAfterMs(error: ApiError, fallback: number) {
  const payload = error.payload as
    | { retry_after?: unknown; detail?: { retry_after?: unknown } }
    | undefined;
  const seconds = Number(payload?.retry_after ?? payload?.detail?.retry_after);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.max(fallback, Math.min(seconds * 1000, 3_600_000))
    : fallback;
}

/**
 * One request. Returns "done" on a final result, otherwise the delay before
 * the next one. A read-only step never POSTs, and no POST is sent sooner than
 * MIN_POST_INTERVAL_MS after the last, or while the server is refusing them.
 */
async function step(
  input: Observation,
  session: Session,
  readOnly: boolean,
): Promise<"done" | number> {
  let { path, method } = session.next;
  const now = Date.now();
  if (
    method === "POST" &&
    (readOnly ||
      now < session.postBlockedUntil ||
      now < session.lastPostAt + MIN_POST_INTERVAL_MS)
  ) {
    path = "jobs";
    method = "GET";
  }
  try {
    if (method === "POST") session.lastPostAt = now;
    const result = pwmResultSchema.parse(
      await request(
        input,
        path,
        method,
        method === "POST" && input.ownerDecisions
          ? { owner_decisions: input.ownerDecisions }
          : undefined,
      ),
    );
    session.failures = 0;
    input.onResult(result);
    if (result.status !== "pending" && result.status !== "paused")
      return "done";
    session.next = result.restart_required
      ? { path: "ensure", method: "POST" }
      : { path: "jobs", method: "GET" };
    return DRIVER_POLL_MS;
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (error instanceof ApiError && error.status === 429) {
      // Rate limits are not failures: keep reading, never give up on them.
      if (method === "POST") {
        session.postBlockedUntil =
          Date.now() + retryAfterMs(error, RATE_LIMITED_POST_MS);
        return DRIVER_POLL_MS;
      }
      return retryAfterMs(error, RATE_LIMITED_READ_MS);
    }
    if (error instanceof ApiError && error.status < 500) throw error;
    if (++session.failures >= MAX_FAILURES) throw error;
    // A lost response can already have started research; read before retrying.
    session.next = { path: "jobs", method: "GET" };
    return Math.min(30_000, 3000 * 2 ** session.failures);
  }
}

/** Time away from the tab does not spend the one-hour polling budget. */
async function whenVisibleWithinBudget(input: Observation, session: Session) {
  const hiddenSince = Date.now();
  await whenVisible(input.signal);
  session.deadline += Date.now() - hiddenSince;
}

/** Drive while visible; a hidden tab hands the lock to a visible one. */
async function drive(input: Observation, session: Session) {
  while (Date.now() < session.deadline) {
    const delay = await step(input, session, false);
    if (delay === "done") return "done" as const;
    await pause(input.signal, delay);
    if (typeof document !== "undefined" && document.hidden) break;
  }
  return "yield" as const;
}

export const WorldModelResearchService = {
  async preferences(input: PwmAuthority) {
    return pwmPreferencesSchema.parse(await request(input, "preferences"));
  },
  async updatePreferences(
    input: PwmAuthority,
    value: Pick<PwmPreferences, "enabled" | "email_enabled">,
  ) {
    return pwmPreferencesSchema.parse(
      await request(input, "preferences", "PUT", {
        ...value,
        consent_version: "pwm-native-v1",
      }),
    );
  },
  async discard(input: PwmAuthority, draftId: string) {
    z.object({ discarded: z.literal(true) })
      .strict()
      .parse(
        await request(
          input,
          `jobs?draft_id=${encodeURIComponent(draftId)}`,
          "DELETE",
        ),
      );
  },
  async observe(
    input: Observation & {
      refresh?: boolean;
      /** Past owner decisions, so research does not propose them again. */
      ownerDecisions?: PwmOwnerDecisions;
      /**
       * Owner account id. With it, only one tab per owner drives research;
       * other tabs only read. Without it, every observer drives.
       */
      ownerId?: string;
    },
  ) {
    const session: Session = {
      next: { path: input.refresh ? "jobs" : "ensure", method: "POST" },
      deadline: Date.now() + POLL_BUDGET_MS,
      lastPostAt: -Infinity,
      postBlockedUntil: 0,
      failures: 0,
    };
    const locks = input.ownerId ? researchLocks() : null;
    const lockName = `pwm-research:${input.ownerId}`;
    while (Date.now() < session.deadline) {
      if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
      // ifAvailable cannot be combined with an abort signal; it never waits.
      const role = locks
        ? await locks.request(lockName, { ifAvailable: true }, (lock) =>
            lock ? drive(input, session) : Promise.resolve("follow" as const),
          )
        : await drive(input, session);
      if (role === "done") return;
      if (role === "follow") {
        const delay = await step(input, session, true);
        if (delay === "done") return;
        await pause(input.signal, Math.max(delay, FOLLOWER_POLL_MS));
      }
      await whenVisibleWithinBudget(input, session);
    }
    input.onResult({
      status: "paused",
      pkm_written: false,
      restart_required: true,
    });
  },
};

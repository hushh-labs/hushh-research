import { pause, whenVisible } from "./world-model-observation-wait";
import { z } from "zod";
import { ApiError, apiJson } from "@/lib/services/api-client";
import { nativeStreamFetch } from "@/lib/services/native-sse-fetch";
import { parseSSEBlocks } from "@/lib/streaming/sse-parser";
import { oneChatKeyHeaders } from "@/lib/vault/one-chat-key";
import {
  profileFactSchema,
  profileSectionKindSchema,
  profileSourceSchema,
} from "@/lib/services/profile-research-service";
import type { PwmOwnerDecisions } from "@/lib/services/world-model-decision-service";

export const pwmPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    email_enabled: z.boolean(),
    consent_version: z.literal("pwm-native-v1"),
    research_provider: z.enum(["vertex_google_search", "azure_openai_web_search", "azure_openai_tavily"]),
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
/**
 * What research is doing right now, derived by the server from the sealed
 * job state alone: counts, topic ids and public page titles, never owner text.
 */
export const pwmProgressSchema = z
  .object({
    stage: z.enum(["starting", "identity", "coverage", "report"]),
    searches_used: z.number().int().min(0),
    searches_total: z.number().int().min(1),
    model_calls_used: z.number().int().min(0),
    model_calls_total: z.number().int().min(1),
    topics_checked: z.array(z.string()).max(20),
    sources_found: z.number().int().min(0),
    recent_sources: z
      .array(
        z.object({ title: z.string().max(160), url: z.string().url() }).strict(),
      )
      .max(5),
    identity_state: z
      .enum(["owner_linked", "candidate_for_review", "ambiguous", "no_match"])
      .nullable(),
    candidates: z.number().int().min(0),
    started_at: z.string().nullable(),
    last_activity_at: z.string().nullable(),
    slice: z.number().int().min(1),
  })
  .strict();
export type PwmProgress = z.infer<typeof pwmProgressSchema>;
/** Cited, provisional findings from the owner-bound research checkpoint, available for owner review. */
export const pwmValidatedFactSchema = z.object({
  id: z.string().min(1).max(160),
  topic: profileSectionKindSchema,
  statement: z.string().min(1).max(600),
  confidence: z.enum(["supported", "uncertain", "conflicting"]),
  sources: z.array(profileSourceSchema).min(1).max(3),
  identity_state: z.enum(["owner_linked", "candidate_for_review"]),
}).strict();
export const pwmValidatedFactsSchema = z.array(pwmValidatedFactSchema).max(269);
export type PwmValidatedFact = z.infer<typeof pwmValidatedFactSchema>;
const pwmPartialSchema = z.object({ validated_facts: pwmValidatedFactsSchema }).strict();
/** PWM alone has room for a deep draft; Magic Intelligence keeps its eight-fact bound. */
export const pwmReportSchema = z
  .object({
    match_status: z.enum(["matched", "uncertain", "no_match"]),
    name: z.string().min(1).max(160),
    summary: z.string().min(1).max(500),
    sections: z
      .array(
        z.object({
          kind: profileSectionKindSchema,
          facts: z
            .array(
              profileFactSchema.extend({
                // Older sealed drafts can still be reviewed after this release.
                evidence_score: z.number().int().min(1).max(10).optional(),
                evidence_reason: z.string().max(300).optional(),
              }),
            )
            .min(1)
            .max(40),
        }).strict(),
      )
      .max(20),
  })
  .strict()
  .refine((value) => {
    const facts = value.sections.flatMap((section) => section.facts);
    return (
      new Set(value.sections.map((section) => section.kind)).size === value.sections.length &&
      (value.match_status !== "no_match" || facts.length === 0) &&
      facts.length <= 269 &&
      new Set(facts.map((fact) => fact.statement.trim().replace(/\s+/g, " ").toLowerCase())).size === facts.length
    );
  });

const azureGroundedCitationSchema = z
  .object({
    start_index: z.number().int().min(0),
    end_index: z.number().int().positive(),
    title: z.string().max(1024),
    url: z.string().url().max(2048).refine((value) => {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password;
    }),
  })
  .strict();

const groundedAnswerSchema = z
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
    citations: z.array(azureGroundedCitationSchema).max(200).optional(),
    search_suggestions: z.array(z.string().max(40_000)).max(2),
  })
  .strict()
  .superRefine(({ answer, citations }, context) => {
    let previousEnd = 0;
    for (const citation of citations ?? []) {
      if (
        citation.start_index < previousEnd ||
        citation.end_index <= citation.start_index ||
        citation.end_index > answer.length
      ) {
        context.addIssue({ code: "custom", message: "Invalid or overlapping Azure citation span" });
      }
      previousEnd = citation.end_index;
    }
  });

export const pwmResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("offered"),
      pkm_written: z.literal(false),
      draft_id: z.string().uuid(),
      report: pwmReportSchema,
      grounded_answers: z.array(groundedAnswerSchema).max(32),
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
          source_use: z.enum([
            "google_grounded_display_only",
            "azure_web_grounded_display_only",
            "tavily_review_retained",
          ]),
          provider: z.enum(["vertex_google_search", "azure_openai_web_search", "azure_openai_tavily"]),
        })
        .strict()
        .refine(
          ({ source_use, provider }) =>
            (source_use === "google_grounded_display_only" &&
              provider === "vertex_google_search") ||
            (source_use === "azure_web_grounded_display_only" &&
              provider === "azure_openai_web_search") ||
            (source_use === "tavily_review_retained" && provider === "azure_openai_tavily"),
        ),
    })
    .strict()
    .refine(
      ({ research, grounded_answers }) =>
        research.provider !== "azure_openai_web_search" ||
        grounded_answers.every((answer) => answer.citations && answer.citations.length > 0),
      { message: "Azure web research requires original citation spans" },
    ),
  z
    .object({
      status: z.enum(["pending", "paused"]),
      pkm_written: z.literal(false),
      restart_required: z.boolean(),
      progress: pwmProgressSchema.optional(),
      validated_facts: pwmValidatedFactsSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      pkm_written: z.literal(false),
      research_exhausted: z.boolean().optional(),
      draft_id: z.string().uuid().optional(),
      /** Why research could not run now; a short code, never owner text. */
      reason: z.string().max(64).optional(),
      /** Seconds before another attempt could succeed; the run ends here. */
      retry_after_s: z.number().int().min(1).optional(),
      progress: pwmProgressSchema.optional(),
      validated_facts: pwmValidatedFactsSchema.optional(),
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
const STREAM_PATH = "/api/one/world-model/jobs/stream";
/** A result frame carries a whole report; anything past this is not one. */
const MAX_STREAM_BYTES = 10 * 1024 * 1024;
type StreamInput = PwmAuthority & {
  signal: AbortSignal;
  onProgress: (progress: PwmProgress) => void;
  onPartial?: (facts: PwmValidatedFact[]) => void;
  onResult: (result: PwmResult) => void;
};

/**
 * One live connection. Resolves when the server closes it, after a result
 * frame or at its own time limit; rejects on a refused request or a broken
 * connection. Frames the contract does not name only keep the connection up.
 */
async function stream(input: StreamInput) {
  await input.assertCurrent?.();
  const headers = await oneChatKeyHeaders(input.vaultKey);
  await input.assertCurrent?.();
  const response = await nativeStreamFetch(STREAM_PATH, {
    method: "GET",
    cache: "no-store",
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${input.vaultOwnerToken}`,
      Accept: "text/event-stream",
      ...headers,
    },
  });
  await input.assertCurrent?.();
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    throw new ApiError(
      `Request failed: ${response.status}`,
      response.status,
      payload,
    );
  }
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Stream unavailable");
  }
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  input.signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let remainder = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (chunk.done) return;
      await input.assertCurrent?.();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new Error("Stream too large");
      const parsed = parseSSEBlocks(
        decoder.decode(chunk.value, { stream: true }),
        remainder,
      );
      remainder = parsed.remainder;
      for (const frame of parsed.events) {
        if (frame.event === "progress") {
          input.onProgress(pwmProgressSchema.parse(JSON.parse(frame.data)));
        } else if (frame.event === "partial") {
          const partial = pwmPartialSchema.parse(JSON.parse(frame.data));
          input.onPartial?.(partial.validated_facts);
        } else if (frame.event === "result") {
          input.onResult(pwmResultSchema.parse(JSON.parse(frame.data)));
          return;
        }
      }
    }
  } finally {
    input.signal.removeEventListener("abort", cancel);
    cancel();
  }
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
/** A closed or failed stream reopens no sooner than this. */
const STREAM_RECONNECT_MS = 1_000;
/** This many failed streams in a row, and the run polls instead. */
const MAX_STREAM_FAILURES = 2;
const POLL_BUDGET_MS = 3_600_000;
/** A failed ensure plus bare pending reads cannot masquerade as a live job. */
const STARTUP_FAILURE_BUDGET_MS = 120_000;
const MAX_FAILURES = 5;

type Step = { path: "ensure" | "jobs" | "jobs/stream"; method: "GET" | "POST" };
type Observation = PwmAuthority & {
  signal: AbortSignal;
  onResult: (result: PwmResult) => void;
  /** Live progress, from a stream frame or a polled pending result. */
  onProgress?: (progress: PwmProgress) => void;
  /** Validated, cited findings; still read-only until a full offer arrives. */
  onPartial?: (facts: PwmValidatedFact[]) => void;
  /** A read or stream failed; the service keeps retrying on its own. */
  onInterrupted?: () => void;
  ownerDecisions?: PwmOwnerDecisions;
  researchContext?: { confirmed: readonly string[]; permitted_public_research: true };
  publicProfileUrls?: readonly string[];
};
type Session = {
  next: Step;
  deadline: number;
  lastPostAt: number;
  postBlockedUntil: number;
  failures: number;
  streamFailures: number;
  startFailureAt: number | null;
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

const canStream = (session: Session) =>
  session.streamFailures < MAX_STREAM_FAILURES;

/** Hands a result on and chooses the next step; "done" when it was final. */
function settle(
  input: Observation,
  session: Session,
  result: PwmResult,
): "done" | number {
  session.failures = 0;
  const hasCheckpoint =
    result.status === "pending" || result.status === "paused" || result.status === "unavailable";
  if (hasCheckpoint) {
    if (result.validated_facts) input.onPartial?.(result.validated_facts);
    if (result.progress) input.onProgress?.(result.progress);
  }
  if ((hasCheckpoint && result.progress) || !hasCheckpoint)
    session.startFailureAt = null;
  input.onResult(result);
  if (result.status !== "pending" && result.status !== "paused") return "done";
  session.next = result.restart_required
    ? { path: "ensure", method: "POST" }
    : { path: "jobs/stream", method: "GET" };
  // Running research is watched live, at once; a restart waits its turn.
  return !result.restart_required && canStream(session) ? 0 : DRIVER_POLL_MS;
}

/**
 * One stream, for the driving tab while research runs. A hidden tab closes
 * it, so the lock can move. A stream that failed, or closed without a result,
 * is followed by a plain read, since the job may have finished meanwhile, and
 * after MAX_STREAM_FAILURES in a row this run polls instead.
 */
async function streamStep(
  input: Observation,
  session: Session,
): Promise<"done" | number> {
  const local = new AbortController();
  const stop = () => local.abort();
  const hide = () => {
    if (document.hidden) stop();
  };
  input.signal.addEventListener("abort", stop, { once: true });
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", hide);
  let final: PwmResult | null = null;
  try {
    await stream({
      vaultKey: input.vaultKey,
      vaultOwnerToken: input.vaultOwnerToken,
      assertCurrent: input.assertCurrent,
      signal: local.signal,
      onProgress: (progress) => {
        session.startFailureAt = null;
        input.onProgress?.(progress);
      },
      onPartial: (facts) => input.onPartial?.(facts),
      onResult: (result) => {
        final = result;
      },
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    if (!local.signal.aborted) {
      session.streamFailures += 1;
      input.onInterrupted?.();
      session.next = { path: "jobs", method: "GET" };
    }
    return STREAM_RECONNECT_MS;
  } finally {
    input.signal.removeEventListener("abort", stop);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", hide);
  }
  // The server always sends a result before it closes; a stream that ended
  // without one broke somewhere along the way, and counts like a thrown one.
  if (!final) {
    session.streamFailures += 1;
    input.onInterrupted?.();
    session.next = { path: "jobs", method: "GET" };
    return STREAM_RECONNECT_MS;
  }
  session.streamFailures = 0;
  return settle(input, session, final);
}

/**
 * One request. Returns "done" on a final result, otherwise the delay before
 * the next one. A read-only step never POSTs, and no POST is sent sooner than
 * MIN_POST_INTERVAL_MS after the last, or while the server is refusing them.
 * Only the driving tab streams; a follower, or a driver whose streams keep
 * failing, reads.
 */
async function step(
  input: Observation,
  session: Session,
  readOnly: boolean,
): Promise<"done" | number> {
  let { path, method } = session.next;
  const now = Date.now();
  if (
    session.startFailureAt !== null &&
    now - session.startFailureAt >= STARTUP_FAILURE_BUDGET_MS
  ) throw new Error("Research could not start");
  const waitingToPost =
    !readOnly &&
    method === "POST" &&
    (now < session.postBlockedUntil || now < session.lastPostAt + MIN_POST_INTERVAL_MS);
  if (
    method === "POST" &&
    (readOnly ||
      now < session.postBlockedUntil ||
      now < session.lastPostAt + MIN_POST_INTERVAL_MS)
  ) {
    path = "jobs";
    method = "GET";
  }
  if (path === "jobs/stream" && (readOnly || !canStream(session)))
    path = "jobs";
  if (path === "jobs/stream") return streamStep(input, session);
  try {
    if (method === "POST") session.lastPostAt = now;
    const result = pwmResultSchema.parse(
      await request(
        input,
        path,
        method,
        method === "POST" && (input.ownerDecisions || path === "jobs")
          ? { ...(input.ownerDecisions ? { owner_decisions: input.ownerDecisions } : {}),
              ...(path === "jobs" ? { refresh: true,
                ...(input.researchContext ? { research_context: input.researchContext } : {}),
                ...(input.publicProfileUrls ? { public_profiles: {
                  urls: input.publicProfileUrls, permitted_public_sources: true,
                } } : {}) } : {}) }
          : undefined,
      ),
    );
    if (method === "POST") session.startFailureAt = null;
    // A refused POST has not started the new run. GET /jobs can still report
    // the previous run's terminal unavailable result while the POST waits.
    // Keep watching until the POST is allowed; a pending or completed result
    // can still come from another tab that started the new run meanwhile.
    if (waitingToPost && result.status === "unavailable")
      return DRIVER_POLL_MS;
    return settle(input, session, result);
  } catch (error) {
    if (input.signal.aborted) throw error;
    input.onInterrupted?.();
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
    if (method === "POST" && session.startFailureAt === null)
      session.startFailureAt = Date.now();
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
  const hiddenFor = Date.now() - hiddenSince;
  session.deadline += hiddenFor;
  if (session.startFailureAt !== null) session.startFailureAt += hiddenFor;
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
    value: Pick<PwmPreferences, "enabled" | "email_enabled" | "research_provider">,
  ) {
    const { research_provider, ...preferences } = value;
    return pwmPreferencesSchema.parse(
      await request(input, "preferences", "PUT", {
        ...preferences,
        consent_version: research_provider === "azure_openai_web_search"
          ? "pwm-azure-bing-v1"
          : research_provider === "azure_openai_tavily"
            ? "pwm-azure-tavily-v1"
            : "pwm-native-v1",
      }),
    );
  },
  /**
   * Watches running research live: progress frames as they happen, then the
   * result the job ended with, as GET jobs would return it.
   */
  stream,
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
      /** Observe existing research without enrolling, starting or resuming it. */
      readOnly?: boolean;
    },
  ) {
    const session: Session = {
      next: { path: input.refresh ? "jobs" : "ensure", method: "POST" },
      deadline: Date.now() + POLL_BUDGET_MS,
      lastPostAt: -Infinity,
      postBlockedUntil: 0,
      failures: 0,
      streamFailures: 0,
      startFailureAt: null,
    };
    const locks = input.ownerId ? researchLocks() : null;
    const lockName = `pwm-research:${input.ownerId}`;
    while (Date.now() < session.deadline) {
      if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
      // ifAvailable cannot be combined with an abort signal; it never waits.
      const role = input.readOnly ? "follow" : locks
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

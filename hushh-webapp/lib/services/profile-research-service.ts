import { z } from "zod";
import { ApiError, apiJson } from "@/lib/services/api-client";
import { oneChatKeyHeaders } from "@/lib/vault/one-chat-key";

export const profileSourceSchema = z
  .object({
    title: z.string().min(1).max(160),
    url: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" && !url.username && !url.password;
        } catch {
          return false;
        }
      }),
  })
  .strict();
export const profileFactSchema = z
  .object({
    statement: z.string().min(1).max(600),
    confidence: z.enum(["supported", "uncertain", "conflicting"]),
    sources: z.array(profileSourceSchema).min(1).max(3),
  })
  .strict();
export const profileSectionKindSchema = z.enum([
  "business", "career", "education", "personal", "projects", "publications",
  "achievements", "community", "interests", "preferences", "dislikes",
  "style", "food", "travel", "entertainment", "shopping", "communication",
  "digital_presence", "public_records", "security",
]);
const report = z
  .object({
    match_status: z.enum(["matched", "uncertain", "no_match"]),
    name: z.string().min(1).max(160),
    summary: z.string().min(1).max(500),
    sections: z
      .array(
        z
          .object({
            kind: profileSectionKindSchema,
            facts: z.array(profileFactSchema).min(1).max(8),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.sections.map((section) => section.kind)).size ===
        value.sections.length &&
      (value.match_status === "no_match") === (value.sections.length === 0),
  );
const verification = z
  .object({
    method: z.literal("model_assessment"),
    identity_score: z.number().finite().min(0).max(100),
    facts: z
      .array(
        z
          .object({
            ref: z.string().regex(/^c[1-7]:[0-3]:[0-7]$/),
            score: z.number().finite().min(0).max(100),
          })
          .strict(),
      )
      .max(32),
    attempts: z.number().int().min(1).max(7),
  })
  .strict();
const response = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("offered"),
        draft_id: z.string().uuid().optional(),
        pkm_written: z.literal(false),
        report,
        search_suggestions: z.array(z.string().max(40_000)).max(5),
        verification: verification.optional(),
        research: z
          .object({
            identity: z
              .object({
                state: z.enum([
                  "owner_linked",
                  "candidate_for_review",
                  "ambiguous",
                  "no_match",
                ]),
                reason: z.string().max(600),
                probability: z.null(),
              })
              .strict(),
            checked_topics: z.array(z.string().max(160)).max(20),
            gaps: z.array(z.string().max(600)).max(20),
            searches_used: z.number().int().min(0).max(32),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        status: z.literal("low_confidence"),
        pkm_written: z.literal(false),
        verification,
      })
      .strict(),
    z
      .object({
        status: z.enum([
          "disabled",
          "not_ready",
          "insufficient_identity",
          "saved",
        ]),
        pkm_written: z.literal(false),
      })
      .strict(),
    z
      .object({
        status: z.literal("unavailable"),
        pkm_written: z.literal(false),
        retry_exhausted: z.literal(true).optional(),
        attempts: z.number().int().min(1).max(7).optional(),
      })
      .strict(),
  ])
  .refine(
    (value) =>
      value.status !== "unavailable" ||
      (value.retry_exhausted === true) === (value.attempts !== undefined),
  );
const pendingResponse = z
  .object({
    status: z.literal("pending"),
    pkm_written: z.literal(false),
    restart_required: z.boolean(),
  })
  .strict();
const jobResponse = z.union([response, pendingResponse]);

/** One timer/request at a time; foreground/online resume never causes a burst. */
function waitForPoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const finish = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const resume = () => {
      if (document.visibilityState === "visible") finish();
    };
    const timer = setTimeout(finish, milliseconds);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", resume);
      if (typeof window !== "undefined")
        window.removeEventListener("online", finish);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", resume);
    if (typeof window !== "undefined")
      window.addEventListener("online", finish);
  });
}

export type ProfileReport = z.infer<typeof report>;
export const profileReportSchema = report;
export type ProfileResearchResult = z.infer<typeof response>;
export const PROFILE_SECTION_LABELS = {
  business: "Business",
  career: "Career",
  education: "Education",
  personal: "Personal details",
  projects: "Projects",
  publications: "Publications",
  achievements: "Achievements",
  community: "Community",
  interests: "Interests",
  preferences: "Preferences",
  dislikes: "Dislikes",
  style: "Style & colors",
  food: "Food",
  travel: "Travel",
  entertainment: "Entertainment",
  shopping: "Shopping",
  communication: "Communication",
  digital_presence: "Public profiles",
  public_records: "Professional records",
  security: "Security",
} as const;

export const ProfileResearchService = {
  async discard(input: {
    vaultKey: string;
    vaultOwnerToken: string;
    draftId?: string;
    sourceReview?: boolean;
  }): Promise<void> {
    z.object({ discarded: z.literal(true) })
      .strict()
      .parse(
        await apiJson(
          `/api/one/world-model/${input.sourceReview ? "source-reviews" : "jobs"}${input.draftId ? `?draft_id=${encodeURIComponent(input.draftId)}` : ""}`,
          {
            method: "DELETE",
            cache: "no-store",
            headers: {
              Authorization: `Bearer ${input.vaultOwnerToken}`,
              ...(await oneChatKeyHeaders(input.vaultKey)),
            },
          },
        ),
      );
  },
  /** Only acknowledged owner-reviewed PKM receipts can complete the offer. */
  async complete(input: {
    vaultKey: string;
    vaultOwnerToken: string;
    commits: { domain: string; planId: string }[];
    worldModel?: boolean;
    draftId?: string;
    sourceReview?: boolean;
  }): Promise<void> {
    const result = await apiJson<unknown>(
      input.sourceReview
        ? "/api/one/world-model/source-reviews/complete"
        : input.worldModel
          ? "/api/one/world-model/complete"
          : "/api/one/profile-research/complete",
      {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${input.vaultOwnerToken}`,
          "Content-Type": "application/json",
          ...(await oneChatKeyHeaders(input.vaultKey)),
        },
        body: JSON.stringify({
          ...(input.worldModel || input.sourceReview
            ? { draft_id: input.draftId }
            : {}),
          commits: input.commits.map(({ domain, planId }) => ({
            domain,
            plan_id: planId,
          })),
        }),
      },
    );
    z.object({ saved: z.literal(true) })
      .strict()
      .parse(result);
  },
  /** The server selects the current owner; identifiers never ride in request bodies. */
  async research(input: {
    vaultKey: string;
    vaultOwnerToken: string;
    signal: AbortSignal;
    isCurrent?: () => boolean;
    worldModel?: boolean;
  }): Promise<ProfileResearchResult> {
    const assertCurrent = () => {
      if (input.signal.aborted || input.isCurrent?.() === false)
        throw new DOMException("Aborted", "AbortError");
    };
    const deadline = Date.now() + 330_000;
    let method = "POST";
    let delay = 3000;
    for (;;) {
      assertCurrent();
      if (Date.now() >= deadline)
        return { status: "unavailable", pkm_written: false };
      const keyHeaders = await oneChatKeyHeaders(input.vaultKey);
      assertCurrent();
      let payload: unknown;
      try {
        payload = await apiJson<unknown>(
          input.worldModel
            ? "/api/one/world-model/jobs"
            : "/api/one/profile-research/jobs",
          {
            method,
            cache: "no-store",
            signal: input.signal,
            headers: {
              Authorization: `Bearer ${input.vaultOwnerToken}`,
              ...keyHeaders,
            },
          },
        );
      } catch (error) {
        assertCurrent();
        if (
          error instanceof ApiError &&
          error.status !== 429 &&
          error.status < 500
        )
          throw error;
        // A lost start response may already have dispatched work. Read status
        // instead of replaying POST. This session never restarts research.
        method = "GET";
        delay = Math.min(delay * 2, 30_000);
        await waitForPoll(input.signal, delay);
        continue;
      }
      assertCurrent();
      const result = jobResponse.parse(payload);
      if (result.status !== "pending") {
        if (input.worldModel && result.status === "offered" && !result.draft_id)
          throw new Error("Missing reviewed draft identity");
        return result;
      }
      method = "GET";
      if (result.restart_required) {
        return { status: "unavailable", pkm_written: false };
      }
      delay =
        typeof document !== "undefined" && document.visibilityState === "hidden"
          ? 20_000
          : 3000;
      await waitForPoll(input.signal, delay);
    }
  },
};

export const profileResearchResultSchema = response;

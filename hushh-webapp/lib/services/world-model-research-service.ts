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
    input: PwmAuthority & {
      signal: AbortSignal;
      onResult: (result: PwmResult) => void;
      refresh?: boolean;
      /** Past owner decisions, so research does not propose them again. */
      ownerDecisions?: PwmOwnerDecisions;
    },
  ) {
    let path = input.refresh ? "jobs" : "ensure",
      method = "POST",
      failures = 0,
      deadline = Date.now() + 3_600_000;
    while (Date.now() < deadline) {
      if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
      try {
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
        failures = 0;
        input.onResult(result);
        if (result.status !== "pending" && result.status !== "paused") return;
        path = result.restart_required ? "ensure" : "jobs";
        method = result.restart_required ? "POST" : "GET";
      } catch (error) {
        if (input.signal.aborted) throw error;
        if (
          error instanceof ApiError &&
          error.status < 500 &&
          error.status !== 429
        )
          throw error;
        if (++failures >= 5) throw error;
        // A lost response can already have started research; read before retrying.
        path = "jobs";
        method = "GET";
      }
      await pause(
        input.signal,
        failures ? Math.min(30_000, 3000 * 2 ** failures) : 5000,
      );
      const hiddenSince = Date.now();
      await whenVisible(input.signal);
      // Time away from the tab does not spend the one-hour polling budget.
      deadline += Date.now() - hiddenSince;
    }
    input.onResult({
      status: "paused",
      pkm_written: false,
      restart_required: true,
    });
  },
};

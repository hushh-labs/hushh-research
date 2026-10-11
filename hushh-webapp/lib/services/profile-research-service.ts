import { z } from "zod";
import { apiJson } from "@/lib/services/api-client";
import { oneChatKeyHeaders } from "@/lib/vault/one-chat-key";

const source = z
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
const fact = z
  .object({
    statement: z.string().min(1).max(600),
    confidence: z.enum(["supported", "uncertain", "conflicting"]),
    sources: z.array(source).min(1).max(3),
  })
  .strict();
const report = z
  .object({
    match_status: z.enum(["matched", "uncertain", "no_match"]),
    name: z.string().min(1).max(160),
    summary: z.string().min(1).max(500),
    sections: z
      .array(
        z
          .object({
            kind: z.enum(["business", "career", "education", "personal"]),
            facts: z.array(fact).min(1).max(8),
          })
          .strict(),
      )
      .max(4),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.sections.map((section) => section.kind)).size ===
        value.sections.length &&
      (value.match_status === "no_match") === (value.sections.length === 0),
  );
const response = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("offered"),
      pkm_written: z.literal(false),
      report,
      search_suggestions: z.array(z.string().max(40_000)).max(5),
    })
    .strict(),
  z
    .object({
      status: z.enum([
        "disabled",
        "not_ready",
        "insufficient_identity",
        "unavailable",
      ]),
      pkm_written: z.literal(false),
    })
    .strict(),
]);

export type ProfileReport = z.infer<typeof report>;
export type ProfileResearchResult = z.infer<typeof response>;
export const PROFILE_SECTION_LABELS = {
  business: "Business",
  career: "Career",
  education: "Education",
  personal: "Personal details",
} as const;

export const ProfileResearchService = {
  /** The server selects the current owner; identifiers never ride in request bodies. */
  async research(input: {
    vaultKey: string;
    vaultOwnerToken: string;
    signal: AbortSignal;
  }): Promise<ProfileResearchResult> {
    return response.parse(
      await apiJson<unknown>("/api/one/profile-research", {
        method: "POST",
        cache: "no-store",
        signal: input.signal,
        headers: {
          Authorization: `Bearer ${input.vaultOwnerToken}`,
          ...(await oneChatKeyHeaders(input.vaultKey)),
        },
      }),
    );
  },
};

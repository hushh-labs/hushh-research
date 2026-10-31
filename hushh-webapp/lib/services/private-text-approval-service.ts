import { z } from "zod";

import { PRIVATE_TEXT_DISCLOSURE_VERSION } from "@/lib/legal/private-text-disclosure";
import { ApiError, apiErrorCode, apiJson } from "@/lib/services/api-client";

const ENDPOINT = "/api/one/models/private-text-approval?include_policy=true&include_processing_provider=true";
const approvalSchema = z.object({
  provider: z.literal("azure_openai"),
  disclosure_version: z.literal(PRIVATE_TEXT_DISCLOSURE_VERSION),
  enabled: z.boolean(),
  generation: z.uuid().nullable(),
  accepted_at: z.string().min(1).nullable(),
  revoked_at: z.string().min(1).nullable(),
  processing_policy: z.object({
    enabled: z.boolean(),
    provider: z.enum(["azure_openai", "gemini"]).nullable().optional(),
    basis: z.enum(["owner_approval", "uat_policy", "disabled"]),
    version: z.string().min(1).nullable(),
    generation: z.uuid().nullable(),
    scope: z.literal("one_text_chat_and_drive_requests"),
  }).strict().refine(value => !value.enabled || (
    value.basis !== "disabled" && value.version !== null && value.generation !== null
  ), "Processing requires current authority").optional(),
}).strict().refine(
  value => !value.enabled || (value.generation !== null && value.accepted_at !== null && value.revoked_at === null),
  "Approval requires a persisted acknowledgment",
);

export type PrivateTextApproval = z.infer<typeof approvalSchema>;

export function isPrivateTextApprovalConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 &&
    apiErrorCode(error) === "PRIVATE_AZURE_TEXT_APPROVAL_CHANGED";
}

export const PrivateTextApprovalService = {
  async get(idToken: string): Promise<PrivateTextApproval | null> {
    try {
      return approvalSchema.parse(await apiJson<unknown>(ENDPOINT, {
        method: "GET", headers: { Authorization: `Bearer ${idToken}` }, cache: "no-store",
      }));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 ||
        error.status === 403 && apiErrorCode(error) === "PRIVATE_AZURE_TEXT_UAT_ONLY")) return null;
      throw error;
    }
  },

  async set(idToken: string, enabled: boolean, expectedGeneration: PrivateTextApproval["generation"]): Promise<PrivateTextApproval> {
    const approval = approvalSchema.parse(await apiJson<unknown>(ENDPOINT, {
      method: "PUT",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(enabled ? {
        enabled: true, disclosure_version: PRIVATE_TEXT_DISCLOSURE_VERSION, expected_generation: expectedGeneration,
      } : { enabled: false, expected_generation: expectedGeneration }),
      cache: "no-store",
    }));
    if (approval.enabled !== enabled) throw new Error("Approval was not acknowledged");
    return approval;
  },
};

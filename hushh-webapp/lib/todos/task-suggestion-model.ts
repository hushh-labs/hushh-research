import { z } from "zod";
import { ONE_CAPABILITIES, isOneCapabilityEnabled } from "@/lib/onboarding/one-capabilities";

export const taskCapabilitySchema = z.enum(["messages", "finance", "wallet", "location", "ria", "gmail", "calendar", "pkm", "consent"]);
export type TaskCapability = z.infer<typeof taskCapabilitySchema>;
export type TaskCoverage = {
  capability: TaskCapability;
  status: "ready" | "unavailable" | "incomplete" | "not_connected";
  count: number;
};
/** Presentation identities stay with One's existing capability catalog. */
export function taskCapabilities() {
  return ONE_CAPABILITIES.filter(item => item.isVisibleOnRoster !== false && isOneCapabilityEnabled(item) && taskCapabilitySchema.safeParse(item.id).success);
}
export type TaskEvidence = {
  capability: TaskCapability;
  key: string;
  summary: string;
  href: string;
  /** Existing pending tasks are shown directly, never proposed again. */
  pendingTitle?: string;
};
export const taskSuggestionSchema = z.object({
  items: z.array(z.object({ source_ref: z.string(), title: z.string().min(1).max(160), reason: z.string().min(1).max(240) }).strict()).max(12),
}).strict();
export type TaskSuggestion = { key: string; capability: TaskCapability; title: string; reason: string; href: string };

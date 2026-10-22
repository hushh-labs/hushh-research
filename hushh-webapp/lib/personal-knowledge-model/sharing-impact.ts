/** Fail closed on unverified sharing metadata before an information mutation. */
import type { PkmMutationSharingImpact } from "@/lib/services/personal-knowledge-model-service";

export function parsePkmSharingImpact(value: unknown): PkmMutationSharingImpact {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const lists = [payload.recipient_labels, payload.affected_grant_ids, payload.affected_export_ids];
  if (
    !Number.isSafeInteger(payload.active_recipient_count) ||
    Number(payload.active_recipient_count) < 0 ||
    typeof payload.enters_next_export_revision !== "boolean" ||
    typeof payload.summary !== "string" || !payload.summary.trim() ||
    lists.some((ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
  ) {
    throw new Error("Current sharing could not be verified. Refresh and try again.");
  }
  return {
    activeRecipientCount: Number(payload.active_recipient_count),
    recipientLabels: (payload.recipient_labels as string[]).filter(Boolean),
    entersNextExportRevision: payload.enters_next_export_revision,
    summary: payload.summary.trim(),
    affectedGrantIds: (payload.affected_grant_ids as string[]).filter(Boolean),
    affectedExportIds: (payload.affected_export_ids as string[]).filter(Boolean),
  };
}

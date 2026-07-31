export const GMAIL_RECEIPTS_API_TEMPLATES = {
  connectStart: "/api/kai/gmail/connect/start",
  connectComplete: "/api/kai/gmail/connect/complete",
  status: "/api/kai/gmail/status/{user_id}",
  disconnect: "/api/kai/gmail/disconnect",
  reconcile: "/api/kai/gmail/reconcile",
  sync: "/api/kai/gmail/sync",
  syncRun: "/api/kai/gmail/sync/{run_id}",
  receipts: "/api/kai/gmail/receipts/{user_id}",
  receiptsMemoryPreview: "/api/kai/gmail/receipts-memory/preview",
  receiptsMemoryArtifact: "/api/kai/gmail/receipts-memory/artifacts/{artifact_id}",
} as const;

export const SUPPORT_API_TEMPLATES = {
  message: "/api/kai/support/message",
} as const;

function encodePathParam(value: string): string {
  return encodeURIComponent(String(value || "").trim());
}

export function buildGmailStatusPath(userId: string): string {
  return GMAIL_RECEIPTS_API_TEMPLATES.status.replace("{user_id}", encodePathParam(userId));
}

export function buildGmailSyncRunPath(runId: string): string {
  return GMAIL_RECEIPTS_API_TEMPLATES.syncRun.replace("{run_id}", encodePathParam(runId));
}

export function buildGmailReceiptsPath(userId: string): string {
  return GMAIL_RECEIPTS_API_TEMPLATES.receipts.replace("{user_id}", encodePathParam(userId));
}

export function buildGmailReceiptMemoryArtifactPath(artifactId: string): string {
  return GMAIL_RECEIPTS_API_TEMPLATES.receiptsMemoryArtifact.replace(
    "{artifact_id}",
    encodePathParam(artifactId)
  );
}

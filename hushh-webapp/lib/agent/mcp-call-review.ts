/** Ephemeral review references, never conversation descriptors or capabilities. */
export type McpCallReviewReference = {
  kind: "mcp_call_review";
  version: 1;
  connectorId: string;
  toolName: string;
  directiveId: string;
  pendingHandle: string;
  expiresAt: string;
};

export type McpCallPreview = McpCallReviewReference & {
  toolLabel: string;
  arguments: Record<string, unknown>;
};

export type McpCallApproval = Pick<McpCallReviewReference,
  "connectorId" | "toolName" | "directiveId" | "pendingHandle"
> & { receipt: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

const patterns = {
  connectorId: /^[A-Za-z0-9_-]{1,128}$/,
  toolName: /^mcp_[0-9a-f]{40}$/,
  directiveId: /^dir_[0-9a-f]{32}$/,
  pendingHandle: /^one_secret_ref:[A-Za-z0-9_-]{32}$/,
};

/** Only accept the bounded server projection of ADK's native confirmation. */
export function parseMcpCallReview(value: unknown): McpCallReviewReference | null {
  const args = record(value);
  const original = record(args?.originalFunctionCall);
  const confirmation = record(args?.toolConfirmation);
  const payload = record(confirmation?.payload);
  if (!payload || payload.kind !== "mcp_call_review" || payload.version !== 1 ||
      confirmation?.confirmed !== false || original?.name !== payload.toolName) return null;
  const originalArgs = record(original?.args);
  if (!originalArgs || Object.keys(originalArgs).length !== 0) return null;
  for (const [key, pattern] of Object.entries(patterns)) {
    if (typeof payload[key] !== "string" || !pattern.test(payload[key])) return null;
  }
  if (typeof payload.expiresAt !== "string" || payload.expiresAt.length > 64 ||
      !Number.isFinite(Date.parse(payload.expiresAt))) return null;
  return {
    kind: "mcp_call_review", version: 1,
    connectorId: payload.connectorId as string,
    toolName: payload.toolName as string,
    directiveId: payload.directiveId as string,
    pendingHandle: payload.pendingHandle as string,
    expiresAt: payload.expiresAt,
  };
}

export function parseMcpCallPreview(
  value: unknown, reference: McpCallReviewReference,
): McpCallPreview | null {
  const preview = record(value);
  if (!preview || preview.status !== "review_required") return null;
  for (const key of [...Object.keys(patterns), "expiresAt"]) {
    if (preview[key] !== reference[key as keyof McpCallReviewReference]) return null;
  }
  const args = record(preview.arguments);
  if (!args || typeof preview.toolLabel !== "string" ||
      !preview.toolLabel.trim() || preview.toolLabel.length > 256) return null;
  try {
    if (new TextEncoder().encode(JSON.stringify(args)).length > 32_768) return null;
  } catch { return null; }
  return { ...reference, toolLabel: preview.toolLabel, arguments: args };
}

/** Approval travels only in scrubbed forwardedProps, not native tool output. */
export function parseMcpCallApproval(
  value: unknown, reference: McpCallReviewReference,
): McpCallApproval | null {
  const receipt = record(value);
  if (!receipt || receipt.status !== "confirmed" ||
      receipt.directiveId !== reference.directiveId ||
      typeof receipt.receipt !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(receipt.receipt)) return null;
  return {
    connectorId: reference.connectorId, toolName: reference.toolName,
    directiveId: reference.directiveId, pendingHandle: reference.pendingHandle,
    receipt: receipt.receipt,
  };
}

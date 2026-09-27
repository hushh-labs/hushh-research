import type { SpecialistDirective } from "@/lib/agent/specialist-directive-runtime";
import type { SpecialistDirectiveEvent } from "@/lib/services/agent-chat-client";
import { ApiService } from "@/lib/services/api-service";

export const DRIVE_REVIEW_DELEGATE = "agent_documents";
export const DRIVE_REVIEW_TYPE = "drive.execute_review";

type DriveReviewAction = "share" | "trash";

type DriveReviewPayload = {
  type: typeof DRIVE_REVIEW_TYPE;
  directiveId: string;
  conversationId: string;
  action: DriveReviewAction;
  arguments: Record<string, unknown>;
  summary: string;
  confirmLabel: string;
};

function reviewPayload(value: unknown): DriveReviewPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.type !== DRIVE_REVIEW_TYPE ||
    typeof payload.directiveId !== "string" ||
    !/^dir_[0-9a-f]{32}$/.test(payload.directiveId) ||
    typeof payload.conversationId !== "string" ||
    !payload.conversationId ||
    (payload.action !== "share" && payload.action !== "trash") ||
    !payload.arguments ||
    typeof payload.arguments !== "object" ||
    Array.isArray(payload.arguments) ||
    typeof payload.summary !== "string" ||
    typeof payload.confirmLabel !== "string"
  ) {
    return null;
  }
  return payload as DriveReviewPayload;
}

// Only these server tools issue a Drive review. Any other tool's result, even
// one that copies this shape, never opens the card.
const DRIVE_REVIEW_TOOLS = new Set([
  "propose_drive_file_share",
  "propose_drive_file_trash",
]);
const ROLE_LABELS: Record<string, string> = {
  reader: "Viewer",
  commenter: "Commenter",
  writer: "Editor",
};
const TITLE_LIMIT = 80;

function cardText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/["“”„‟«»‹›]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return fallback;
  return text.length <= TITLE_LIMIT
    ? text
    : `${text.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

/**
 * The exact terms the owner is approving, one labelled line each, taken from
 * the server-validated arguments rather than the model-facing summary sentence.
 */
export function driveReviewDetails(
  payload: Record<string, unknown>,
): { label: string; value: string }[] {
  const reviewed = reviewPayload(payload);
  if (!reviewed) return [];
  const file = (payload.file ?? {}) as Record<string, unknown>;
  const lines = [
    {
      label: file.isFolder === true ? "Folder (and everything in it)" : "File",
      value: cardText(file.title, "this file"),
    },
  ];
  if (reviewed.action === "share") {
    const args = reviewed.arguments;
    lines.push({ label: "Share with", value: String(args.email ?? "") });
    lines.push({
      label: "Access",
      value: ROLE_LABELS[String(args.role)] ?? "Viewer",
    });
    lines.push({
      label: "Google email",
      value: args.notify === false ? "Not sent" : "Sent to them",
    });
  }
  return lines;
}

/** The Drive share/trash review card for a proposal tool result, if it is one. */
export function getDriveReviewDirectiveFromToolResult(
  toolName: unknown,
  rawResult: unknown,
): SpecialistDirectiveEvent | null {
  if (typeof toolName !== "string" || !DRIVE_REVIEW_TOOLS.has(toolName))
    return null;
  let parsed: unknown = rawResult;
  if (typeof rawResult === "string") {
    try {
      parsed = JSON.parse(rawResult);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const directive = (parsed as Record<string, unknown>).directive as
    Record<string, unknown> | undefined;
  if (!directive || directive.delegateAgentId !== DRIVE_REVIEW_DELEGATE)
    return null;
  const payload = reviewPayload(directive.payload);
  if (!payload) return null;
  return {
    delegateAgentId: DRIVE_REVIEW_DELEGATE,
    directive: { kind: "action", payload },
    message: payload.summary,
    stateChanged: true,
  };
}

async function errorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    detail?: { message?: string } | string;
  } | null;
  const detail = body?.detail;
  return (typeof detail === "string" ? detail : detail?.message) || fallback;
}

/**
 * Execute exactly the Drive call the owner reviewed. The server rebuilds the
 * terms from these arguments and its current Drive connection and matches them
 * against the one-use review it issued; anything changed is refused.
 */
export async function runDriveReviewDirective(
  directive: SpecialistDirective,
  vaultOwnerToken: string,
  userId: string,
): Promise<{ detail: string }> {
  const payload = reviewPayload(directive.payload);
  if (!payload) throw new Error("Drive confirmation is invalid.");
  const response = await ApiService.apiFetch(
    "/api/one/drive/reviewed-actions/execute",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vaultOwnerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: userId,
        conversation_id: payload.conversationId,
        directive_id: payload.directiveId,
        action: payload.action,
        arguments: payload.arguments,
        confirmed: true,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      await errorMessage(response, "Unable to apply the Drive change."),
    );
  }
  return {
    detail:
      payload.action === "share"
        ? "Shared in Google Drive."
        : "Moved to trash in Google Drive.",
  };
}

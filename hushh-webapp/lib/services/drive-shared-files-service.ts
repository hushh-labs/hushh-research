/**
 * The owner's list of files One shared for one document request, and per-file
 * access removal. Owner only: the server answers the requester with 404.
 *
 * File names are the owner's own files. Responses stay in memory, never a cache.
 */
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";

const SHARING_PATH = "/api/connectors/google_drive/sharing";
const RESPONSE_MAX_LENGTH = 64 * 1024;
const FILE_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,5}$/;

export const SHARED_FILE_STATUSES = [
  "shared",
  "had_access",
  "removing",
  "removed",
  "needs_attention",
] as const;
export type SharedFileStatus = (typeof SHARED_FILE_STATUSES)[number];

export type SharedFile = {
  fileRef: string;
  name: string;
  modifiedTime: string | null;
  status: SharedFileStatus;
  removable: boolean;
  undoable: boolean;
};

export type SharedFilesPage = {
  requestId: string;
  recipientLabel: string | null;
  sharedCount: number;
  files: SharedFile[];
  nextCursor: string | null;
  undoSeconds: number;
};

export type SharedFileChange = {
  fileRef: string;
  status: SharedFileStatus;
  undoable: boolean;
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DriveSharingError("invalid_response");
  return value as RecordValue;
}

function fileRef(value: unknown): string {
  if (typeof value !== "string" || !FILE_REF.test(value))
    throw new DriveSharingError("invalid_response");
  return value;
}

function status(value: unknown): SharedFileStatus {
  if (!SHARED_FILE_STATUSES.includes(value as SharedFileStatus))
    throw new DriveSharingError("invalid_response");
  return value as SharedFileStatus;
}

function parseFile(value: unknown): SharedFile {
  const item = record(value);
  if (typeof item.name !== "string" || item.name.length > 300)
    throw new DriveSharingError("invalid_response");
  return {
    fileRef: fileRef(item.fileRef),
    name: item.name,
    modifiedTime: typeof item.modifiedTime === "string" ? item.modifiedTime : null,
    status: status(item.status),
    removable: item.removable === true,
    undoable: item.undoable === true,
  };
}

function parseChange(value: unknown): SharedFileChange {
  const item = record(value);
  return {
    fileRef: fileRef(item.fileRef),
    status: status(item.status),
    undoable: item.undoable === true,
  };
}

export function parseSharedFilesPage(value: unknown, requestId: string): SharedFilesPage {
  const page = record(value);
  if (page.requestId !== requestId || !Array.isArray(page.files))
    throw new DriveSharingError("invalid_response");
  const count = page.sharedCount;
  const undo = page.undoSeconds;
  if (!Number.isSafeInteger(count) || (count as number) < 0)
    throw new DriveSharingError("invalid_response");
  return {
    requestId,
    recipientLabel:
      typeof page.recipientLabel === "string" && page.recipientLabel.trim()
        ? page.recipientLabel.slice(0, 160)
        : null,
    sharedCount: count as number,
    files: page.files.map(parseFile),
    nextCursor: page.nextCursor == null ? null : fileRef(page.nextCursor),
    undoSeconds:
      Number.isSafeInteger(undo) && (undo as number) > 0 && (undo as number) <= 60
        ? (undo as number)
        : 8,
  };
}

async function send(path: string, token: string, body?: object): Promise<RecordValue> {
  const response = await ApiService.apiFetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: { ...ApiService.getAuthHeaders(token), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const serialized = await response.text();
  if (serialized.length > RESPONSE_MAX_LENGTH)
    throw new DriveSharingError("invalid_response", response.status);
  let payload: RecordValue;
  try {
    payload = record(JSON.parse(serialized));
  } catch {
    throw new DriveSharingError("invalid_response", response.status);
  }
  if (!response.ok) {
    const detail =
      payload.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail)
        ? (payload.detail as RecordValue)
        : payload;
    // Only a closed lowercase code ever reaches the UI, never a server message.
    const code =
      typeof detail.code === "string" && /^[a-z_]{1,80}$/.test(detail.code)
        ? detail.code
        : "request_failed";
    throw new DriveSharingError(code, response.status);
  }
  return payload;
}

function requestPath(requestId: string, action = ""): string {
  if (!DOCUMENT_REQUEST_UUID.test(requestId)) throw new DriveSharingError("invalid_argument");
  return `${SHARING_PATH}/requests/${requestId}/shared-files${action}`;
}

export class DriveSharedFilesService {
  static async list(
    token: string,
    requestId: string,
    cursor: string | null = null,
  ): Promise<SharedFilesPage> {
    if (cursor !== null && !FILE_REF.test(cursor)) throw new DriveSharingError("invalid_argument");
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return parseSharedFilesPage(await send(requestPath(requestId) + query, token), requestId);
  }

  /** Queues removal; the server waits a few seconds so Undo can cancel it. */
  static async remove(token: string, requestId: string, ref: string): Promise<SharedFileChange> {
    return parseChange(await send(requestPath(requestId, "/remove"), token, { fileRef: fileRef(ref) }));
  }

  /** Undo: cancels a removal that has not started. */
  static async restore(token: string, requestId: string, ref: string): Promise<SharedFileChange> {
    return parseChange(await send(requestPath(requestId, "/restore"), token, { fileRef: fileRef(ref) }));
  }
}

/**
 * The owner's possible matches for one automatic document request (decision
 * D3), and one-tap Send. A possible match passed the request's checks but its
 * own title does not name what the requester asked for, so One never sends it
 * on its own. Owner only: the server answers the requester with 404.
 *
 * File names are the owner's own files. Responses stay in memory, never a cache.
 */
import { DOCUMENT_REQUEST_UUID } from "@/lib/consent/document-share-consent";
import { ApiService } from "@/lib/services/api-service";
import { DriveSharingError } from "@/lib/services/drive-sharing-service";

const SHARING_PATH = "/api/connectors/google_drive/sharing";
const RESPONSE_MAX_LENGTH = 96 * 1024;
const MATCH_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,5}$/;
/** The server accepts at most this many refs per Send. */
export const POSSIBLE_MATCH_SEND_LIMIT = 100;

export const POSSIBLE_MATCH_KINDS = ["content", "corrected", "synonym", "walk"] as const;
export type PossibleMatchKind = (typeof POSSIBLE_MATCH_KINDS)[number];

/** possible: not sent. queued: sent, waiting for the next batch. sending: in a batch. */
export const POSSIBLE_MATCH_STATUSES = ["possible", "queued", "sending"] as const;
export type PossibleMatchStatus = (typeof POSSIBLE_MATCH_STATUSES)[number];

export type PossibleMatch = {
  matchRef: string;
  name: string;
  modifiedTime: string | null;
  kind: PossibleMatchKind;
  status: PossibleMatchStatus;
};

export type PossibleMatchesPage = {
  requestId: string;
  /** False once the request has finished: the list is then read-only. */
  canSend: boolean;
  count: number;
  matches: PossibleMatch[];
};

export type PossibleMatchChange = { matchRef: string; status: PossibleMatchStatus };

export type PossibleMatchSendResult = {
  requestId: string;
  queued: number;
  matches: PossibleMatchChange[];
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DriveSharingError("invalid_response");
  return value as RecordValue;
}

function matchRef(value: unknown): string {
  if (typeof value !== "string" || !MATCH_REF.test(value))
    throw new DriveSharingError("invalid_response");
  return value;
}

function status(value: unknown): PossibleMatchStatus {
  if (!POSSIBLE_MATCH_STATUSES.includes(value as PossibleMatchStatus))
    throw new DriveSharingError("invalid_response");
  return value as PossibleMatchStatus;
}

function parseMatch(value: unknown): PossibleMatch {
  const item = record(value);
  if (typeof item.name !== "string" || item.name.length > 300)
    throw new DriveSharingError("invalid_response");
  return {
    matchRef: matchRef(item.matchRef),
    name: item.name,
    modifiedTime: typeof item.modifiedTime === "string" ? item.modifiedTime : null,
    // An unknown reason reads as the plainest one; it never blocks the list.
    kind: POSSIBLE_MATCH_KINDS.includes(item.kind as PossibleMatchKind)
      ? (item.kind as PossibleMatchKind)
      : "content",
    status: status(item.status),
  };
}

export function parsePossibleMatchesPage(value: unknown, requestId: string): PossibleMatchesPage {
  const page = record(value);
  if (page.requestId !== requestId || !Array.isArray(page.matches))
    throw new DriveSharingError("invalid_response");
  const count = page.count;
  if (!Number.isSafeInteger(count) || (count as number) < 0)
    throw new DriveSharingError("invalid_response");
  const matches = page.matches.map(parseMatch);
  return {
    requestId,
    canSend: page.canSend === true,
    count: Math.max(count as number, matches.length),
    matches,
  };
}

export function parsePossibleMatchSend(value: unknown, requestId: string): PossibleMatchSendResult {
  const result = record(value);
  if (result.requestId !== requestId || !Array.isArray(result.matches))
    throw new DriveSharingError("invalid_response");
  const queued = result.queued;
  return {
    requestId,
    queued: Number.isSafeInteger(queued) && (queued as number) >= 0 ? (queued as number) : 0,
    matches: result.matches.map((item) => {
      const change = record(item);
      return { matchRef: matchRef(change.matchRef), status: status(change.status) };
    }),
  };
}

async function request(path: string, token: string, body?: object): Promise<RecordValue> {
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
  return `${SHARING_PATH}/requests/${requestId}/possible-matches${action}`;
}

export class DrivePossibleMatchesService {
  static async list(token: string, requestId: string): Promise<PossibleMatchesPage> {
    return parsePossibleMatchesPage(await request(requestPath(requestId), token), requestId);
  }

  /** Queues the owner's chosen files for the next batch. Nothing is shared in this call. */
  static async send(
    token: string,
    requestId: string,
    refs: string[],
  ): Promise<PossibleMatchSendResult> {
    if (refs.length < 1 || refs.length > POSSIBLE_MATCH_SEND_LIMIT || new Set(refs).size !== refs.length)
      throw new DriveSharingError("invalid_argument");
    for (const ref of refs) {
      if (!MATCH_REF.test(ref)) throw new DriveSharingError("invalid_argument");
    }
    return parsePossibleMatchSend(
      await request(requestPath(requestId, "/send"), token, { matchRefs: refs }),
      requestId,
    );
  }
}

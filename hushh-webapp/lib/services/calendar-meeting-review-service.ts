import { ApiService } from "@/lib/services/api-service";
import { DriveSharingError } from "@/lib/services/drive-sharing-wire";

const ROOT = "/api/connectors/google_drive/sharing/calendar-requests";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_ID = /^[A-Za-z0-9_-]{10,255}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DriveSharingError("invalid_response");
  return value as Record<string, unknown>;
}

export type CalendarRequestPreview = {
  requestId: string; revision: number; status: string; recipientEmail: string;
  ownerDriveReady: boolean;
  meeting: { title: string; date: string; start_at: string; organizer_email: string;
    account_id: string; occurrence_id: string; requested_types: ("recording" | "notes")[];
    exact_refs?: { file_id: string; kind: "recording" | "notes" }[] };
};
export type CalendarCandidate = { file_id: string; name: string; mime_type: string; artifact_kind: "recording" | "notes" };
export type CalendarSearch = { files: CalendarCandidate[]; candidateToken: Record<string, unknown>; hasMore: boolean; accountLabel: string | null };

export class CalendarMeetingReviewService {
  private static async call(requestId: string, token: string, suffix = "", body?: object): Promise<Record<string, unknown>> {
    if (!UUID.test(requestId)) throw new DriveSharingError("invalid_selection");
    const response = await ApiService.apiFetch(`${ROOT}/${requestId}${suffix}`, {
      method: body === undefined ? "GET" : "POST", cache: "no-store",
      headers: { ...ApiService.getAuthHeaders(token), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.json().catch(() => null);
    const value = object(raw);
    if (!response.ok) {
      const detail = value.detail && typeof value.detail === "object" ? object(value.detail) : value;
      throw new DriveSharingError(typeof detail.code === "string" ? detail.code : "sharing_unavailable", response.status);
    }
    return value;
  }

  static async preview(requestId: string, token: string): Promise<CalendarRequestPreview> {
    const value = await this.call(requestId, token);
    const meeting = object(value.meeting);
    if (value.requestType !== "calendar_meeting" || value.requestId !== requestId ||
      typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) ||
      typeof value.status !== "string" || typeof value.recipientEmail !== "string" ||
      typeof value.ownerDriveReady !== "boolean" ||
      typeof meeting.title !== "string" || typeof meeting.date !== "string" ||
      typeof meeting.start_at !== "string" || typeof meeting.organizer_email !== "string" ||
      typeof meeting.account_id !== "string" || typeof meeting.occurrence_id !== "string" ||
      !Array.isArray(meeting.requested_types) || !meeting.requested_types.length ||
      meeting.requested_types.some(kind => kind !== "recording" && kind !== "notes") ||
      (meeting.exact_refs !== undefined && (!Array.isArray(meeting.exact_refs) ||
        meeting.exact_refs.length > 8 || meeting.exact_refs.some(raw => {
          const ref = object(raw);
          return typeof ref.file_id !== "string" || !FILE_ID.test(ref.file_id) ||
            (ref.kind !== "recording" && ref.kind !== "notes");
        }))))
      throw new DriveSharingError("invalid_response");
    return value as unknown as CalendarRequestPreview;
  }

  static async search(requestId: string, token: string, query: string): Promise<CalendarSearch> {
    const value = await this.call(requestId, token, "/files", { query });
    return this.parseSearch(value);
  }

  static async linkedFiles(requestId: string, token: string): Promise<CalendarSearch> {
    const value = await this.call(requestId, token, "/linked-files");
    return this.parseSearch(value);
  }

  private static parseSearch(value: Record<string, unknown>): CalendarSearch {
    if (!Array.isArray(value.files) || value.files.length > 25 ||
      typeof value.hasMore !== "boolean" ||
      !(value.accountLabel === null || typeof value.accountLabel === "string"))
      throw new DriveSharingError("invalid_response");
    const files: CalendarCandidate[] = value.files.map(raw => {
      const file = object(raw);
      if (typeof file.file_id !== "string" || !FILE_ID.test(file.file_id) ||
        typeof file.name !== "string" || !file.name || file.name.length > 1024 ||
        typeof file.mime_type !== "string" ||
        (file.artifact_kind !== "recording" && file.artifact_kind !== "notes"))
        throw new DriveSharingError("invalid_response");
      return file as CalendarCandidate;
    });
    if (new Set(files.map(file => file.file_id)).size !== files.length)
      throw new DriveSharingError("invalid_response");
    return { files, candidateToken: object(value.candidateToken), hasMore: value.hasMore,
      accountLabel: value.accountLabel as string | null };
  }

  static async prepare(requestId: string, token: string, search: CalendarSearch, fileIds: string[]): Promise<void> {
    if (!fileIds.length || fileIds.length > 8 || new Set(fileIds).size !== fileIds.length ||
      fileIds.some(id => !search.files.some(file => file.file_id === id)))
      throw new DriveSharingError("invalid_selection");
    const value = await this.call(requestId, token, "/review", {
      candidateToken: search.candidateToken, fileIds, occurrenceConfirmed: true,
    });
    if (value.requestId !== requestId || value.requestType !== "calendar_meeting")
      throw new DriveSharingError("invalid_response");
  }
}

import { ApiService } from "@/lib/services/api-service";
import type { CalendarEventSummary } from "./google-calendar-service";

export type CalendarInsights = {
  complete: boolean; days: { date: string; minutes: number; meetings: number }[];
  meeting_count: number; meeting_minutes: number; overlaps: number; back_to_back: number;
  recurring: { title: string; minutes: number }[]; focus: { start_at: string; end_at: string }[]; time_zone: string;
};
export type MeetingSource = { calendar_id: string; event_id: string };
export type Meeting = CalendarEventSummary & {
  id: string; title: string; calendar_id: string; account_id: string;
  occurrence_id: string; grant_id: string; sources: MeetingSource[];
  artifact_kinds: ("recording" | "notes")[];
};
export type MeetingLibrary = {
  complete: boolean; next_cursor: string | null; date: string; time_zone: string;
  account_id: string; limitations: string[]; checked_events: number; meetings: Meeting[];
  meeting_file_access: "ready" | "missing" | "unverified";
};
export type MeetingArtifact = {
  file_id: string; kind: "recording" | "notes" | "transcript"; state: string;
  title?: string; url?: string; text?: string; text_format?: "plain" | "markdown";
  truncated?: boolean; can_download?: boolean; mime_type?: string; preview_state?: string;
  provenance?: "calendar_linked";
};
export type MeetingDetail = {
  event: Meeting; calendar_id: string; discovery: string; complete: boolean;
  availability?: Partial<Record<MeetingArtifact["kind"], string>>; artifacts: MeetingArtifact[];
};
export type MeetingSelection = { calendar_id: string; event_id: string; expected_account_email: string };
export type VerifiedMeetingSelection = {
  account_id: string; calendar_id: string; event_id: string;
  occurrence_id: string; expected_grant: string; date: string; time_zone: string;
};
export type MeetingContext = { title: string; sources: { title: string; url: string; text: string; truncated: boolean }[] };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class CalendarInsightsRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function validLibrary(value: unknown): value is MeetingLibrary {
  if (!record(value) || !Array.isArray(value.meetings) || !Array.isArray(value.limitations) ||
      typeof value.complete !== "boolean" || typeof value.account_id !== "string" ||
      !["ready", "missing", "unverified"].includes(String(value.meeting_file_access)) ||
      typeof value.date !== "string" || typeof value.time_zone !== "string" ||
      !(value.next_cursor === null || typeof value.next_cursor === "string")) return false;
  return value.meetings.every(item => record(item) && typeof item.id === "string" &&
    typeof item.calendar_id === "string" && typeof item.title === "string" &&
    typeof item.occurrence_id === "string" && /^[a-f0-9]{64}$/.test(item.occurrence_id) &&
    typeof item.grant_id === "string" && /^[a-f0-9]{64}$/.test(item.grant_id) &&
    Array.isArray(item.artifact_kinds) && item.artifact_kinds.length > 0 &&
    item.artifact_kinds.every(kind => kind === "recording" || kind === "notes") &&
    Array.isArray(item.sources) && item.sources.every(source => record(source) &&
      typeof source.calendar_id === "string" && typeof source.event_id === "string"));
}

function validDetail(value: unknown): value is MeetingDetail {
  return record(value) && record(value.event) && Array.isArray(value.artifacts) &&
    typeof value.discovery === "string" && typeof value.complete === "boolean" &&
    value.artifacts.every(item => record(item) && typeof item.file_id === "string" &&
      (item.kind === "recording" || item.kind === "notes" || item.kind === "transcript") &&
      typeof item.state === "string" &&
      (item.can_download === undefined || typeof item.can_download === "boolean") &&
      (item.text === undefined || typeof item.text === "string"));
}

export function safeMeetingProviderUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(url.hostname) ||
        url.username || url.password || (url.port && url.port !== "443") ||
        [...url.searchParams.keys()].some(key => /token|credential|authorization/i.test(key))) return null;
    return value;
  } catch { return null; }
}

export class CalendarInsightsService {
  static async read<T>(path: "insights" | "meetings" | "meetings/detail" | "meetings/context", body: object, idToken: string, signal?: AbortSignal, vaultOwnerToken?: string): Promise<T> {
    const response = await ApiService.apiFetch(`/api/one/calendar/${path}`, {
      method: "POST", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${idToken}`, ...(vaultOwnerToken ? { "X-Hushh-Consent": `Bearer ${vaultOwnerToken}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new CalendarInsightsRequestError(
        typeof result?.detail?.message === "string" ? result.detail.message : "Meeting information could not be checked. Try again.",
        response.status,
      );
    }
    const value: unknown = await response.json();
    if ((path === "meetings" && !validLibrary(value)) || (path === "meetings/detail" && !validDetail(value))) {
      throw new Error("Meeting information was incomplete. Refresh and try again.");
    }
    return value as T;
  }

  static async fileAction(action: "open" | "download", selection: VerifiedMeetingSelection & { file_id: string }, idToken: string, signal?: AbortSignal): Promise<string> {
    const response = await ApiService.apiFetch(`/api/one/calendar/meetings/${action}`, {
      method: "POST", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(selection),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = record(value) && record(value.detail) ? value.detail : null;
      throw new Error(detail && typeof detail.message === "string" ? detail.message : "Download could not be checked. Try again.");
    }
    const url = safeMeetingProviderUrl(record(value) ? value.url : null);
    if (!url) throw new Error("Google did not return a safe download link.");
    return url;
  }
}

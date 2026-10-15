import { ApiService } from "@/lib/services/api-service";
import type { CalendarEventSummary } from "./google-calendar-service";

export type CalendarInsights = {
  complete: boolean; days: { date: string; minutes: number; meetings: number }[];
  meeting_count: number; meeting_minutes: number; overlaps: number; back_to_back: number;
  recurring: { title: string; minutes: number }[]; focus: { start_at: string; end_at: string }[]; time_zone: string;
};
export type Meeting = CalendarEventSummary & { artifact_refs?: { file_id: string; mime_type: string }[]; conference_id?: string; artifact_kinds?: string[]; artifact_status?: string };
export type MeetingLibrary = { complete: boolean; window_days: number; next_page?: number | null; meetings: Meeting[] };
export type MeetingArtifact = { file_id: string; kind: "recording" | "notes" | "transcript"; state: string; title?: string; url?: string; text?: string; truncated?: boolean; can_ask?: boolean; linked_only?: boolean };
export type MeetingDetail = { event: Meeting; calendar_id: string; discovery: string; availability?: Partial<Record<MeetingArtifact["kind"], string>>; complete: boolean; artifacts: MeetingArtifact[] };
export type MeetingSelection = { calendar_id: string; event_id: string; expected_account_email: string };
export type MeetingContext = { title: string; sources: { title: string; url: string; text: string; truncated: boolean }[] };

export class CalendarInsightsService {
  static async read<T>(path: "insights" | "meetings" | "meetings/detail" | "meetings/context", body: object, idToken: string, signal?: AbortSignal, vaultOwnerToken?: string): Promise<T> {
    const response = await ApiService.apiFetch(`/api/one/calendar/${path}`, {
      method: "POST", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${idToken}`, ...(vaultOwnerToken ? { "X-Hushh-Consent": `Bearer ${vaultOwnerToken}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(typeof result?.detail?.message === "string" ? result.detail.message : "Meeting information could not be checked. Try again.");
    }
    return response.json() as Promise<T>;
  }
}

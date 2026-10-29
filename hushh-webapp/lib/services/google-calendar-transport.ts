import { ApiService } from "@/lib/services/api-service";

export type CalendarReadRecovery = "connect" | "reconnect" | "permission" | "retry";
export type CalendarSource = { availability_default_included?: boolean; availability_included?: boolean; time_zone?: string | null; id: string; name?: string; primary?: boolean; access_role?: string; background_color?: string | null };

export function calendarFailure(error: unknown): Error {
  return error instanceof Error ? error : new Error("Calendar could not be checked.");
}

const CALENDAR_RECOVERY: Readonly<Record<string, CalendarReadRecovery>> = {
  calendar_not_connected: "connect",
  calendar_reauthorization_required: "reconnect",
  calendar_permission_required: "permission",
  calendar_list_permission_required: "permission",
  calendar_rate_limited: "retry",
  calendar_timeout: "retry",
  calendar_invalid_response: "retry",
  calendar_connection_changed: "retry",
};

export class GoogleCalendarError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string | null,
    readonly status: number,
    readonly calendarOptions?: CalendarSource[],
  ) {
    super(message);
    this.name = "GoogleCalendarError";
  }

  get recovery(): CalendarReadRecovery {
    return (this.reasonCode && CALENDAR_RECOVERY[this.reasonCode]) || "retry";
  }
}

export async function calendarError(response: Response, fallback: string): Promise<GoogleCalendarError> {
  const body = (await response.json().catch(() => null)) as {
    detail?: { message?: string; reason_code?: string; calendar_options?: CalendarSource[] } | string;
  } | null;
  const detail = body?.detail;
  const message = (typeof detail === "string" ? detail : detail?.message) || fallback;
  const reason = typeof detail === "object" && typeof detail?.reason_code === "string"
    ? detail.reason_code : null;
  return new GoogleCalendarError(message, reason, response.status, typeof detail === "object" && Array.isArray(detail?.calendar_options) ? detail.calendar_options : undefined);
}

type CalendarAuth = { firebaseIdToken: string; signal?: AbortSignal; isEffectCurrent?: () => boolean };

export async function scheduleRequest<T>(path: string, token: string | null, body: object, auth?: CalendarAuth): Promise<T> {
  const response = await ApiService.apiFetch(`/api/one/calendar/${path}`, {
    method: "POST", cache: "no-store", signal: auth?.signal, isEffectCurrent: auth?.isEffectCurrent,
    headers: { ...((auth?.firebaseIdToken || token) ? { Authorization: `Bearer ${auth?.firebaseIdToken || token}`, ...(auth && token ? { "X-Hushh-Consent": `Bearer ${token}` } : {}) } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await calendarError(response, "Calendar could not complete this request.");
  return response.json() as Promise<T>;
}

/** Retry only side-effect-free reads; Calendar mutations must never be replayed. */
export async function scheduleRead<T>(path: string, body: object, auth: CalendarAuth): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    auth.signal?.throwIfAborted();
    if (path === "schedule/availability" && typeof navigator !== "undefined" && !navigator.onLine) throw new GoogleCalendarError("You’re offline. Connect to the internet to check availability.", "calendar_offline", 0);
    if (auth.isEffectCurrent?.() === false) throw new DOMException("Superseded", "AbortError");
    try { return await scheduleRequest<T>(path, null, body, auth); }
    catch (error) {
      const transient = error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError") || (error instanceof GoogleCalendarError && ([408, 502, 503, 504].includes(error.status) || (path === "schedule/availability" && error.status === 429)));
      if ((path === "schedule/availability" && ((typeof navigator !== "undefined" && !navigator.onLine) || (error instanceof GoogleCalendarError && ["calendar_invalid_response", "calendar_unreadable"].includes(error.reasonCode || "")))) || !transient || attempt >= 2 || auth.signal?.aborted || auth.isEffectCurrent?.() === false) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
        const timer = setTimeout(() => { auth.signal?.removeEventListener("abort", abort); resolve(); }, attempt === 0 ? 750 : 2000);
        auth.signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
}

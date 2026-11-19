import { z } from "zod";
import { ApiService } from "./api-service";
import { calendarError } from "./google-calendar-transport";

const eventTime = z.object({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() }).strict().nullable();
const eventsSchema = z.object({
  events: z.array(z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/), title: z.string(), start: eventTime, end: eventTime,
    status: z.string().nullable(), conference_url: z.string().url().optional(),
  }).strict()).max(500),
  time_zone: z.string().nullable(), truncated: z.boolean(),
}).strict();
const mailSchema = z.object({
  items: z.array(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().min(1).max(240) }).strict()).max(25),
  complete: z.boolean(), scope: z.literal("recent_threads"),
}).strict();

/** Typed, bounded content reads on the owner's admitted pod; never the hub. */
export async function privateCalendarEvents(input: { startAt: string; endAt: string; signal?: AbortSignal }) {
  const response = await ApiService.ownerPodRequest("calendar/events", {
    method: "POST", cache: "no-store", signal: input.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start_at: input.startAt, end_at: input.endAt }),
  });
  if (!response.ok) throw await calendarError(response, "Calendar tasks couldn’t load.");
  const value = eventsSchema.parse(await response.json());
  input.signal?.throwIfAborted();
  return value;
}

export async function privateMailTasks(input: { signal?: AbortSignal; isCurrent: () => boolean }) {
  const response = await ApiService.ownerPodRequest("gmail/todos", {
    method: "GET", cache: "no-store", signal: input.signal,
  }, false, undefined, undefined, input.isCurrent);
  if (!response.ok) throw new Error("Email tasks couldn’t load.");
  const result = mailSchema.parse(await response.json());
  if (!input.isCurrent()) throw new DOMException("Session changed", "AbortError");
  return result;
}

import { formatLocalDateTime } from "@/lib/utils/local-date-time";

export function formatMarketQuoteTime(value: string | null | undefined): string {
  return formatLocalDateTime(value, { hour: "numeric", minute: "2-digit" }) ?? "Time unavailable";
}

export function formatOverviewAsOf(value: string | null | undefined): string {
  return formatLocalDateTime(value) ?? "Timestamp unavailable";
}

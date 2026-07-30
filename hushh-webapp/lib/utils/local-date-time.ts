/**
 * User-facing instant formatting.
 *
 * This formatter intentionally delegates locale and time-zone resolution to the
 * browser. Do not add `timeZone` or `timeZoneName` here: product UI presents
 * each instant in the device's local settings without a zone label. Calendar
 * dates (`YYYY-MM-DD`) are not instants and must keep their own formatter.
 */
export type LocalDateTimeInput = Date | string | number | null | undefined;

export type LocalDateTimeOptions = Omit<
  Intl.DateTimeFormatOptions,
  "timeZone" | "timeZoneName"
>;

function toValidDate(value: LocalDateTimeInput): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatLocalDateTime(
  value: LocalDateTimeInput,
  options: LocalDateTimeOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
): string | null {
  const date = toValidDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

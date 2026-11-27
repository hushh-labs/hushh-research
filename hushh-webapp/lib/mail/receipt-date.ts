import { parseISO } from "date-fns/parseISO";

export const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

/** A date printed on a receipt has no time zone. A timestamp still identifies an instant. */
export function parseReceiptDate(value: string): Date {
  return calendarDatePattern.test(value) ? parseISO(value) : new Date(value);
}

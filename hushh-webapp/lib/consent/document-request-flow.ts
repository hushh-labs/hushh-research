/**
 * Copy and type scale shared by the document request sheets (owner, requester
 * and price). Presentation only: the server decides authority and dates.
 */

/**
 * Feed row scale for every dialog in this flow: 13px primary text and 11px
 * secondary text, one step smaller at 360px, as in components/feed/feed-row.tsx.
 * Scoped to the sheet's own subtree; buttons keep their touch sizes.
 */
export const DOCUMENT_FLOW_TEXT_SCALE = [
  "[&_.ui-text-body]:!text-[13px] [&_.ui-text-body]:!leading-[1.25]",
  "[&_.ui-text-row-label]:!text-[13px] [&_.ui-text-row-label]:!leading-[1.25]",
  "[&_.ui-text-medium-row-label]:!text-[13px] [&_.ui-text-medium-row-label]:!leading-[1.25]",
  "[&_.ui-text-helper-text]:!text-[11px] [&_.ui-text-helper-text]:!leading-[1.35]",
  "[&_.ui-text-row-description]:!text-[11px] [&_.ui-text-row-description]:!leading-[1.35]",
  "max-[360px]:[&_.ui-text-body]:!text-[12.5px] max-[360px]:[&_.ui-text-row-label]:!text-[12.5px]",
  "max-[360px]:[&_.ui-text-helper-text]:!text-[10px] max-[360px]:[&_.ui-text-row-description]:!text-[10px]",
].join(" ");

const SPAN_PHRASE =
  /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]+(days?|weeks?|months?|years?)\b/i;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2 Sep" from "2026-09-02", the same on every device and locale build. */
function shortDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  const day = match ? Number(match[3]) : 0;
  return month && day >= 1 && day <= 31 ? `${day} ${month}` : null;
}

/**
 * One short line when the request text names a longer span than the picked
 * dates (the server's periodConflict). The picked dates always win.
 */
export function periodConflictNote(
  purpose: string,
  periodStart: string | null | undefined,
  periodEnd: string | null | undefined,
  audience: "requester" | "owner",
): string | null {
  if (!periodStart || !periodEnd) return null;
  const start = shortDate(periodStart);
  const end = shortDate(periodEnd);
  if (!start || !end) return null;
  const span = SPAN_PHRASE.exec(purpose)?.[0];
  const dates = `${start} – ${end}`;
  if (audience === "requester")
    return span ? `Your note says ${span}. We used your dates: ${dates}.` : `We used your dates: ${dates}.`;
  return span ? `The note says ${span}. We used the picked dates: ${dates}.` : `We used the picked dates: ${dates}.`;
}

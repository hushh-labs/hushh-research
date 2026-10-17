/**
 * Copy and type scale shared by the document request sheets (owner, requester
 * and price). Presentation only: the server decides authority and dates.
 */

/**
 * Feed row scale for every dialog in this flow: 13px primary text and 11px
 * secondary text, one step smaller at 360px, as in components/feed/feed-row.tsx.
 * Scoped to the sheet's own subtree; buttons keep their touch sizes.
 *
 * Settings row slots are sized in the base layer from CSS variables, and a
 * base-layer important rule outranks any utility, so the variables are set
 * too (as the Feed row does). The utilities cover the unlayered text classes.
 */
export const DOCUMENT_FLOW_TEXT_SCALE = [
  "[--type-row-label-size:13px] [--type-row-label-line:1.25]",
  "[--type-row-description-size:11px] [--type-row-description-line:1.35]",
  "max-[360px]:[--type-row-label-size:12.5px] max-[360px]:[--type-row-description-size:10px]",
  "[&_.ui-text-body]:!text-[13px] [&_.ui-text-body]:!leading-[1.25]",
  "[&_.ui-text-row-label]:!text-[13px] [&_.ui-text-row-label]:!leading-[1.25]",
  "[&_.ui-text-medium-row-label]:!text-[13px] [&_.ui-text-medium-row-label]:!leading-[1.25]",
  "[&_.ui-text-helper-text]:!text-[11px] [&_.ui-text-helper-text]:!leading-[1.35]",
  "[&_.ui-text-row-description]:!text-[11px] [&_.ui-text-row-description]:!leading-[1.35]",
  "max-[360px]:[&_.ui-text-body]:!text-[12.5px] max-[360px]:[&_.ui-text-row-label]:!text-[12.5px]",
  "max-[360px]:[&_.ui-text-helper-text]:!text-[10px] max-[360px]:[&_.ui-text-row-description]:!text-[10px]",
].join(" ");

/**
 * Header scale for every dialog in this flow (pass as a SettingsDetailPanel
 * surfaceClassName): the Profile pane's 15px semibold title and the Feed row's
 * 11px secondary line. The title slot reads the title3 token in the base
 * layer, so both title tokens are narrowed, on this surface only.
 */
export const DOCUMENT_FLOW_SURFACE_TYPE = [
  "[--type-navigation-title-size:15px] [--type-navigation-title-line:20px] [--type-navigation-title-weight:600]",
  "[--foundation-title3-size:15px] [--foundation-title3-line:20px] [--foundation-title3-weight:600]",
  "[--type-row-description-size:11px] [--type-row-description-line:1.35]",
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

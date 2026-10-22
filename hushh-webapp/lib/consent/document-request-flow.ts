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
  // The Feed row's secondary line steps down to 10px below 360px.
  "[--type-row-description-size:11px] [--type-row-description-line:1.35] max-[360px]:[--type-row-description-size:10px]",
].join(" ");

/**
 * A confirm dialog in this flow renders in a portal, outside the surface that
 * narrows the title token, so it narrows the same token on its own content.
 */
export const DOCUMENT_FLOW_DIALOG_TYPE =
  "[--foundation-title3-size:15px] [--foundation-title3-line:20px] [--foundation-title3-weight:600]";

const SPAN_PHRASES =
  /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-]+(days?|weeks?|months?|years?)\b/gi;
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
// The server's shortest calendar length per unit: "1 month" never conflicts with 30 days.
const SPAN_DAYS: Record<string, number> = { day: 1, week: 7, month: 28, year: 365 };

/** The phrase the server flagged: the first span longer than the picked dates. */
function longerSpan(purpose: string, periodStart: string, periodEnd: string): string | undefined {
  const picked =
    (Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / 86_400_000 + 1;
  if (!Number.isFinite(picked)) return undefined;
  for (const match of purpose.matchAll(SPAN_PHRASES)) {
    const [phrase, amount = "", unitText = ""] = match;
    const count = NUMBER_WORDS[amount.toLowerCase()] ?? Number(amount);
    const unit = unitText.toLowerCase().replace(/s$/, "");
    if (count * (SPAN_DAYS[unit] ?? 0) > picked) return phrase;
  }
  return undefined;
}

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
  const span = longerSpan(purpose, periodStart, periodEnd);
  const dates = `${start} – ${end}`;
  if (audience === "requester")
    return span ? `Your note says ${span}. We used your dates: ${dates}.` : `We used your dates: ${dates}.`;
  return span ? `The note says ${span}. We used the picked dates: ${dates}.` : `We used the picked dates: ${dates}.`;
}

/**
 * Gmail-safe email shell for One's transactional mail.
 *
 * The rendered markup deliberately mirrors the `invitation` template shipped by
 * `hushh-mail-api`, so a welcome mail and an invitation read as one family:
 *
 *   - table layout with `bgcolor` attributes, because Gmail strips background
 *     shorthand from some containers
 *   - inline styles only; no <style> block, no classes, no Tailwind
 *   - no webfonts — Gmail does not load them, so this uses the same vendor font
 *     stack the invitation mail uses
 *   - every URL is scheme-checked, because some values reach here from client
 *     supplied request bodies
 *
 * Copy discipline lives in the templates, not here: one headline, at most one
 * supporting line, one primary action.
 */

/** Same stack as the invitation mail. Vendor fonts only — never a webfont. */
export const FONT_STACK =
  "'Google Sans','Roboto','Trebuchet MS',Arial,Helvetica,sans-serif";

export const PALETTE = {
  accent: "#0088cc",
  bg: "#f5f7f8",
  card: "#ffffff",
  border: "#e5e7eb",
  ink: "#111827",
  body: "#374151",
  muted: "#6b7280",
  faint: "#9ca3af",
} as const;

/**
 * Every link in an auth mail points at the product, never at the origin that
 * happened to send it. A UAT deploy mails real inboxes, and "Open One" landing
 * on uat.one.hushh.ai is a dead end for the person who receives it.
 */
export const ONE_APP_URL = "https://one.hushh.ai";

export const BRAND = {
  name: "One",
  // The app's own icon — the same mark as the browser tab and the home screen.
  // A PNG because Gmail and Outlook do not render SVG, and served from the
  // product origin so it resolves for every recipient.
  logoUrl: `${ONE_APP_URL}/quiet-emoji-icon.png`,
  siteUrl: ONE_APP_URL,
  supportEmail: "support@hushh.ai",
  address: "HushOne, Inc.",
} as const;

export interface DetailRow {
  label: string;
  value: string;
}

export interface EmailCallToAction {
  label: string;
  url: string;
}

export interface EmailShellOptions {
  /** Inbox preview line shown next to the subject. */
  previewText?: string;
  /** Small uppercase label above the headline. */
  eyebrow?: string;
  /** The single headline. Two to six words. */
  heading: string;
  /** Supporting copy. One short line is the norm; two is the ceiling. */
  paragraphs?: string[];
  /** Key/value panel. Omitted entirely when empty. */
  details?: DetailRow[];
  /** The one primary action. */
  cta?: EmailCallToAction | null;
  /** Small print under the action. */
  footNote?: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

export function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only http(s) and mailto survive. Some values reach a template from a request
 * body, so a raw `javascript:` or `data:` href must never be rendered.
 */
export function safeUrl(value: string | undefined | null, fallback = ""): string {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function preheader(text: string): string {
  if (!text) return "";
  return `
      <div style="display:none;font-size:1px;color:${PALETTE.card};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
        ${escapeHtml(text)}${"&nbsp;&zwnj;".repeat(60)}
      </div>`;
}

function paragraph(text: string): string {
  return `
              <p style="margin:0 0 16px;font-family:${FONT_STACK};font-size:15px;line-height:24px;color:${PALETTE.body};">
                ${escapeHtml(text)}
              </p>`;
}

function detailPanel(rows: DetailRow[]): string {
  const cells = rows
    .filter((row) => row && row.label && row.value)
    .map(
      (row) => `
                  <tr>
                    <td style="padding:6px 0;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${PALETTE.muted};width:38%;vertical-align:top;">
                      ${escapeHtml(row.label)}
                    </td>
                    <td style="padding:6px 0;font-family:${FONT_STACK};font-size:14px;line-height:20px;color:${PALETTE.ink};font-weight:600;vertical-align:top;">
                      ${escapeHtml(row.value)}
                    </td>
                  </tr>`,
    )
    .join("");

  if (!cells) return "";

  return `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f8fafc" style="background-color:#f8fafc;border:1px solid ${PALETTE.border};border-radius:12px;margin:0 0 24px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      ${cells}
                    </table>
                  </td>
                </tr>
              </table>`;
}

/**
 * Table-based CTA. `bgcolor` on the <td> is what makes the fill survive Gmail
 * and Outlook; the inline background-color covers every other client.
 */
function ctaButton(cta: EmailCallToAction | null | undefined): string {
  if (!cta?.label || !cta?.url) return "";
  const url = safeUrl(cta.url);
  if (!url) return "";

  return `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
                <tr>
                  <td align="center" bgcolor="${PALETTE.accent}" style="background-color:${PALETTE.accent};border-radius:10px;">
                    <a href="${escapeHtml(url)}"
                       style="display:inline-block;padding:14px 32px;font-family:${FONT_STACK};font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:10px;">
                      ${escapeHtml(cta.label)}
                    </a>
                  </td>
                </tr>
              </table>`;
}

/** Build a complete Gmail-safe HTML document plus its plain-text alternative. */
export function buildEmailShell({
  previewText = "",
  eyebrow = "",
  heading,
  paragraphs = [],
  details = [],
  cta = null,
  footNote = "",
}: EmailShellOptions): RenderedEmail {
  const bodyCopy = paragraphs.filter(Boolean).map(paragraph).join("");
  const logoUrl = safeUrl(BRAND.logoUrl);
  const siteUrl = safeUrl(BRAND.siteUrl);

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${escapeHtml(heading || BRAND.name)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${PALETTE.bg};">
${preheader(previewText || heading)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.bg}" style="background-color:${PALETTE.bg};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">

            <tr>
              <td align="left" style="padding:0 0 20px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:0 10px 0 0;line-height:0;">
                      <a href="${escapeHtml(siteUrl)}" style="text-decoration:none;">
                        <img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(BRAND.name)}" width="36" height="36"
                             style="display:block;border:0;outline:none;width:36px;height:36px;border-radius:9px;" />
                      </a>
                    </td>
                    <td style="vertical-align:middle;">
                      <a href="${escapeHtml(siteUrl)}"
                         style="font-family:${FONT_STACK};font-size:19px;font-weight:700;letter-spacing:-0.01em;color:${PALETTE.ink};text-decoration:none;">
                        ${escapeHtml(BRAND.name)}
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td bgcolor="${PALETTE.card}" style="background-color:${PALETTE.card};border:1px solid ${PALETTE.border};border-radius:16px;padding:36px 32px;">
                ${
                  eyebrow
                    ? `<p style="margin:0 0 10px;font-family:${FONT_STACK};font-size:11px;line-height:16px;letter-spacing:1.2px;text-transform:uppercase;color:${PALETTE.accent};font-weight:700;">${escapeHtml(
                        eyebrow,
                      )}</p>`
                    : ""
                }
                <h1 style="margin:0 0 18px;font-family:${FONT_STACK};font-size:24px;line-height:32px;color:${PALETTE.ink};font-weight:700;">
                  ${escapeHtml(heading)}
                </h1>
${bodyCopy}
${detailPanel(details)}
${ctaButton(cta)}
                ${
                  footNote
                    ? `<p style="margin:0;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${PALETTE.muted};">${escapeHtml(
                        footNote,
                      )}</p>`
                    : ""
                }
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:24px 8px 0;">
                <p style="margin:0 0 6px;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${PALETTE.faint};">
                  ${escapeHtml(BRAND.address)} &middot;
                  <a href="${escapeHtml(siteUrl)}" style="color:${PALETTE.muted};text-decoration:underline;">${escapeHtml(
                    BRAND.name,
                  )}</a>
                </p>
                <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${PALETTE.faint};">
                  Questions? Reply to this email or write to
                  <a href="mailto:${escapeHtml(BRAND.supportEmail)}" style="color:${PALETTE.muted};text-decoration:underline;">${escapeHtml(
                    BRAND.supportEmail,
                  )}</a>.
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textLines: string[] = [heading, "", ...paragraphs.filter(Boolean)];
  const detailLines = details
    .filter((row) => row && row.label && row.value)
    .map((row) => `${row.label}: ${row.value}`);
  if (detailLines.length > 0) textLines.push("", ...detailLines);
  if (cta?.label && cta?.url) {
    const url = safeUrl(cta.url);
    if (url) textLines.push("", `${cta.label}: ${url}`);
  }
  if (footNote) textLines.push("", footNote);
  textLines.push("", `${BRAND.address} — ${BRAND.siteUrl}`);

  return {
    html,
    text: textLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

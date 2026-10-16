/**
 * Shared Gmail-safe email shell.
 *
 * Constraints this file exists to satisfy (same rules as
 * cloud-run/email-template-api/emails/*.js, which are proven in production):
 *
 *   - table-based layout with `bgcolor` attributes, because Gmail strips
 *     background shorthand from some containers
 *   - inline styles only; no <style> block, no classes, no Tailwind
 *   - no webfonts — Gmail does not load them, so we use a stack it already has
 *   - every URL is scheme-checked, since template data comes from API callers
 */

export const escapeHtml = (value = "") =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Only http(s) and mailto survive. Template data is caller-supplied, so a raw
 * `javascript:` or `data:` href must never reach a rendered email.
 */
export const safeUrl = (value, fallback = "#") => {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return fallback;
    return escapeHtml(parsed.toString());
  } catch {
    return fallback;
  }
};

export const stripHtml = (value = "") =>
  String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const FONT_STACK =
  "'Google Sans','Roboto','Trebuchet MS',Arial,Helvetica,sans-serif";

export const PALETTE = {
  accent: "#0088cc",
  gold: "#d4af37",
  bg: "#f5f7f8",
  card: "#ffffff",
  border: "#e5e7eb",
  ink: "#111827",
  body: "#374151",
  muted: "#6b7280",
  faint: "#9ca3af",
};

export const DEFAULT_BRAND = {
  name: "Hushh",
  logoUrl: "https://www.hushhtech.com/images/hushh-logo-email.png",
  siteUrl: "https://www.hushhtech.com/",
  supportEmail: "support@hushh.ai",
  address: "HushOne, Inc.",
};

/**
 * Preheader — the grey text Gmail shows next to the subject in the inbox list.
 * Hidden in the body, then padded so the client does not pull body copy into it.
 */
const preheader = (text) => `
      <div style="display:none;font-size:1px;color:${PALETTE.card};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
        ${escapeHtml(text)}${"&nbsp;&zwnj;".repeat(60)}
      </div>`;

const paragraph = (html) => `
              <p style="margin:0 0 16px;font-family:${FONT_STACK};font-size:15px;line-height:24px;color:${PALETTE.body};">
                ${html}
              </p>`;

/**
 * A labelled key/value panel — used by invitations for event details and by
 * notifications for the fact block.
 */
const detailPanel = (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return "";

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
                  </tr>`
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
};

/**
 * Table-based CTA button. `bgcolor` on the <td> is what makes the fill survive
 * Gmail and Outlook; the inline background-color covers everything else.
 */
const ctaButton = (cta, accent) => {
  if (!cta || !cta.label || !cta.url) return "";
  const url = safeUrl(cta.url);
  if (url === "#") return "";

  return `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
                <tr>
                  <td align="center" bgcolor="${accent}" style="background-color:${accent};border-radius:10px;">
                    <a href="${url}"
                       style="display:inline-block;padding:14px 32px;font-family:${FONT_STACK};font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:10px;">
                      ${escapeHtml(cta.label)}
                    </a>
                  </td>
                </tr>
              </table>`;
};

/**
 * Build a complete Gmail-safe HTML document plus its plain-text alternative.
 *
 * @param {object} options
 * @param {string} options.previewText  inbox preview line
 * @param {string} options.heading      H1 copy
 * @param {string} [options.eyebrow]    small uppercase label above the heading
 * @param {string[]} [options.paragraphs] body copy, escaped
 * @param {string} [options.extraHtml] trusted markup injected after the body
 *   copy and before the details panel. Templates own this string — it is never
 *   caller-supplied, so it is the one place raw HTML is allowed.
 * @param {Array<{label:string,value:string}>} [options.details] key/value panel
 * @param {{label:string,url:string}} [options.cta]
 * @param {string} [options.footNote]   small print under the CTA
 * @param {string} [options.accent]     accent colour
 * @param {object} [options.brand]
 * @returns {{html: string, text: string}}
 */
export const buildEmailShell = ({
  previewText = "",
  heading = "",
  eyebrow = "",
  paragraphs = [],
  extraHtml = "",
  extraText = "",
  details = [],
  cta = null,
  footNote = "",
  accent = PALETTE.accent,
  brand = {},
} = {}) => {
  const b = { ...DEFAULT_BRAND, ...brand };
  const safeAccent = /^#[0-9a-fA-F]{3,8}$/.test(String(accent)) ? accent : PALETTE.accent;
  const bodyParagraphs = paragraphs
    .filter(Boolean)
    .map((text) => paragraph(escapeHtml(text)))
    .join("");

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${escapeHtml(heading || b.name)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${PALETTE.bg};">
${preheader(previewText || stripHtml(heading))}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PALETTE.bg}" style="background-color:${PALETTE.bg};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;">

            <tr>
              <td align="left" style="padding:0 0 20px;">
                <a href="${safeUrl(b.siteUrl)}" style="text-decoration:none;">
                  <img src="${safeUrl(b.logoUrl)}" alt="${escapeHtml(b.name)}" width="112" height="32"
                       style="display:block;border:0;outline:none;height:32px;width:auto;max-width:160px;" />
                </a>
              </td>
            </tr>

            <tr>
              <td bgcolor="${PALETTE.card}" style="background-color:${PALETTE.card};border:1px solid ${PALETTE.border};border-radius:16px;padding:36px 32px;">
                ${
                  eyebrow
                    ? `<p style="margin:0 0 10px;font-family:${FONT_STACK};font-size:11px;line-height:16px;letter-spacing:1.2px;text-transform:uppercase;color:${safeAccent};font-weight:700;">${escapeHtml(
                        eyebrow
                      )}</p>`
                    : ""
                }
                <h1 style="margin:0 0 18px;font-family:${FONT_STACK};font-size:24px;line-height:32px;color:${PALETTE.ink};font-weight:700;">
                  ${escapeHtml(heading)}
                </h1>
${bodyParagraphs}
${extraHtml}
${detailPanel(details)}
${ctaButton(cta, safeAccent)}
                ${
                  footNote
                    ? `<p style="margin:0;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${PALETTE.muted};">${escapeHtml(
                        footNote
                      )}</p>`
                    : ""
                }
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:24px 8px 0;">
                <p style="margin:0 0 6px;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${PALETTE.faint};">
                  ${escapeHtml(b.address)} &middot;
                  <a href="${safeUrl(b.siteUrl)}" style="color:${PALETTE.muted};text-decoration:underline;">${escapeHtml(
    b.name
  )}</a>
                </p>
                <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:18px;color:${PALETTE.faint};">
                  Questions? Reply to this email or write to
                  <a href="mailto:${escapeHtml(b.supportEmail)}" style="color:${PALETTE.muted};text-decoration:underline;">${escapeHtml(
    b.supportEmail
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

  const textLines = [
    heading,
    "",
    ...paragraphs.filter(Boolean),
    ...(extraText ? ["", extraText] : []),
    "",
    ...details
      .filter((row) => row && row.label && row.value)
      .map((row) => `${row.label}: ${row.value}`),
  ];

  if (cta?.label && cta?.url) {
    const url = safeUrl(cta.url);
    if (url !== "#") textLines.push("", `${cta.label}: ${cta.url}`);
  }
  if (footNote) textLines.push("", footNote);
  textLines.push("", `${b.address} — ${b.siteUrl}`);

  return { html, text: textLines.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
};

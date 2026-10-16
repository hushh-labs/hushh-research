/**
 * `verification` — one-time code / confirm-your-email.
 *
 * Kept separate from `notification` because the code needs generous
 * letter-spacing and must never be wrapped in a link: mail scanners prefetch
 * links and would burn a single-use code before the recipient clicks it.
 */

import { buildEmailShell, escapeHtml, FONT_STACK, PALETTE } from "./layout.js";

const trim = (value) => (typeof value === "string" ? value.trim() : "");

export const verificationTemplate = {
  id: "verification",
  description:
    "One-time verification code or email confirmation. Renders the code as selectable text, never as a link.",
  required: ["code"],
  fields: {
    code: "REQUIRED. The one-time code.",
    recipientName: "Recipient's name for the greeting.",
    purpose: "What the code authorises, e.g. 'sign in to Hushh'.",
    expiresInMinutes: "Number of minutes until the code expires.",
    subject: "Override the subject line.",
    accent: "Hex accent colour.",
    brand: "{ name, logoUrl, siteUrl, supportEmail, address } overrides.",
  },

  build(data = {}) {
    const code = trim(data.code);
    const recipientName = trim(data.recipientName);
    const purpose = trim(data.purpose) || "complete your request";
    const expiresInMinutes = Number.parseInt(data.expiresInMinutes, 10);
    const hasExpiry = Number.isFinite(expiresInMinutes) && expiresInMinutes > 0;
    const expiryLine = hasExpiry
      ? `This code expires in ${expiresInMinutes} minute${expiresInMinutes === 1 ? "" : "s"}.`
      : "";

    const codeBlock = `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f8fafc" style="background-color:#f8fafc;border:1px solid ${PALETTE.border};border-radius:12px;margin:0 0 20px;">
                <tr>
                  <td align="center" style="padding:24px 20px;font-family:${FONT_STACK};font-size:32px;line-height:40px;letter-spacing:8px;font-weight:700;color:${PALETTE.ink};">
                    ${escapeHtml(code)}
                  </td>
                </tr>
              </table>${
                expiryLine
                  ? `
              <p style="margin:0 0 20px;font-family:${FONT_STACK};font-size:14px;line-height:22px;color:${PALETTE.muted};">${escapeHtml(
                      expiryLine
                    )}</p>`
                  : ""
              }`;

    return {
      subject: trim(data.subject) || `${code} is your Hushh verification code`,
      ...buildEmailShell({
        previewText: `Your verification code is ${code}`,
        eyebrow: "Verification",
        heading: "Your verification code",
        paragraphs: [
          recipientName ? `Hi ${recipientName},` : "Hi,",
          `Use the code below to ${purpose}.`,
        ],
        extraHtml: codeBlock,
        extraText: [code, expiryLine].filter(Boolean).join("\n\n"),
        cta: null,
        footNote:
          "If you did not request this code, you can safely ignore this email. " +
          "Never share it with anyone — Hushh will never ask you for it.",
        accent: trim(data.accent) || PALETTE.accent,
        brand: data.brand,
      }),
    };
  },
};

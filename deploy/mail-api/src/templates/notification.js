/**
 * `notification` — the generic branded template.
 *
 * The escape hatch for any project that wants Hushh chrome without defining a
 * new template: a heading, some paragraphs, an optional facts panel, an
 * optional button.
 */

import { buildEmailShell, PALETTE } from "./layout.js";

const trim = (value) => (typeof value === "string" ? value.trim() : "");

export const notificationTemplate = {
  id: "notification",
  description:
    "Generic branded notification — heading, body paragraphs, optional detail rows and CTA. Use when you want Hushh chrome without a bespoke template.",
  required: ["heading"],
  fields: {
    heading: "REQUIRED. The H1 and the default subject.",
    subject: "Override the subject line.",
    eyebrow: "Small uppercase label above the heading.",
    message: "Body copy — string or string[] of paragraphs.",
    details: "[{label, value}] rows rendered in the panel.",
    actionUrl: "Optional CTA target.",
    actionLabel: "CTA copy. Default 'Open'.",
    footNote: "Small print under the CTA.",
    accent: "Hex accent colour.",
    brand: "{ name, logoUrl, siteUrl, supportEmail, address } overrides.",
  },

  build(data = {}) {
    const heading = trim(data.heading);
    const paragraphs = Array.isArray(data.message)
      ? data.message.map(trim).filter(Boolean)
      : [trim(data.message)].filter(Boolean);

    const actionUrl = trim(data.actionUrl);

    return {
      subject: trim(data.subject) || heading,
      ...buildEmailShell({
        previewText: paragraphs[0] || heading,
        eyebrow: trim(data.eyebrow),
        heading,
        paragraphs,
        details: Array.isArray(data.details) ? data.details : [],
        cta: actionUrl ? { label: trim(data.actionLabel) || "Open", url: actionUrl } : null,
        footNote: trim(data.footNote),
        accent: trim(data.accent) || PALETTE.accent,
        brand: data.brand,
      }),
    };
  },
};

/**
 * `invitation` — the flagship template.
 *
 * Any Hushh project that needs to invite somebody (to a workspace, a fund, an
 * event, a beta, a document review) calls this instead of hand-rolling HTML.
 * Everything except `inviteeName`-less greetings is optional so a caller can
 * send a useful invitation with two fields.
 */

import { buildEmailShell, PALETTE, safeUrl } from "./layout.js";

const trim = (value) => (typeof value === "string" ? value.trim() : "");

export const invitationTemplate = {
  id: "invitation",
  description:
    "Invite someone to join, attend, or accept access. Renders a branded card with an optional details panel and a call-to-action button.",
  required: ["actionUrl"],
  fields: {
    inviteeName: "Recipient's name. Falls back to a neutral greeting.",
    inviterName: "Who is inviting, e.g. 'Ankit Kumar Singh'.",
    inviterEmail: "Shown as the reply-to hint in the small print.",
    organizationName: "What they are being invited to. Default 'Hushh'.",
    invitationType: "Short eyebrow label, e.g. 'Workspace invitation'.",
    subject: "Override the generated subject line.",
    headline: "Override the H1.",
    message: "One or more custom body paragraphs (string or string[]).",
    actionUrl: "REQUIRED. Where the CTA button points.",
    actionLabel: "CTA button copy. Default 'Accept invitation'.",
    role: "Optional detail row — the role being granted.",
    eventName: "Optional detail row.",
    eventDate: "Optional detail row.",
    location: "Optional detail row.",
    expiresAt: "Optional detail row plus an expiry note under the CTA.",
    details: "Extra [{label, value}] rows appended to the panel.",
    accent: "Hex accent colour. Default Hushh blue.",
    brand: "{ name, logoUrl, siteUrl, supportEmail, address } overrides.",
  },

  build(data = {}) {
    const organizationName = trim(data.organizationName) || "Hushh";
    const inviteeName = trim(data.inviteeName);
    const inviterName = trim(data.inviterName);
    const actionLabel = trim(data.actionLabel) || "Accept invitation";

    const subject =
      trim(data.subject) ||
      (inviterName
        ? `${inviterName} invited you to ${organizationName}`
        : `You have been invited to ${organizationName}`);

    const heading =
      trim(data.headline) ||
      (inviteeName ? `${inviteeName}, you're invited` : "You're invited");

    const openingLine = inviterName
      ? `${inviterName} has invited you to join ${organizationName}.`
      : `You have been invited to join ${organizationName}.`;

    const custom = Array.isArray(data.message)
      ? data.message.map(trim).filter(Boolean)
      : [trim(data.message)].filter(Boolean);

    const paragraphs = [
      openingLine,
      ...(custom.length > 0
        ? custom
        : ["Use the button below to accept and get started."]),
    ];

    const details = [
      { label: "Organization", value: organizationName },
      inviterName ? { label: "Invited by", value: inviterName } : null,
      trim(data.role) ? { label: "Role", value: trim(data.role) } : null,
      trim(data.eventName) ? { label: "Event", value: trim(data.eventName) } : null,
      trim(data.eventDate) ? { label: "When", value: trim(data.eventDate) } : null,
      trim(data.location) ? { label: "Where", value: trim(data.location) } : null,
      ...(Array.isArray(data.details) ? data.details : []),
    ].filter((row) => row && row.label && row.value);

    const actionUrl = trim(data.actionUrl);
    // An invitation whose CTA we would have to strip is useless — sending it
    // link-less would be worse than refusing. render.js turns this into a 400.
    if (safeUrl(actionUrl) === "#") {
      throw new Error("actionUrl must be an http(s) URL");
    }

    const expiresAt = trim(data.expiresAt);
    const footNoteParts = [];
    if (expiresAt) footNoteParts.push(`This invitation expires on ${expiresAt}.`);
    footNoteParts.push(
      `If the button does not work, copy this link into your browser: ${actionUrl}`
    );
    if (trim(data.inviterEmail)) {
      footNoteParts.push(`Not expecting this? Reply to ${trim(data.inviterEmail)}.`);
    }

    return {
      subject,
      ...buildEmailShell({
        previewText: openingLine,
        eyebrow: trim(data.invitationType) || "Invitation",
        heading,
        paragraphs,
        details,
        cta: { label: actionLabel, url: actionUrl },
        footNote: footNoteParts.join(" "),
        accent: trim(data.accent) || PALETTE.accent,
        brand: data.brand,
      }),
    };
  },
};

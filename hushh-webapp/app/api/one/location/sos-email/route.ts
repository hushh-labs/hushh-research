/**
 * POST /api/one/location/sos-email
 *
 * The second channel for a Save my Soul alert.
 *
 * The push notification is the first, and it reaches nobody when a contact has
 * notifications off or has uninstalled — the flow already knows that and, until
 * this existed, could only report it after the fact. An inbox survives a closed
 * app.
 *
 * WHY THIS IS A REAL ROUTE AND NOT THE `/api/one/[...path]` PROXY
 * Every other `/api/one/*` path proxies straight to the protocol backend. This
 * one deliberately shadows the catch-all, because the mail has to be sent from
 * here: `MAIL_API_KEY` / `MAIL_API_ENDPOINT` are bound in the webapp lane only,
 * and `hushh-mail-api` is the service that already sends sign-in, phone
 * conflict and capability-linked mail. Sending an emergency alert from a second
 * identity is how you find out about an SPF/DKIM misalignment at the worst
 * possible moment.
 *
 * So the work splits:
 *   backend  →  authorization + recipient resolution (only it can validate the
 *               grants, and only it knows the addresses)
 *   here     →  render + send, through the shared mail service
 *
 * Contact addresses come back to THIS server and go no further. A sender does
 * not necessarily know their emergency contacts' email addresses, and this must
 * not be where they learn them — nothing in the response body names one.
 *
 * COORDINATES
 * They arrive in the request because the server cannot read them anywhere else:
 * `one_location_envelopes` keeps coordinates inside the ciphertext, so only the
 * sender's device holds the plaintext. They are used to render one message and
 * are never stored or logged here.
 *
 * A failure is never an error. The alert has already gone out by the time this
 * runs, so every problem is reported as a count.
 */

import { NextRequest, NextResponse } from "next/server";

import { getPythonApiUrl } from "@/app/api/_utils/backend";
import { validateFirebaseToken } from "@/lib/auth/validate";
import { isMailConfigured, sendMail } from "@/lib/mail/mail-client";

export const dynamic = "force-dynamic";

const RECIPIENT_TIMEOUT_MS = 10_000;
const MAX_GRANT_IDS = 20;
const MAX_NOTE_LENGTH = 300;

type Recipient = {
  grantId: string;
  recipientUserId: string;
  email: string;
  displayName: string;
  expiresAt: string | null;
};

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", Pragma: "no-cache" },
  });
}

const EMPTY = {
  emailed: 0,
  attempted: 0,
  configured: false,
  withoutEmail: [] as string[],
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mapsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

function firstName(value: string): string {
  return value.trim().split(/\s+/)[0] ?? "";
}

export function renderSosEmail(input: {
  recipientDisplayName: string;
  ownerDisplayName: string;
  note: string | null;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  openInOneUrl: string;
  emergencyNumber: string | null;
  expiresAtLabel: string | null;
}): { subject: string; text: string; html: string } {
  const owner = input.ownerDisplayName || "Someone";
  const greetingName = firstName(input.recipientDisplayName);
  const greeting = greetingName ? `${greetingName}, ` : "";
  const coords = `${input.latitude.toFixed(6)}, ${input.longitude.toFixed(6)}`;
  const accuracy =
    typeof input.accuracyM === "number" && input.accuracyM > 0
      ? ` (accurate to about ${Math.round(input.accuracyM)} m)`
      : "";
  const map = mapsUrl(input.latitude, input.longitude);
  const note = input.note?.trim() || "";
  const expiry = input.expiresAtLabel
    ? `Their live location stays shared until ${input.expiresAtLabel}.`
    : "Their live location is shared with you now.";
  const emergency = input.emergencyNumber
    ? `If this is an emergency where you are, call ${input.emergencyNumber}.`
    : "If this is an emergency, call your local emergency number.";

  const subject = `${owner} needs help — Save my Soul`;

  const text = [
    `${greeting}${owner} triggered a Save my Soul alert.`,
    note ? `\n  "${note}"\n` : "",
    `Location: ${coords}${accuracy}`,
    `Map: ${map}`,
    "",
    expiry,
    `Open in One for their live position: ${input.openInOneUrl}`,
    "",
    emergency,
  ]
    .filter((line) => line !== "")
    .join("\n");

  const noteHtml = note
    ? `<p style="margin:0 0 20px;padding:12px 16px;border-left:3px solid #ff3b30;background:#faf7f7;font-size:16px;line-height:1.5;color:#1d1d1f;">&ldquo;${escapeHtml(note)}&rdquo;</p>`
    : "";

  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1d1d1f;">`,
    `<p style="margin:0 0 4px;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#ff3b30;">Save my Soul</p>`,
    `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.2;">${escapeHtml(owner)} needs help</h1>`,
    `<p style="margin:0 0 20px;font-size:16px;line-height:1.5;">${escapeHtml(greeting.trim())} They triggered an emergency alert and shared their live location with you.</p>`,
    noteHtml,
    `<p style="margin:0 0 8px;font-size:16px;line-height:1.5;"><strong>Location:</strong> ${escapeHtml(coords)}${escapeHtml(accuracy)}</p>`,
    `<p style="margin:0 0 24px;"><a href="${escapeHtml(map)}" style="display:inline-block;padding:12px 20px;border-radius:9999px;background:#ff3b30;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;">Open in Google Maps</a></p>`,
    `<p style="margin:0 0 8px;font-size:15px;line-height:1.5;color:#3c3c43;">${escapeHtml(expiry)}</p>`,
    `<p style="margin:0 0 24px;font-size:15px;"><a href="${escapeHtml(input.openInOneUrl)}" style="color:#007aff;">See their live position in One</a></p>`,
    `<p style="margin:0;font-size:15px;line-height:1.5;color:#3c3c43;">${escapeHtml(emergency)}</p>`,
    `</div>`,
  ].join("");

  return { subject, text, html };
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const auth = await validateFirebaseToken(authHeader);
  if (!auth.valid) {
    return noStore({ error: "Unauthorized" }, 401);
  }
  if (!isMailConfigured()) {
    // A missing binding must never look like a failed emergency.
    return noStore(EMPTY);
  }

  let payload: {
    grantIds?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    accuracyM?: unknown;
    note?: unknown;
    emergencyNumber?: unknown;
  };
  try {
    payload = await request.json();
  } catch {
    return noStore({ ...EMPTY, configured: true });
  }

  const grantIds = Array.isArray(payload.grantIds)
    ? payload.grantIds
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .slice(0, MAX_GRANT_IDS)
    : [];
  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  const validCoordinates =
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180;

  if (!grantIds.length || !validCoordinates) {
    return noStore({ ...EMPTY, configured: true });
  }

  const accuracyM = Number.isFinite(Number(payload.accuracyM))
    ? Number(payload.accuracyM)
    : null;
  const note = String(payload.note ?? "")
    .trim()
    .slice(0, MAX_NOTE_LENGTH);
  const emergencyNumber = String(payload.emergencyNumber ?? "")
    .trim()
    .slice(0, 16);

  // The backend is the authorization: it returns contacts only for live SOS
  // grants this caller's own account just created.
  let resolved: {
    ownerDisplayName?: string;
    openInOneUrl?: string;
    recipients?: Recipient[];
    withoutEmail?: string[];
  };
  try {
    const upstream = await fetch(
      `${getPythonApiUrl()}/api/one/location/sos-email-recipients`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        body: JSON.stringify({ grantIds }),
        signal: AbortSignal.timeout(RECIPIENT_TIMEOUT_MS),
      },
    );
    if (!upstream.ok) return noStore({ ...EMPTY, configured: true });
    resolved = await upstream.json();
  } catch {
    return noStore({ ...EMPTY, configured: true });
  }

  // Contacts on this alert who have no address anywhere. Named so the sender
  // can act on it, rather than being shown a bare "Emailed 0".
  const withoutEmail = Array.isArray(resolved.withoutEmail)
    ? resolved.withoutEmail.map((name) => String(name ?? "")).filter(Boolean)
    : [];

  const recipients = Array.isArray(resolved.recipients)
    ? resolved.recipients
    : [];
  if (!recipients.length) {
    return noStore({ ...EMPTY, configured: true, withoutEmail });
  }

  const results = await Promise.all(
    recipients.map(async (recipient) => {
      const { subject, text, html } = renderSosEmail({
        recipientDisplayName: String(recipient.displayName ?? ""),
        ownerDisplayName: String(resolved.ownerDisplayName ?? ""),
        note: note || null,
        latitude,
        longitude,
        accuracyM,
        openInOneUrl: String(resolved.openInOneUrl ?? ""),
        emergencyNumber: emergencyNumber || null,
        expiresAtLabel: recipient.expiresAt
          ? new Date(recipient.expiresAt).toUTCString()
          : null,
      });
      const outcome = await sendMail({
        to: String(recipient.email ?? ""),
        subject,
        html,
        text,
        // One alert, one mail per contact, even if the client retries.
        idempotencyKey: `sos:${recipient.grantId}`,
      });
      return outcome.status === "sent";
    }),
  );

  return noStore({
    emailed: results.filter(Boolean).length,
    attempted: results.length,
    configured: true,
    withoutEmail,
  });
}

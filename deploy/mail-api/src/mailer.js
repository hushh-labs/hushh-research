/**
 * Google Workspace transport.
 *
 * Hushh sends mail through Gmail SMTP authenticated as a Google Workspace user
 * with an App Password — the same mechanism the website's inline nodemailer
 * routes already use (`api/contact-notification.js`, `api/metrics/send-report.js`).
 * This service centralises it.
 *
 * Workspace facts that shape this file:
 *
 *  1. An App Password requires 2-Step Verification on the Workspace account and
 *     is issued per-application at https://myaccount.google.com/apppasswords.
 *     It bypasses OAuth, which is why the credential must stay server-side.
 *  2. Gmail rewrites the From header to the authenticated user unless the
 *     address is a verified "Send mail as" alias on that account. Letting a
 *     caller set an arbitrary From therefore produces a silently wrong sender,
 *     so `resolveFrom` only honours addresses the operator has allowlisted.
 *  3. `service: "gmail"` in nodemailer resolves to exactly smtp.gmail.com:465
 *     over implicit TLS. This file states that explicitly.
 *  4. Workspace enforces a per-account daily send cap (2,000 messages/day for
 *     paid tiers, counted per recipient). See the rate limiter and README.
 */

import nodemailer from "nodemailer";

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 465;

const trim = (value) => (typeof value === "string" ? value.trim() : "");

const parseList = (value) =>
  trim(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

export const workspaceConfig = (env = process.env) => ({
  user: trim(env.GMAIL_USER),
  appPassword: trim(env.GMAIL_APP_PASSWORD),
  defaultFromName: trim(env.MAIL_DEFAULT_FROM_NAME) || "Hushh",
  // Verified "Send mail as" aliases on the Workspace account. Anything else is
  // rewritten by Gmail anyway, so we refuse it up front and say so.
  allowedFrom: parseList(env.MAIL_ALLOWED_FROM),
  defaultReplyTo: trim(env.MAIL_DEFAULT_REPLY_TO),
});

export const isConfigured = (config) => Boolean(config.user && config.appPassword);

let cachedTransporter = null;
let cachedFingerprint = "";

/**
 * Pooled so a burst of invitations reuses one authenticated SMTP connection
 * instead of re-handshaking per message.
 */
export const getTransporter = (config, factory = nodemailer.createTransport) => {
  const fingerprint = `${config.user}:${config.appPassword.length}`;

  if (cachedTransporter && cachedFingerprint === fingerprint) {
    return cachedTransporter;
  }

  cachedTransporter = factory({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: config.user, pass: config.appPassword },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
  });
  cachedFingerprint = fingerprint;

  return cachedTransporter;
};

export const resetTransporter = () => {
  cachedTransporter = null;
  cachedFingerprint = "";
};

/**
 * Resolve the From header against what Gmail will actually honour.
 *
 * Returns the address to use plus an optional warning when the caller asked for
 * something we had to override — callers get told rather than silently sending
 * as someone else.
 */
export const resolveFrom = (requested, config) => {
  const fallback = { name: config.defaultFromName, email: config.user };
  if (!requested) return { from: fallback, warning: null };

  const email =
    typeof requested === "string" ? requested : trim(requested?.email || requested?.address);
  const name =
    typeof requested === "object" && trim(requested?.name)
      ? trim(requested.name)
      : config.defaultFromName;

  const normalized = trim(email).toLowerCase();
  if (!normalized) return { from: fallback, warning: null };

  const permitted =
    normalized === config.user.toLowerCase() || config.allowedFrom.includes(normalized);

  if (!permitted) {
    return {
      from: fallback,
      warning:
        `from address "${email}" is not the Workspace sender or a configured ` +
        `alias; Gmail would rewrite it, so ${config.user} was used instead`,
    };
  }

  return { from: { name, email: trim(email) }, warning: null };
};

export const formatAddress = ({ name, email }) => (name ? `"${name}" <${email}>` : email);

export const verifyTransport = async (config) => {
  if (!isConfigured(config)) return { ok: false, error: "GMAIL_USER/GMAIL_APP_PASSWORD unset" };
  try {
    await getTransporter(config).verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || "SMTP verification failed" };
  }
};

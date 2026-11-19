/**
 * Google Workspace transport.
 *
 * Production sends mail through the Gmail API authenticated via keyless Google
 * Workspace Domain-Wide Delegation (RS256 service-account JWT assertion
 * impersonating a configured Workspace role mailbox such as `one@hushh.ai`).
 * SMTP App Password transport is retained only for explicit unit-test fixtures
 * and local compatibility, never for personal developer accounts.
 *
 * Workspace constraints that shape this file:
 *
 *  1. Domain-Wide Delegation requires no personal mailbox login or 2FA App
 *     Password and binds the sender explicitly to `ONE_EMAIL_DELEGATED_USER`
 *     (defaulting to `one@hushh.ai`).
 *  2. Gmail rewrites the From header to the authenticated user unless the
 *     address is a verified "Send mail as" alias on that account. `resolveFrom`
 *     therefore only honours addresses the operator has allowlisted.
 *  3. Workspace enforces a per-account daily send cap (~2,000 messages/day for
 *     paid tiers, counted per recipient). See the rate limiter and README.
 */

import crypto from "node:crypto";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 465;
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_METADATA_TOKEN_URI =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const DEFAULT_IAM_CREDENTIALS_BASE = "https://iamcredentials.googleapis.com/v1";
const DEFAULT_DELEGATED_USER = "one@hushh.ai";
const TOKEN_REFRESH_SKEW_MS = 300_000;
const BLOCKED_PERSONAL_SENDERS = new Set(["ankit@hushh.ai"]);

const trim = (value) => (typeof value === "string" ? value.trim() : "");

const parseList = (value) =>
  trim(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

const normalizePrivateKey = (raw) => {
  let value = trim(raw);
  if (!value) return "";
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\n/g, "\n");
};

const loadServiceAccountJson = (raw) => {
  const text = trim(raw);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || parsed.type !== "service_account") {
      return null;
    }
    const clientEmail = trim(parsed.client_email);
    const privateKey = normalizePrivateKey(parsed.private_key);
    const tokenUri = trim(parsed.token_uri) || DEFAULT_TOKEN_URI;
    if (!clientEmail || !privateKey) return null;
    return { clientEmail, privateKey, tokenUri };
  } catch {
    return null;
  }
};

export const workspaceConfig = (env = process.env) => {
  const jsonCredentials =
    loadServiceAccountJson(env.ONE_GMAIL_SERVICE_ACCOUNT_JSON) ||
    loadServiceAccountJson(env.SUPPORT_EMAIL_SERVICE_ACCOUNT_JSON);

  const keyServiceAccountEmail =
    jsonCredentials?.clientEmail || trim(env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKey =
    jsonCredentials?.privateKey || normalizePrivateKey(env.GOOGLE_PRIVATE_KEY);
  const workloadServiceAccountEmail = trim(env.WORKLOAD_DWD_SERVICE_ACCOUNT_EMAIL);
  const tokenUri = jsonCredentials?.tokenUri || trim(env.GOOGLE_TOKEN_URI) || DEFAULT_TOKEN_URI;
  const metadataTokenUri = trim(env.GOOGLE_METADATA_TOKEN_URI) || DEFAULT_METADATA_TOKEN_URI;
  const iamCredentialsBase =
    trim(env.GOOGLE_IAM_CREDENTIALS_BASE) || DEFAULT_IAM_CREDENTIALS_BASE;

  const keyDelegatedMode = Boolean(keyServiceAccountEmail && privateKey);
  const workloadDelegatedMode = !keyDelegatedMode && Boolean(workloadServiceAccountEmail);
  const mode = keyDelegatedMode
    ? "workspace-delegated"
    : workloadDelegatedMode
      ? "workload-dwd"
      : "smtp";
  const anyDelegated = keyDelegatedMode || workloadDelegatedMode;
  const delegatedUser = trim(env.ONE_EMAIL_DELEGATED_USER) || trim(env.GMAIL_USER);

  return {
    mode,
    user: anyDelegated ? delegatedUser || DEFAULT_DELEGATED_USER : trim(env.GMAIL_USER),
    appPassword: trim(env.GMAIL_APP_PASSWORD),
    serviceAccountEmail: keyDelegatedMode
      ? keyServiceAccountEmail
      : workloadDelegatedMode
        ? workloadServiceAccountEmail
        : "",
    privateKey,
    tokenUri,
    metadataTokenUri,
    iamCredentialsBase,
    defaultFromName: trim(env.MAIL_DEFAULT_FROM_NAME) || (anyDelegated ? "One" : "Hushh"),
    // Verified "Send mail as" aliases on the Workspace account. Anything else is
    // rewritten by Gmail anyway, so we refuse it up front and say so.
    allowedFrom: parseList(env.MAIL_ALLOWED_FROM),
    defaultReplyTo: trim(env.MAIL_DEFAULT_REPLY_TO),
  };
};

export const isConfigured = (config) => {
  const user = trim(config.user).toLowerCase();
  if (!user || BLOCKED_PERSONAL_SENDERS.has(user)) {
    return false;
  }
  if (config.mode === "workspace-delegated") {
    return Boolean(config.serviceAccountEmail && config.privateKey);
  }
  if (config.mode === "workload-dwd") {
    return Boolean(config.serviceAccountEmail);
  }
  return Boolean(config.appPassword);
};

let cachedTransporter = null;
let cachedFingerprint = "";

let delegatedTokenCaches = new WeakMap();
let delegatedTokenInFlights = new WeakMap();

const cacheForFetch = (store, fetchImpl) => {
  let map = store.get(fetchImpl);
  if (!map) {
    map = new Map();
    store.set(fetchImpl, map);
  }
  return map;
};

const base64urlJson = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const buildClaimSet = ({ serviceAccountEmail, user, tokenUri }, nowSeconds) => ({
  iss: serviceAccountEmail,
  sub: user,
  scope: GMAIL_SEND_SCOPE,
  aud: tokenUri,
  iat: nowSeconds,
  exp: nowSeconds + 3600,
});

const buildDelegatedAssertion = (config, nowSeconds) => {
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const claimSet = base64urlJson(buildClaimSet(config, nowSeconds));
  const unsigned = `${header}.${claimSet}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(config.privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
};

const buildWorkloadSignedAssertion = async (config, fetchImpl, nowSeconds) => {
  const metaResponse = await fetchImpl(config.metadataTokenUri, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    headers: { "Metadata-Flavor": "Google" },
  });
  const metaPayload = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok || typeof metaPayload?.access_token !== "string" || !metaPayload.access_token) {
    throw new Error(`Workload metadata token failed (http_${metaResponse.status})`);
  }

  const signUrl = `${config.iamCredentialsBase}/projects/-/serviceAccounts/${encodeURIComponent(
    config.serviceAccountEmail
  )}:signJwt`;
  const signResponse = await fetchImpl(signUrl, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    headers: {
      Authorization: `Bearer ${metaPayload.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      payload: JSON.stringify(buildClaimSet(config, nowSeconds)),
    }),
  });
  const signPayload = await signResponse.json().catch(() => ({}));
  if (!signResponse.ok || typeof signPayload?.signedJwt !== "string" || !signPayload.signedJwt) {
    throw new Error(`IAM signJwt failed (http_${signResponse.status})`);
  }
  return signPayload.signedJwt;
};

const keyFingerprint = (config) => {
  const keyHash = crypto
    .createHash("sha256")
    .update(config.privateKey || "")
    .digest("hex")
    .slice(0, 16);
  return `${config.mode}:${config.serviceAccountEmail}:${config.user}:${config.tokenUri}:${keyHash}`;
};

const getDelegatedAccessToken = async (config, fetchImpl = fetch, now = () => Date.now()) => {
  const tokenCache = cacheForFetch(delegatedTokenCaches, fetchImpl);
  const inFlight = cacheForFetch(delegatedTokenInFlights, fetchImpl);
  const cacheKey = keyFingerprint(config);
  const currentTimeMs = now();
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > currentTimeMs) {
    return cached.accessToken;
  }

  const existingRefresh = inFlight.get(cacheKey);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = (async () => {
    const nowSeconds = Math.floor(now() / 1000);
    const assertion =
      config.mode === "workload-dwd"
        ? await buildWorkloadSignedAssertion(config, fetchImpl, nowSeconds)
        : buildDelegatedAssertion(config, nowSeconds);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });

    const response = await fetchImpl(config.tokenUri, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload?.access_token !== "string" || !payload.access_token) {
      const code = trim(payload?.error) || `http_${response.status}`;
      throw new Error(`Workspace delegated token exchange failed (${code})`);
    }

    const expiresInSeconds =
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600;

    tokenCache.set(cacheKey, {
      accessToken: payload.access_token,
      expiresAtMs: now() + expiresInSeconds * 1000,
    });
    return payload.access_token;
  })().finally(() => {
    inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, refreshPromise);
  return refreshPromise;
};

const buildRawMime = (mailOptions) =>
  new Promise((resolve, reject) => {
    const composer = new MailComposer({
      ...mailOptions,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    composer.compile().build((error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });

const createDelegatedTransporter = (config, fetchImpl = fetch, now = () => Date.now()) => ({
  verify: async () => {
    await getDelegatedAccessToken(config, fetchImpl, now);
    return true;
  },
  sendMail: async (mailOptions) => {
    const token = await getDelegatedAccessToken(config, fetchImpl, now);
    const mime = await buildRawMime(mailOptions);
    const endpoint = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(
      config.user
    )}/messages/send`;

    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: mime.toString("base64url") }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload?.id !== "string" || !payload.id) {
      throw new Error(`Gmail delegated send failed (http_${response.status})`);
    }

    const accepted = [
      ...(Array.isArray(mailOptions.to) ? mailOptions.to : mailOptions.to ? [mailOptions.to] : []),
      ...(Array.isArray(mailOptions.cc) ? mailOptions.cc : []),
      ...(Array.isArray(mailOptions.bcc) ? mailOptions.bcc : []),
    ];

    return {
      messageId: payload.id,
      accepted,
      rejected: [],
    };
  },
});

/**
 * Pooled so a burst of invitations reuses one authenticated transport or cached
 * OAuth2 token instead of re-handshaking per message.
 */
export const getTransporter = (
  config,
  factory = nodemailer.createTransport,
  fetchImpl = fetch,
  now = () => Date.now()
) => {
  if (
    (config.mode === "workspace-delegated" || config.mode === "workload-dwd") &&
    factory === nodemailer.createTransport
  ) {
    return createDelegatedTransporter(config, fetchImpl, now);
  }

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
  delegatedTokenCaches = new WeakMap();
  delegatedTokenInFlights = new WeakMap();
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

export const verifyTransport = async (config, fetchImpl = fetch) => {
  if (!isConfigured(config)) {
    return { ok: false, error: "Workspace mail sender is not configured" };
  }
  try {
    await getTransporter(config, undefined, fetchImpl).verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || "Mail transport verification failed" };
  }
};

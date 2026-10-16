/**
 * API-key authentication — mirrors hushh-wallet-api exactly.
 *
 * Every `MAIL_API_KEY*` environment variable is an accepted key, so each
 * consuming project gets its own key bound independently from Secret Manager.
 * Onboarding a new project is a Secret Manager entry plus one
 * `gcloud run services update` — no code change, no image rebuild — and
 * revoking one consumer never affects the others.
 *
 * There is deliberately no origin allowlist: a new Hushh surface never has to
 * be registered with this service before it can send. The key is the control,
 * not the origin.
 */

import { timingSafeEqual } from "node:crypto";

const KEY_ENV_PREFIX = "MAIL_API_KEY";

// Short values are almost always a placeholder or a truncated paste rather than
// a real 256-bit key. Ignoring them keeps a misconfigured deploy failing closed
// instead of accepting a guessable key.
const MIN_KEY_LENGTH = 16;

/**
 * `MAIL_API_KEY` -> "default", `MAIL_API_KEY_HUSHHTECH` -> "hushhtech".
 * The label is only used for logging and response attribution, never for auth.
 */
const consumerLabel = (envName) => {
  if (envName === KEY_ENV_PREFIX) return "default";
  return envName.slice(KEY_ENV_PREFIX.length).replace(/^_/, "").toLowerCase() || "default";
};

export const loadApiKeys = (env = process.env) =>
  Object.entries(env)
    .filter(
      ([name, value]) =>
        name.startsWith(KEY_ENV_PREFIX) &&
        typeof value === "string" &&
        value.trim().length >= MIN_KEY_LENGTH
    )
    .map(([name, value]) => ({
      envName: name,
      consumer: consumerLabel(name),
      key: value.trim(),
    }));

const safeEqual = (a, b) => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

export const extractPresentedKey = (headers = {}) => {
  const direct = headers["x-api-key"] ?? headers["X-Api-Key"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const authorization = headers.authorization ?? headers.Authorization;
  if (typeof authorization === "string" && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }

  return "";
};

/**
 * @returns {{ok: true, consumer: string} | {ok: false, status: number, error: string}}
 */
export const authenticate = (headers = {}, env = process.env) => {
  const configured = loadApiKeys(env);

  // Fail closed. An unconfigured service must never send mail for anyone.
  if (configured.length === 0) {
    return {
      ok: false,
      status: 503,
      error: "Mail service is not configured",
    };
  }

  const presented = extractPresentedKey(headers);
  if (!presented) {
    return {
      ok: false,
      status: 401,
      error: "Missing API key. Send x-api-key or Authorization: Bearer <key>.",
    };
  }

  // Compare against every configured key so timing does not reveal which
  // consumer slot matched.
  let matched = null;
  for (const candidate of configured) {
    if (safeEqual(presented, candidate.key)) matched = candidate;
  }

  if (!matched) {
    return { ok: false, status: 401, error: "Invalid API key" };
  }

  return { ok: true, consumer: matched.consumer };
};

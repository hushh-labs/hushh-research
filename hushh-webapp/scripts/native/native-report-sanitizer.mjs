const SENSITIVE_KEY_FRAGMENTS = [
  "body",
  "email",
  "error",
  "jserr",
  "jsrej",
  "message",
  "passphrase",
  "payload",
  "reason",
  "requestid",
  "response",
  "secret",
  "token",
  "uid",
  "userid",
];

const SAFE_ERROR_CLASSES = new Set([
  "authentication",
  "identity",
  "network",
  "not_found",
  "other",
  "permission",
  "rate_limit",
  "reference_error",
  "syntax_error",
  "timeout",
  "type_error",
  "vault",
]);

function normalizedKey(key) {
  return String(key || "").replaceAll("_", "").toLowerCase();
}

function isSensitiveKey(key) {
  const normalized = normalizedKey(key);
  if (normalized.endsWith("class")) return false;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function routePath(value) {
  try {
    return new URL(String(value || "/"), "https://native-test.local").pathname || "/";
  } catch {
    return "/";
  }
}

function looksSensitiveString(value) {
  const text = String(value || "");
  return (
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
    /\bBearer\s+[A-Za-z0-9._~-]+/i.test(text) ||
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text)
  );
}

export function errorClass(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (SAFE_ERROR_CLASSES.has(text)) return text;
  if (/401|403|auth|sign in/.test(text)) return "authentication";
  if (/404|not found/.test(text)) return "not_found";
  if (/timeout|timed out/.test(text)) return "timeout";
  if (/network|connection|fetch/.test(text)) return "network";
  if (/vault|decrypt|crypto/.test(text)) return "vault";
  if (/permission|denied/.test(text)) return "permission";
  return "other";
}

export function sanitizeNativeArtifact(value, key = "") {
  if (isSensitiveKey(key)) {
    return value === null || value === undefined || value === "" ? value : "<redacted>";
  }
  const normalized = normalizedKey(key);
  if (normalized === "route" || normalized.endsWith("route")) {
    return routePath(value);
  }
  if (normalized.includes("screenshot")) {
    return value ? "<external-test-artifact>" : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeNativeArtifact(entry, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeNativeArtifact(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value === "string" && looksSensitiveString(value)) {
    return "<redacted>";
  }
  return value;
}

export function sanitizeStatusForReport(status = {}) {
  return sanitizeNativeArtifact(status);
}

export function sanitizeRawStatusForReport(raw = "") {
  const status = Object.fromEntries(
    String(raw)
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const [key, ...rest] = part.split("=");
        return [key, rest.join("=")];
      }),
  );
  return Object.entries(sanitizeStatusForReport(status))
    .map(([key, value]) => `${key}=${String(value ?? "")}`)
    .join(";");
}

export function assertNativeArtifactSafe(value, forbiddenValues = []) {
  const serialized = JSON.stringify(value);
  if (looksSensitiveString(serialized)) {
    throw new Error("native artifact contains an email, bearer token, or JWT-like value");
  }
  for (const forbidden of forbiddenValues) {
    if (forbidden && serialized.includes(forbidden)) {
      throw new Error("native artifact contains a configured reviewer secret");
    }
  }
  function inspect(entry, key = "") {
    if (isSensitiveKey(key) && entry && entry !== "<redacted>") {
      throw new Error(`native artifact field must be redacted: ${key}`);
    }
    if (Array.isArray(entry)) {
      entry.forEach((item) => inspect(item, key));
      return;
    }
    if (entry && typeof entry === "object") {
      Object.entries(entry).forEach(([childKey, child]) => inspect(child, childKey));
    }
  }
  inspect(value);
}

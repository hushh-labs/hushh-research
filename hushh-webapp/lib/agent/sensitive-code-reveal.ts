const REVEAL_REF_RE = /^otp1\.[A-Za-z0-9_-]{24,140}$/;

export type SensitiveCodeRevealExperience = {
  type: "one.sensitive_code_reveal.v1";
  kind: "otp";
  revealRef: string;
  sender: string;
  subject: string;
  receivedAt: string;
  expiresInSeconds: number;
  autoClearSeconds: number;
  codeCount: number;
};

function sanitizeHeaderText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLen);
}

/**
 * Pure parser for the server's ``one.sensitive_code_reveal.v1`` experience.
 * Accepts only metadata + opaque ``otp1.*`` ref; never carries raw code digits.
 */
export function parseSensitiveCodeRevealExperience(
  value: unknown,
): SensitiveCodeRevealExperience | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (rec.type !== "one.sensitive_code_reveal.v1") return null;
  const rawRef = typeof rec.revealRef === "string"
    ? rec.revealRef
    : typeof rec.reveal_ref === "string"
      ? rec.reveal_ref
      : "";
  if (!REVEAL_REF_RE.test(rawRef)) return null;
  const rawExpires = typeof rec.expiresInSeconds === "number"
    ? rec.expiresInSeconds
    : typeof rec.expires_in_seconds === "number"
      ? rec.expires_in_seconds
      : 120;
  const rawAutoClear = typeof rec.autoClearSeconds === "number"
    ? rec.autoClearSeconds
    : typeof rec.auto_clear_seconds === "number"
      ? rec.auto_clear_seconds
      : 60;
  const rawCount = typeof rec.codeCount === "number"
    ? rec.codeCount
    : typeof rec.code_count === "number"
      ? rec.code_count
      : 1;
  return {
    type: "one.sensitive_code_reveal.v1",
    kind: "otp",
    revealRef: rawRef,
    sender: sanitizeHeaderText(rec.sender, 120) || "Recent email",
    subject: sanitizeHeaderText(rec.subject, 160),
    receivedAt: sanitizeHeaderText(rec.receivedAt ?? rec.received_at, 64),
    expiresInSeconds: Math.max(15, Math.min(300, Math.round(rawExpires))),
    autoClearSeconds: Math.max(10, Math.min(120, Math.round(rawAutoClear))),
    codeCount: Math.max(1, Math.min(4, Math.round(rawCount))),
  };
}

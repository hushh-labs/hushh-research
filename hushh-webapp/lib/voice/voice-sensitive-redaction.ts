const DIGIT_SEQUENCE = /(?:\d[\s.-]*){4,}/g;

/** Keep phone numbers and OTP values out of the local conversation mirror. */
export function redactSensitiveVoiceTranscript(text: string, screen?: string | null): string {
  const normalized = text.trim();
  if (screen !== "register_phone" && screen !== "phone_mandate") return normalized;
  return normalized.replace(DIGIT_SEQUENCE, "[sensitive number redacted]");
}

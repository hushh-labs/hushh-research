import { redactSensitiveVoiceTranscript } from "@/lib/voice/voice-sensitive-redaction";
import { describe, expect, it } from "vitest";

describe("voice sensitive transcript redaction", () => {
  it("redacts spoken phone and OTP digits from the phone-screen mirror", () => {
    expect(redactSensitiveVoiceTranscript("My code is 123 456", "register_phone")).toBe(
      "My code is [sensitive number redacted]"
    );
    expect(redactSensitiveVoiceTranscript("+1 650 555 0101", "phone_mandate")).toBe(
      "+[sensitive number redacted]"
    );
  });

  it("does not alter ordinary conversation on other screens", () => {
    expect(redactSensitiveVoiceTranscript("Analyze 2026 results", "one_agents")).toBe(
      "Analyze 2026 results"
    );
  });
});

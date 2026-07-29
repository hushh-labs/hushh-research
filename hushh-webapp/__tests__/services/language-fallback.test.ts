import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  resolveTargetLocale,
} from "@/lib/runtime/language-fallback";

describe("resolveTargetLocale", () => {
  it("keeps supported BCP-47 locale tags active", () => {
    const result = resolveTargetLocale("fr-FR");

    expect(result).toEqual({
      activeLocale: "fr-FR",
      accepted: true,
      status: "LOCALE_RESOLVED_SUCCESS",
    });
  });

  it("falls back to the baseline locale for malformed tags", () => {
    const result = resolveTargetLocale("invalid_lang_code_###");

    expect(result).toEqual({
      activeLocale: DEFAULT_LOCALE,
      accepted: false,
      status: "FALLBACK_TRIGGERED_SYNTAX_VIOLATION",
    });
  });

  it("falls back to the baseline locale for unsupported catalog entries", () => {
    const result = resolveTargetLocale("de-DE");

    expect(result).toEqual({
      activeLocale: DEFAULT_LOCALE,
      accepted: false,
      status: "FALLBACK_TRIGGERED_UNSUPPORTED_TOKEN",
    });
  });

  it("rejects missing or non-string locale values", () => {
    const result = resolveTargetLocale(null);

    expect(result).toEqual({
      activeLocale: DEFAULT_LOCALE,
      accepted: false,
      status: "FALLBACK_TRIGGERED_INVALID_TYPE",
    });
  });
});

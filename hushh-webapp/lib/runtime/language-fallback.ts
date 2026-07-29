export const DEFAULT_LOCALE = "en";

export const DEFAULT_SUPPORTED_LOCALES = new Set([
  DEFAULT_LOCALE,
  "en-US",
  "fr-FR",
  "es-ES",
]);

export type LocaleResolutionStatus =
  | "LOCALE_RESOLVED_SUCCESS"
  | "FALLBACK_TRIGGERED_INVALID_TYPE"
  | "FALLBACK_TRIGGERED_SYNTAX_VIOLATION"
  | "FALLBACK_TRIGGERED_UNSUPPORTED_TOKEN";

export interface LocaleResolution {
  activeLocale: string;
  accepted: boolean;
  status: LocaleResolutionStatus;
}

const BCP47_LOCALE_PATTERN = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;

export function resolveTargetLocale(
  inputTag: unknown,
  supportedCatalog: ReadonlySet<string> = DEFAULT_SUPPORTED_LOCALES
): LocaleResolution {
  if (typeof inputTag !== "string" || inputTag.trim().length === 0) {
    return {
      activeLocale: DEFAULT_LOCALE,
      accepted: false,
      status: "FALLBACK_TRIGGERED_INVALID_TYPE",
    };
  }

  const localeTag = inputTag.trim();

  if (!BCP47_LOCALE_PATTERN.test(localeTag)) {
    return {
      activeLocale: DEFAULT_LOCALE,
      accepted: false,
      status: "FALLBACK_TRIGGERED_SYNTAX_VIOLATION",
    };
  }

  if (!supportedCatalog.has(localeTag)) {
    return {
      activeLocale: DEFAULT_LOCALE,
      accepted: false,
      status: "FALLBACK_TRIGGERED_UNSUPPORTED_TOKEN",
    };
  }

  return {
    activeLocale: localeTag,
    accepted: true,
    status: "LOCALE_RESOLVED_SUCCESS",
  };
}

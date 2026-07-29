import {
  createI18nResourceIntegritySnapshot,
  validateI18nResourceIntegrity,
} from "../lib/i18n/i18n-resource-integrity";

const mockResource = {
  locale: "en",
  messages: {
    welcome: "Hello",
    logout: "Logout",
  },
};

const snapshot = createI18nResourceIntegritySnapshot({
  id: "core-en",
  resourceName: "core-en",
  resource: mockResource,
  version: "1.0.0",
});

const validation = validateI18nResourceIntegrity({
  resource: mockResource,
  snapshot,
});

if (!validation.valid) {
  console.error(
    "[verify-i18n-integrity] Integrity validation failed"
  );

  process.exit(1);
}

console.log(
  "[verify-i18n-integrity] Integrity validation passed"
);
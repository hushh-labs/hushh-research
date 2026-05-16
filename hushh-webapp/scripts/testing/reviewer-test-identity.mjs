import fs from "node:fs";
import path from "node:path";

const CANONICAL_UID_KEY = "REVIEWER_UID";
const CANONICAL_PASSPHRASE_KEY = "REVIEWER_VAULT_PASSPHRASE";

const DEPRECATED_UID_KEYS = [
  "NEXT_PUBLIC_REVIEWER_UID",
  "UAT_SMOKE_USER_ID",
  "KAI_TEST_USER_ID",
  "HUSHH_SMOKE_USER_ID",
  "NEXT_PUBLIC_KAI_TEST_USER_ID",
];

const DEPRECATED_PASSPHRASE_KEYS = [
  "UAT_SMOKE_PASSPHRASE",
  "KAI_TEST_PASSPHRASE",
  "HUSHH_REVIEWER_PASSPHRASE",
  "HUSHH_KAI_TEST_PASSPHRASE",
];

export function sanitizeConfiguredValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (/replace_with_/i.test(trimmed)) return "";
  if (/your_[a-z0-9_]+_here/i.test(trimmed)) return "";
  if (/placeholder/i.test(trimmed)) return "";
  return trimmed;
}

export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const parsed = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim().replace(/^export\s+/, "");
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

export function defaultReviewerIdentityEnvFiles({ repoRoot, webDir }) {
  const candidates = [
    path.join(repoRoot, ".env"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env.local.local"),
    path.join(webDir, ".env.local"),
    path.join(webDir, ".env.local.local"),
    path.join(webDir, ".env.uat.local"),
    path.join(repoRoot, "consent-protocol", ".env"),
    path.join(repoRoot, "consent-protocol", ".env.local"),
  ];
  return [...new Set(candidates)];
}

function lookupValue({ sources, keys }) {
  for (const key of keys) {
    for (const source of sources) {
      const value = sanitizeConfiguredValue(source.values[key]);
      if (value) {
        return {
          key,
          source: source.label,
          value,
          deprecated: key !== keys[0],
        };
      }
    }
  }
  return null;
}

export function resolveReviewerTestIdentity({
  envFiles = [],
  required = true,
} = {}) {
  const sources = [
    { label: "process.env", values: process.env },
    ...envFiles.map((filePath) => ({
      label: filePath,
      values: parseEnvFile(filePath),
    })),
  ];
  const uidMatch = lookupValue({
    sources,
    keys: [CANONICAL_UID_KEY, ...DEPRECATED_UID_KEYS],
  });
  const passphraseMatch = lookupValue({
    sources,
    keys: [CANONICAL_PASSPHRASE_KEY, ...DEPRECATED_PASSPHRASE_KEYS],
  });

  const missing = [];
  if (!uidMatch) missing.push(CANONICAL_UID_KEY);
  if (!passphraseMatch) missing.push(CANONICAL_PASSPHRASE_KEY);
  if (required && missing.length > 0) {
    throw new Error(
      `missing canonical reviewer test identity value(s): ${missing.join(
        ", "
      )}. Set ${CANONICAL_UID_KEY} and ${CANONICAL_PASSPHRASE_KEY} in a maintainer-only env or secret overlay. Deprecated aliases are accepted for one release cycle, but no NEXT_PUBLIC passphrase is allowed.`
    );
  }

  return {
    reviewerUid: uidMatch?.value || "",
    reviewerVaultPassphrase: passphraseMatch?.value || "",
    uidSourceKey: uidMatch?.key || "",
    passphraseSourceKey: passphraseMatch?.key || "",
    deprecatedAliasesUsed: [uidMatch, passphraseMatch]
      .filter((match) => match?.deprecated)
      .map((match) => match.key),
  };
}

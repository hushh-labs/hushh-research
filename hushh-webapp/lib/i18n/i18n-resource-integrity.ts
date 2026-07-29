type I18nResourceIntegritySnapshot = {
  id: string;
  resourceName: string;
  hash: string;
  algorithm: "djb2";
  createdAt: number;
  version?: string;
};

type I18nResourceIntegrityValidation = {
  valid: boolean;
  expectedHash: string;
  actualHash: string;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function createI18nResourceHash(resource: unknown): string {
  const serialized = stableStringify(resource);
  let hash = 5381;

  for (let index = 0; index < serialized.length; index += 1) {
    hash = (hash * 33) ^ serialized.charCodeAt(index);
  }

  return (hash >>> 0).toString(16);
}

export function createI18nResourceIntegritySnapshot({
  resourceName,
  resource,
  version,
}: {
  resourceName: string;
  resource: unknown;
  version?: string;
}): I18nResourceIntegritySnapshot {
  const hash = createI18nResourceHash(resource);

  return {
    id: `${resourceName}:${hash}`,
    resourceName,
    hash,
    algorithm: "djb2",
    createdAt: Date.now(),
    version,
  };
}

export function validateI18nResourceIntegrity({
  resource,
  snapshot,
}: {
  resource: unknown;
  snapshot: I18nResourceIntegritySnapshot;
}): I18nResourceIntegrityValidation {
  const actualHash = createI18nResourceHash(resource);

  return {
    valid: actualHash === snapshot.hash,
    expectedHash: snapshot.hash,
    actualHash,
  };
}

export function compareI18nResourceIntegrityVersions(
  left: I18nResourceIntegritySnapshot,
  right: I18nResourceIntegritySnapshot
) {
  return {
    sameResource: left.resourceName === right.resourceName,
    sameHash: left.hash === right.hash,
    sameVersion: left.version === right.version,
  };
}
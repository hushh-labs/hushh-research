"use client";

export type PkmSectionPreviewStat = {
  label: string;
  value: string;
};

export type PkmSectionPreviewField = {
  label: string;
  value: string;
  tone?: "default" | "muted";
};

export type PkmSectionPreviewEntitySection = {
  label: string;
  items: string[];
  display?: "chips" | "list";
};

export type PkmSectionPreviewEntity = {
  key: string;
  title: string;
  subtitle?: string;
  fields: PkmSectionPreviewField[];
  sections?: PkmSectionPreviewEntitySection[];
  deletable?: boolean;
};

export type PkmSectionPreviewGroup =
  | {
      kind: "fields";
      title?: string;
      description?: string;
      fields: PkmSectionPreviewField[];
    }
  | {
      kind: "chips";
      title?: string;
      description?: string;
      items: string[];
    }
  | {
      kind: "list";
      title?: string;
      description?: string;
      items: string[];
    }
  | {
      kind: "entities";
      title?: string;
      description?: string;
      items: PkmSectionPreviewEntity[];
    };

export type PkmSectionPreviewPresentation = {
  title: string;
  description?: string;
  summary?: string;
  stats: PkmSectionPreviewStat[];
  groups: PkmSectionPreviewGroup[];
};

const HIDDEN_CONSUMER_KEYS = new Set([
  "schema_version",
  "contract_version",
  "projection_version",
]);

const ENTITY_TITLE_KEYS = ["title", "name", "label", "summary", "merchant", "symbol", "entity_id", "id"];
const ENTITY_SUBTITLE_KEYS = ["kind", "status", "category"];
const SUMMARY_KEYS = ["readable_summary", "summary", "package_note", "description", "note"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function humanizeKey(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function formatTimestamp(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatScalar(label: string, value: unknown): string {
  if (value === null || typeof value === "undefined") {
    return "Not set";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "number") {
    return value.toLocaleString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return "Not set";
    }
    if (/_at$/.test(label) || /date|time/i.test(label)) {
      return formatTimestamp(trimmed) || trimmed;
    }
    return trimmed;
  }
  return JSON.stringify(value);
}

function toDisplayString(value: unknown): string | null {
  const formatted = formatScalar("value", value).trim();
  return formatted ? formatted : null;
}

function unwrapSectionValue(
  value: Record<string, unknown> | null,
  topLevelScopePath: string
): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    return value;
  }
  const scopeKey = String(topLevelScopePath || "")
    .split(".")
    .filter(Boolean)
    .at(-1);
  if (!scopeKey) {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === scopeKey && isPlainObject(value[scopeKey])) {
    return value[scopeKey] as Record<string, unknown>;
  }
  return value;
}

function maybeSummary(record: Record<string, unknown>): string | undefined {
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function arrayToStrings(value: unknown[]): string[] {
  return value
    .map((item) => toDisplayString(item))
    .filter((item): item is string => Boolean(item));
}

function toItemsArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value) && Array.isArray(value.items)) return value.items;
  return [];
}

function getNestedRecord(record: Record<string, unknown>, path: string): Record<string, unknown> | null {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current)) return null;
    current = current[segment];
  }
  return isPlainObject(current) ? current : null;
}

function getNestedItems(record: Record<string, unknown>, path: string): unknown[] {
  const nested = getNestedRecord(record, path);
  return nested ? toItemsArray(nested) : [];
}

function formatPercent(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.round(normalized)}%`;
}

function formatAmountValue(amount: unknown, currency: unknown): string | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  const code = typeof currency === "string" && currency.trim() ? currency.trim().toUpperCase() : "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

function receiptPreviewEntity(
  key: string,
  value: Record<string, unknown>,
  fallbackTitle: string
): PkmSectionPreviewEntity {
  const fields = objectToFields(value);
  const amount = formatAmountValue(value.amount, value.currency);
  const confidence = formatPercent(value.confidence);
  const affinity = formatPercent(value.affinity_score);
  const fieldMap = new Map(fields.map((field) => [field.label, field]));
  if (amount) {
    fieldMap.set("Amount", { label: "Amount", value: amount });
    fieldMap.delete("Currency");
  }
  if (confidence) fieldMap.set("Confidence", { label: "Confidence", value: confidence });
  if (affinity) fieldMap.set("Affinity Score", { label: "Affinity Score", value: affinity });

  const sections = buildEntitySections(value);
  return {
    key,
    title: extractEntityTitle(value, fallbackTitle),
    subtitle: extractEntitySubtitle(value),
    fields: Array.from(fieldMap.values()).filter((field) => field.value !== extractEntityTitle(value, fallbackTitle)),
    sections,
  };
}

function objectToFields(record: Record<string, unknown>): PkmSectionPreviewField[] {
  return Object.entries(record)
    .filter(([key, value]) => !HIDDEN_CONSUMER_KEYS.has(key) && !Array.isArray(value) && !isPlainObject(value))
    .map(([key, value]) => ({
      label: humanizeKey(key),
      value: formatScalar(key, value),
      tone: key === "updated_at" || key === "created_at" ? "muted" : "default",
    }));
}

function extractEntityTitle(record: Record<string, unknown>, fallback: string): string {
  for (const key of ENTITY_TITLE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return fallback;
}

function extractEntitySubtitle(record: Record<string, unknown>): string | undefined {
  const parts = ENTITY_SUBTITLE_KEYS.map((key) => {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }).filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function buildEntitySections(record: Record<string, unknown>): PkmSectionPreviewEntitySection[] {
  return Object.entries(record)
    .filter(([key, value]) => !HIDDEN_CONSUMER_KEYS.has(key) && (Array.isArray(value) || isPlainObject(value)))
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) {
        const items = arrayToStrings(value);
        if (items.length > 0) {
          return [
            {
              label: humanizeKey(key),
              items,
              display: items.length <= 5 && items.every((item) => item.length <= 28) ? "chips" : "list",
            } satisfies PkmSectionPreviewEntitySection,
          ];
        }
        if (value.every(isPlainObject)) {
          return [
            {
              label: humanizeKey(key),
              items: value.map((item) =>
                Object.entries(item)
                  .map(([entryKey, entryValue]) => `${humanizeKey(entryKey)}: ${formatScalar(entryKey, entryValue)}`)
                  .join(" · ")
              ),
              display: "list",
            } satisfies PkmSectionPreviewEntitySection,
          ];
        }
        return [];
      }

      const nestedFields = objectToFields(value as Record<string, unknown>);
      if (nestedFields.length === 0) {
        return [];
      }
      return [
        {
          label: humanizeKey(key),
          items: nestedFields.map((field) => `${field.label}: ${field.value}`),
          display: "list",
        } satisfies PkmSectionPreviewEntitySection,
      ];
    });
}

function buildEntityItem(
  key: string,
  value: Record<string, unknown>,
  options?: { deletable?: boolean }
): PkmSectionPreviewEntity {
  const title = extractEntityTitle(value, humanizeKey(key));
  const fields = objectToFields(value).filter((field) => field.value !== title);
  return {
    key,
    title,
    subtitle: extractEntitySubtitle(value),
    fields,
    sections: buildEntitySections(value),
    deletable: options?.deletable === true,
  };
}

function maybeBuildEntitiesGroup(
  title: string | undefined,
  value: unknown
): PkmSectionPreviewGroup | null {
  if (Array.isArray(value) && value.every(isPlainObject)) {
    return {
      kind: "entities",
      title,
      items: value.map((item, index) => buildEntityItem(`${title || "item"}-${index + 1}`, item)),
    };
  }
  if (isPlainObject(value) && isPlainObject(value.entities)) {
    const entities = Object.entries(value.entities)
      .filter(([, entity]) => isPlainObject(entity))
      .map(([entityKey, entity]) =>
        buildEntityItem(entityKey, entity as Record<string, unknown>, { deletable: true })
      );
    if (entities.length > 0) {
      return {
        kind: "entities",
        title: title || "Saved entries",
        items: entities,
      };
    }
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, entity]) => isPlainObject(entity));
    if (entries.length > 0 && entries.length === Object.keys(value).length) {
      return {
        kind: "entities",
        title: title || "Saved entries",
        items: entries.map(([entityKey, entity]) =>
          buildEntityItem(entityKey, entity as Record<string, unknown>)
        ),
      };
    }
  }
  return null;
}

function buildAdvisorPackagePreview(
  title: string,
  description: string | undefined,
  record: Record<string, unknown>
): PkmSectionPreviewPresentation {
  const groups: PkmSectionPreviewGroup[] = [];
  const topFields = objectToFields(record).filter((field) => field.label !== "Package Note");
  if (topFields.length > 0) {
    groups.push({ kind: "fields", title: "Package details", fields: topFields });
  }

  const topPicksGroup = maybeBuildEntitiesGroup(
    "Top picks",
    Array.isArray(record.top_picks) ? record.top_picks : []
  );
  if (topPicksGroup) groups.push(topPicksGroup);

  const avoidRowsGroup = maybeBuildEntitiesGroup(
    "Avoid",
    Array.isArray(record.avoid_rows) ? record.avoid_rows : []
  );
  if (avoidRowsGroup) groups.push(avoidRowsGroup);

  const screeningSections = Array.isArray(record.screening_sections)
    ? arrayToStrings(record.screening_sections)
    : [];
  if (screeningSections.length > 0) {
    groups.push({
      kind: "chips",
      title: "Coverage",
      items: screeningSections,
    });
  }

  return {
    title,
    description,
    summary: typeof record.package_note === "string" ? record.package_note.trim() : maybeSummary(record),
    stats: [
      {
        label: "Top picks",
        value: Array.isArray(record.top_picks) ? String(record.top_picks.length) : "0",
      },
      {
        label: "Avoid",
        value: Array.isArray(record.avoid_rows) ? String(record.avoid_rows.length) : "0",
      },
    ],
    groups,
  };
}

function buildReceiptsPreview(
  title: string,
  description: string | undefined,
  record: Record<string, unknown>
): PkmSectionPreviewPresentation {
  const groups: PkmSectionPreviewGroup[] = [];

  const readableSummary =
    typeof record.readable_summary === "string"
      ? record.readable_summary.trim()
      : isPlainObject(record.readable_summary) && typeof record.readable_summary.text === "string"
        ? record.readable_summary.text.trim()
        : maybeSummary(record);
  const readableHighlights =
    isPlainObject(record.readable_summary) && Array.isArray(record.readable_summary.highlights)
      ? arrayToStrings(record.readable_summary.highlights)
      : [];
  if (readableHighlights.length > 0) {
    groups.push({
      kind: readableHighlights.every((item) => item.length <= 42) ? "chips" : "list",
      title: "Receipt highlights",
      items: readableHighlights,
    });
  }

  const recentHighlights = getNestedItems(record, "observed_facts.recent_highlights")
    .filter(isPlainObject)
    .map((item, index) => receiptPreviewEntity(`recent-${index + 1}`, item, `Receipt ${index + 1}`));
  if (recentHighlights.length > 0) {
    groups.push({
      kind: "entities",
      title: "Recent purchases",
      items: recentHighlights,
    });
  }

  const merchantAffinity = getNestedItems(record, "observed_facts.merchant_affinity")
    .filter(isPlainObject)
    .map((item, index) => receiptPreviewEntity(`merchant-${index + 1}`, item, `Merchant ${index + 1}`));
  if (merchantAffinity.length > 0) {
    groups.push({
      kind: "entities",
      title: "Merchant patterns",
      items: merchantAffinity,
    });
  }

  const preferenceSignals = getNestedItems(record, "inferred_preferences.preference_signals")
    .filter(isPlainObject)
    .map((item, index) => receiptPreviewEntity(`preference-${index + 1}`, item, `Preference ${index + 1}`));
  const legacyInferred = Array.isArray(record.inferred_preferences)
    ? arrayToStrings(record.inferred_preferences)
    : [];
  if (preferenceSignals.length > 0) {
    groups.push({
      kind: "entities",
      title: "Preference signals",
      items: preferenceSignals,
    });
  } else if (legacyInferred.length > 0) {
    groups.push({
      kind: "chips",
      title: "Preference signals",
      items: legacyInferred,
    });
  }

  const legacyObserved = Array.isArray(record.observed_facts) ? arrayToStrings(record.observed_facts) : [];
  if (legacyObserved.length > 0) {
    groups.push({
      kind: "list",
      title: "Observed facts",
      items: legacyObserved,
    });
  }

  const provenance = isPlainObject(record.provenance) ? record.provenance : {};
  const receiptCount =
    typeof provenance.receipt_count_used === "number" && Number.isFinite(provenance.receipt_count_used)
      ? String(provenance.receipt_count_used)
      : null;
  const stats: PkmSectionPreviewStat[] = [];
  if (receiptCount) stats.push({ label: "Receipts", value: receiptCount });
  if (recentHighlights.length > 0) {
    stats.push({ label: "Purchases", value: String(recentHighlights.length) });
  }
  const preferenceCount = preferenceSignals.length || legacyInferred.length;
  if (preferenceCount > 0) {
    stats.push({ label: "Preferences", value: String(preferenceCount) });
  }

  return {
    title,
    description,
    summary: readableSummary,
    stats,
    groups,
  };
}

function buildGenericPreview(
  title: string,
  description: string | undefined,
  record: Record<string, unknown>
): PkmSectionPreviewPresentation {
  const groups: PkmSectionPreviewGroup[] = [];
  const fields = objectToFields(record).filter(
    (field) =>
      field.label !== "Readable Summary" &&
      field.label !== "Summary" &&
      field.label !== "Description" &&
      field.label !== "Note"
  );
  if (fields.length > 0) {
    groups.push({
      kind: "fields",
      title: "Saved values",
      fields,
    });
  }

  const rootEntitiesGroup = isPlainObject(record.entities)
    ? maybeBuildEntitiesGroup(undefined, record)
    : null;
  if (rootEntitiesGroup) {
    groups.push(rootEntitiesGroup);
  } else {
    for (const [key, value] of Object.entries(record)) {
      if (HIDDEN_CONSUMER_KEYS.has(key) || !value) {
        continue;
      }
      if (Array.isArray(value)) {
        if (value.every((item) => !isPlainObject(item))) {
          const items = arrayToStrings(value);
          if (items.length > 0) {
            groups.push({
              kind: items.length <= 5 && items.every((item) => item.length <= 28) ? "chips" : "list",
              title: humanizeKey(key),
              items,
            });
          }
          continue;
        }
        const entitiesGroup = maybeBuildEntitiesGroup(humanizeKey(key), value);
        if (entitiesGroup) {
          groups.push(entitiesGroup);
        }
        continue;
      }

      if (isPlainObject(value)) {
        const entitiesGroup = maybeBuildEntitiesGroup(humanizeKey(key), value);
        if (entitiesGroup) {
          groups.push(entitiesGroup);
          continue;
        }
        const nestedFields = objectToFields(value);
        if (nestedFields.length > 0) {
          groups.push({
            kind: "fields",
            title: humanizeKey(key),
            fields: nestedFields,
          });
        }
      }
    }
  }

  const stats: PkmSectionPreviewStat[] = [];
  const entityGroup = groups.find((group) => group.kind === "entities");
  if (entityGroup && entityGroup.kind === "entities") {
    stats.push({
      label: "Entries",
      value: String(entityGroup.items.length),
    });
  }
  if (!stats.length && fields.length > 0) {
    stats.push({
      label: "Fields",
      value: String(fields.length),
    });
  }

  return {
    title,
    description,
    summary: maybeSummary(record),
    stats,
    groups,
  };
}

export function buildPkmSectionPreviewPresentation(params: {
  domain: string;
  domainTitle: string;
  permissionLabel: string;
  permissionDescription?: string | null;
  topLevelScopePath: string;
  value: Record<string, unknown> | null;
}): PkmSectionPreviewPresentation {
  const title = params.permissionLabel.trim() || humanizeKey(params.topLevelScopePath);
  const description =
    params.permissionDescription?.trim() ||
    `Saved values from your ${params.domainTitle.toLowerCase()} domain.`;
  const value = unwrapSectionValue(params.value, params.topLevelScopePath);

  if (!isPlainObject(value)) {
    return {
      title,
      description,
      stats: [],
      groups: [],
      summary: "No saved values are available for this section yet.",
    };
  }

  const previewKey = `${params.domain}.${params.topLevelScopePath}`.toLowerCase();
  if (previewKey === "ria.advisor_package") {
    return buildAdvisorPackagePreview(title, description, value);
  }
  if (previewKey === "shopping.receipts_memory") {
    return buildReceiptsPreview(title, description, value);
  }

  return buildGenericPreview(title, description, value);
}

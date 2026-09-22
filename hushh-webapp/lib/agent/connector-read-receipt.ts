/** Only authored metadata may leave the read result boundary. No provider text or URLs. */
export const CONNECTOR_READ_EXPERIENCE_TYPE = "one.connector_read.v1" as const;
const STATUSES = [
  "ok", "input_required", "connect_required", "reconnect_required", "connection_changed",
  "permission_denied", "source_changed", "response_too_large", "invalid_argument", "unavailable",
] as const;

export type ConnectorReadExperience = {
  type: typeof CONNECTOR_READ_EXPERIENCE_TYPE;
  connector: "mail";
  status: (typeof STATUSES)[number];
  sourceRefs: string[];
  truncated: boolean;
  metadataOnly: true;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function parseConnectorReadReceipt(value: unknown): ConnectorReadExperience | null {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => ![
    "schema_version", "connector", "status", "sources", "truncated", "metadata_only",
  ].includes(key))) return null;
  if (input.schema_version !== "specialist_read.v1" || input.connector !== "mail" ||
    !STATUSES.includes(input.status as ConnectorReadExperience["status"]) ||
    input.metadata_only !== true || typeof input.truncated !== "boolean" ||
    !Array.isArray(input.sources) || input.sources.length > 25) return null;
  const refs: string[] = [];
  for (const value of input.sources) {
    const source = record(value);
    if (!source || Object.keys(source).some((key) => !["source_ref", "kind", "label"].includes(key)) ||
      source.kind !== "metadata" || source.label !== "Mail" ||
      typeof source.source_ref !== "string" || !/^mail:(?:[1-9]|1[0-9]|2[0-5])$/.test(source.source_ref)) return null;
    refs.push(source.source_ref);
  }
  if (new Set(refs).size !== refs.length || (input.status !== "ok" && refs.length)) return null;
  return {
    type: CONNECTOR_READ_EXPERIENCE_TYPE, connector: "mail",
    status: input.status as ConnectorReadExperience["status"], sourceRefs: refs,
    truncated: input.truncated, metadataOnly: true,
  };
}

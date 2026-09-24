/** Only authored metadata may leave the read result boundary. No provider text or URLs. */
export const CONNECTOR_READ_EXPERIENCE_TYPE = "one.connector_read.v1" as const;
const STATUSES = [
  "ok", "input_required", "connect_required", "reconnect_required", "connection_changed",
  "permission_denied", "source_changed", "response_too_large", "invalid_argument", "unavailable",
] as const;

export type ConnectorReadExperience = {
  type: typeof CONNECTOR_READ_EXPERIENCE_TYPE;
  connector: "mail" | "drive";
  status: (typeof STATUSES)[number];
  sourceRefs: string[];
  truncated: boolean;
  metadataOnly: boolean;
  sourcePages?: (number | null)[];
};

export const WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE =
  "one.workspace_connector_setup.v1" as const;

export type WorkspaceConnectorProvider = "drive" | "gmail" | "calendar";

export type WorkspaceConnectorSetupExperience = {
  type: typeof WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE;
  provider: WorkspaceConnectorProvider;
  status: "connect_required";
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return record(value);
}

/**
 * Project only the authenticated tool's explicit missing-grant state into a
 * provider-specific setup card. Provider data never authorizes the connection
 * or starts OAuth; the person must tap through the existing connector UI.
 */
export function parseWorkspaceConnectorSetup(
  toolName: string,
  value: unknown,
  toolArguments?: unknown,
): WorkspaceConnectorSetupExperience | null {
  if (toolName !== "discover_workspace_tools" && toolName !== "read_workspace_tool") {
    return null;
  }

  const outer = parseRecord(value);
  if (!outer) return null;
  const result = [outer.result, outer.content, outer.data]
    .map(parseRecord)
    .find((candidate) => candidate?.status) ?? outer;
  if (result.status !== "permission_required") return null;

  const args = parseRecord(toolArguments);
  const resultProvider = result.provider;
  const argumentProvider = args?.provider;
  if (resultProvider && argumentProvider && resultProvider !== argumentProvider) {
    return null;
  }
  const provider = resultProvider ?? argumentProvider;
  if (provider !== "drive" && provider !== "gmail" && provider !== "calendar") {
    return null;
  }

  return {
    type: WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE,
    provider,
    status: "connect_required",
  };
}

export function parseConnectorReadReceipt(value: unknown): ConnectorReadExperience | null {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => ![
    "schema_version", "connector", "status", "sources", "truncated", "metadata_only",
  ].includes(key))) return null;
  if (input.schema_version !== "specialist_read.v1" || !["mail", "drive"].includes(input.connector as string) ||
    !STATUSES.includes(input.status as ConnectorReadExperience["status"]) ||
    input.metadata_only !== (input.connector === "mail") || typeof input.truncated !== "boolean" ||
    !Array.isArray(input.sources) || input.sources.length > 25) return null;
  const refs: string[] = [];
  const pages: (number | null)[] = [];
  for (const value of input.sources) {
    const source = record(value);
    if (!source || Object.keys(source).some((key) => !["source_ref", "kind", "label", "page"].includes(key)) ||
      typeof source.source_ref !== "string") return null;
    if (input.connector === "mail") {
      if (source.kind !== "metadata" || source.label !== "Mail" ||
        !/^mail:(?:[1-9]|1[0-9]|2[0-5])$/.test(source.source_ref) || source.page != null) return null;
    } else {
      if (source.kind !== "document" || source.label !== "Document" ||
        !/^document:[a-f0-9]{32}$/.test(source.source_ref) ||
        (source.page != null && (typeof source.page !== "number" || !Number.isInteger(source.page) || source.page < 1 || source.page > 100))) return null;
      pages.push(typeof source.page === "number" ? source.page : null);
    }
    refs.push(source.source_ref);
  }
  if (new Set(refs).size !== refs.length || (input.status !== "ok" && refs.length)) return null;
  return {
    type: CONNECTOR_READ_EXPERIENCE_TYPE, connector: input.connector as "mail" | "drive",
    status: input.status as ConnectorReadExperience["status"], sourceRefs: refs,
    truncated: input.truncated, metadataOnly: input.connector === "mail",
    ...(input.connector === "drive" ? { sourcePages: pages } : {}),
  };
}

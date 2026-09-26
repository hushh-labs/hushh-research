/** Only authored metadata may leave the read result boundary. No provider text or URLs. */
export const CONNECTOR_READ_EXPERIENCE_TYPE = "one.connector_read.v1" as const;
export type DriveOwnerCompileWindow = {
  start_date: string;
  end_date: string;
  timezone: string;
};

export function driveOwnerCompileKey(query: string, window: DriveOwnerCompileWindow): string {
  return JSON.stringify([query, window.start_date, window.end_date, window.timezone]);
}
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
  /** The owner may explicitly compile this bounded title/date result in chat. */
  ownerCompileAvailable?: boolean;
  /** Canonical owner query validated by the Drive listing parser. */
  ownerCompileQuery?: string;
  /** Fixed discovery window; compiling later must not slide the date range. */
  ownerCompileWindow?: DriveOwnerCompileWindow;
};

export const WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE =
  "one.workspace_connector_setup.v1" as const;

export type WorkspaceConnectorProvider = "drive" | "gmail" | "calendar" | "custom";

export type WorkspaceConnectorSetupExperience = {
  type: typeof WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE;
  provider: WorkspaceConnectorProvider;
  status: "connect_required" | "manage_available";
  saved?: Array<{ id: string; name: string; status: "saved" | "disabled" | "reconnect_needed" }>;
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
  if (toolName === "inspect_private_connectors") {
    const outer = parseRecord(value);
    const result = outer && (typeof outer.status === "string" ? outer : [outer.result, outer.content, outer.data]
      .map(parseRecord)
      .find((candidate) => candidate?.status) ?? outer);
    const saved = parseSavedConnectors(result?.saved);
    return result?.status === "setup_available" && result.provider === "custom"
      ? {
        type: WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE,
        provider: "custom",
        status: "manage_available",
        ...(saved ? { saved } : {}),
      }
      : null;
  }
  if (toolName !== "discover_workspace_tools" && toolName !== "read_workspace_tool") {
    return null;
  }

  const outer = parseRecord(value);
  if (!outer) return null;
  const result = [outer.result, outer.content, outer.data]
    .map(parseRecord)
    .find((candidate) => candidate?.status) ?? outer;
  if (result.status !== "permission_required" &&
    !(toolName === "discover_workspace_tools" && ["api_available", "ok"].includes(String(result.status)))) return null;

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
    status: result.status === "permission_required" ? "connect_required" : "manage_available",
  };
}

type SavedConnector = NonNullable<WorkspaceConnectorSetupExperience["saved"]>[number];

function parseSavedConnectors(value: unknown): SavedConnector[] | null {
  if (!Array.isArray(value) || value.length > 32) return null;
  const saved = value.map((raw) => {
    const item = record(raw);
    return item && typeof item.id === "string" && /^custom_[a-f0-9]{32}$/.test(item.id) &&
      typeof item.name === "string" && item.name.trim().length > 0 && item.name.length <= 100 &&
      !/[\x00-\x1f\x7f]/.test(item.name) &&
      ["saved", "disabled", "reconnect_needed"].includes(String(item.status))
      ? { id: item.id, name: item.name, status: item.status as SavedConnector["status"] }
      : null;
  });
  return saved.every(Boolean) && saved.length ? saved as SavedConnector[] : null;
}

/**
 * Restore a connect/manage card from the server's bound history descriptor.
 * Only a provider enum, a setup status and validated saved-connector labels
 * are accepted; the card still reads the current connection before acting.
 */
export function parseWorkspaceConnectorSetupDescriptor(
  content: unknown,
): WorkspaceConnectorSetupExperience | null {
  const input = parseRecord(content);
  const provider = input?.provider;
  const status = input?.status;
  if (provider === "custom") {
    if (status !== "manage_available") return null;
    const saved = parseSavedConnectors(input?.saved);
    return { type: WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE, provider, status, ...(saved ? { saved } : {}) };
  }
  if (provider !== "drive" && provider !== "gmail" && provider !== "calendar") return null;
  if (status !== "connect_required" && status !== "manage_available") return null;
  return { type: WORKSPACE_CONNECTOR_SETUP_EXPERIENCE_TYPE, provider, status };
}

function utcDay(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
    ? milliseconds : null;
}

export function parseDriveOwnerCompileWindow(value: unknown): DriveOwnerCompileWindow | null {
  const input = record(value);
  if (!input || Object.keys(input).length !== 3 ||
    Object.keys(input).some(key => !["start_date", "end_date", "timezone"].includes(key))) return null;
  const start = utcDay(input.start_date);
  const end = utcDay(input.end_date);
  if (start === null || end === null || end < start || end - start > 30 * 86_400_000 ||
    typeof input.timezone !== "string" || input.timezone.length > 64 ||
    !/^[A-Za-z0-9_+\/-]+$/.test(input.timezone)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    return null;
  }
  return input as DriveOwnerCompileWindow;
}

export function parseConnectorReadReceipt(value: unknown): ConnectorReadExperience | null {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => ![
    "schema_version", "connector", "status", "sources", "truncated", "metadata_only",
    "owner_compile_available", "owner_compile_query", "owner_compile_window",
  ].includes(key))) return null;
  const ownerCompileQuery = input.owner_compile_query;
  const ownerCompileWindow = input.owner_compile_window;
  const validOwnerQuery = typeof ownerCompileQuery === "string" &&
    ownerCompileQuery === ownerCompileQuery.trim() &&
    ownerCompileQuery.length > 0 &&
    new TextEncoder().encode(ownerCompileQuery).byteLength <= 2_048 &&
    !/[\x00-\x1f\x7f]/.test(ownerCompileQuery);
  const validWindow = parseDriveOwnerCompileWindow(ownerCompileWindow);
  if (input.schema_version !== "specialist_read.v1" || !["mail", "drive"].includes(input.connector as string) ||
    !STATUSES.includes(input.status as ConnectorReadExperience["status"]) ||
    typeof input.metadata_only !== "boolean" ||
    (input.connector === "mail" && input.metadata_only !== true) ||
    typeof input.truncated !== "boolean" ||
    !Array.isArray(input.sources) || input.sources.length > 60 ||
    (input.owner_compile_available !== undefined &&
      typeof input.owner_compile_available !== "boolean") ||
    (ownerCompileQuery != null &&
      (!validOwnerQuery || input.owner_compile_available !== true)) ||
    (ownerCompileWindow != null &&
      (!validWindow || input.owner_compile_available !== true)) ||
    ((ownerCompileQuery == null) !== (ownerCompileWindow == null)) ||
    (input.owner_compile_available === true &&
      (input.connector !== "drive" || input.status !== "ok" || input.metadata_only !== true))) return null;
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
      if (source.kind !== (input.metadata_only ? "metadata" : "document") || source.label !== "Document" ||
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
    truncated: input.truncated, metadataOnly: input.metadata_only,
    ...(input.connector === "drive" ? { sourcePages: pages } : {}),
    ...(input.owner_compile_available === true && validOwnerQuery && validWindow
      ? { ownerCompileAvailable: true, ownerCompileQuery: ownerCompileQuery as string,
        ownerCompileWindow: validWindow } : {}),
  };
}

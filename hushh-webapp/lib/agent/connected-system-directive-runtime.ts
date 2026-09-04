import type {
  DelegateResult,
  SpecialistDirective,
} from "@/lib/agent/specialist-directive-runtime";

const ALL_CONNECTED_CRM_SYSTEMS_SCOPE = "all_connected_crm_systems";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseProposedFields(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Produces an in-app CRM proposal only.
 *
 * This deliberately has no ConnectedSystemsService dependency: the private
 * agent does not receive CRM credentials, inspect bindings, select MCP tools,
 * read records, create intents, or approve mutations. The Connected Systems
 * screen revalidates the selected system's public schema/capabilities and
 * requires the person's explicit review before it calls the backend.
 */
export async function runConnectedSystemDirective(
  directive: SpecialistDirective,
  _vaultOwnerToken: string,
  _profileLookup: { email?: string | null; phone?: string | null } = {},
): Promise<DelegateResult> {
  const payload = directive.payload;
  const id = readString(payload.id);
  const type = readString(payload.type || payload.actionId);
  const slots =
    payload.slots &&
    typeof payload.slots === "object" &&
    !Array.isArray(payload.slots)
      ? (payload.slots as Record<string, unknown>)
      : {};
  const systemId = readString(slots.systemId) || "the selected CRM";
  const scope = readString(slots.scope);
  const target =
    scope === ALL_CONNECTED_CRM_SYSTEMS_SCOPE ? "the selected CRM" : systemId;

  if (type === "connected_system.crm.read") {
    return {
      delegate_agent_id: "agent_connected_systems",
      kind: "action",
      id,
      type,
      status: "completed",
      display: `Review the proposed lookup in Connected Systems for ${target}.`,
      detail: "No CRM record was read by the private agent.",
    };
  }

  if (type !== "connected_system.crm.update.propose") {
    return {
      delegate_agent_id: "agent_connected_systems",
      kind: "action",
      id,
      type,
      status: "failed",
      detail: "This CRM action is not available inline yet.",
    };
  }

  const proposedFields = parseProposedFields(slots.additionalFieldsJson);
  const fieldCount = Object.keys(proposedFields).length;
  if (fieldCount === 0) {
    return {
      delegate_agent_id: "agent_connected_systems",
      kind: "action",
      id,
      type,
      status: "failed",
      detail: "I need at least one CRM field change before preparing a proposal.",
    };
  }

  return {
    delegate_agent_id: "agent_connected_systems",
    kind: "action",
    id,
    type,
    status: "completed",
    display: `Review the proposed ${fieldCount} field change${
      fieldCount === 1 ? "" : "s"
    } in Connected Systems before anything is sent to ${target}.`,
    detail: "No CRM record was changed by the private agent.",
  };
}

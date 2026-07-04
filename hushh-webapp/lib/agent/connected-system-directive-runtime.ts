import {
  ConnectedSystemsService,
  type ConnectedSystemMcpResponse,
} from "@/lib/services/connected-systems-service";
import type { DelegateResult, SpecialistDirective } from "@/lib/agent/specialist-directive-runtime";

const DEFAULT_RETURN_FIELDS = [
  "Email",
  "Phone",
  "MobilePhone",
  "LastName",
  "MailingCity",
  "MailingStreet",
  "Title",
  "Department",
  "LeadSource",
];

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseAdditionalFields(value: unknown): Record<string, unknown> {
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

function collectRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (!value || depth > 4) return [];
  if (Array.isArray(value)) {
    const direct = value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
    );
    if (direct.length > 0) return direct;
    return value.flatMap((item) => collectRecords(item, depth + 1));
  }
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["records", "Contact", "contacts", "data", "result", "records_"]) {
    const nested = collectRecords(record[key], depth + 1);
    if (nested.length > 0) return nested;
  }
  return [];
}

function recordIdFromSearch(result: ConnectedSystemMcpResponse): string {
  const bindingId = readString(result.binding?.recordId);
  if (bindingId) return bindingId;
  const resultId = readString(result.recordId);
  if (resultId) return resultId;
  const firstRecord = collectRecords(result.mcp)[0];
  return readString(firstRecord?.Id) || readString(firstRecord?.id);
}

export async function runConnectedSystemDirective(
  directive: SpecialistDirective,
  vaultOwnerToken: string,
  profileLookup: { email?: string | null; phone?: string | null } = {}
): Promise<DelegateResult> {
  const payload = directive.payload;
  const id = readString(payload.id);
  const type = readString(payload.type || payload.actionId);
  const slots =
    payload.slots && typeof payload.slots === "object" && !Array.isArray(payload.slots)
      ? (payload.slots as Record<string, unknown>)
      : {};
  const systemId = readString(slots.systemId) || "salesforce-fsc-customer0";
  const objectType = readString(slots.objectType) || "Contact";

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

  const additionalFields = parseAdditionalFields(slots.additionalFieldsJson);
  if (Object.keys(additionalFields).length === 0) {
    return {
      delegate_agent_id: "agent_connected_systems",
      kind: "action",
      id,
      type,
      status: "failed",
      detail: "I need at least one CRM field change before updating the record.",
    };
  }

  const email = readString(slots.email) || readString(profileLookup.email);
  const phone = readString(slots.phone) || readString(profileLookup.phone);
  let recordId =
    readString(slots.id) || readString(slots.recordId) || readString(slots.record_id);

  if (!recordId) {
    const bindingResult = await ConnectedSystemsService.getRecordBinding({
      vaultOwnerToken,
      systemId,
      objectType,
    }).catch(() => null);
    if (bindingResult?.binding?.status === "active") {
      recordId = readString(bindingResult.binding.recordId);
    }
  }

  if (!recordId && email && phone) {
    const searchResult = await ConnectedSystemsService.searchRecord(vaultOwnerToken, {
      systemId,
      objectType,
      email,
      phone,
      returnFields: DEFAULT_RETURN_FIELDS,
    });
    recordId = recordIdFromSearch(searchResult);
  }

  if (!recordId) {
    return {
      delegate_agent_id: "agent_connected_systems",
      kind: "action",
      id,
      type,
      status: "failed",
      detail: "I could not find a matching CRM record from the provided email and phone.",
    };
  }

  const pendingIntent = await ConnectedSystemsService.updateRecordIntent(vaultOwnerToken, {
    systemId,
    objectType,
    id: recordId,
    additionalFields,
    readbackLocator: email && phone ? { email, phone } : undefined,
  });
  const approved = await ConnectedSystemsService.approveIntent({
    vaultOwnerToken,
    systemId: pendingIntent.systemId,
    intentId: pendingIntent.intentId,
  });

  if (approved.status === "failed") {
    return {
      delegate_agent_id: "agent_connected_systems",
      kind: "action",
      id,
      type,
      status: "failed",
      detail: approved.errorMessage || "The CRM update failed.",
    };
  }

  return {
    delegate_agent_id: "agent_connected_systems",
    kind: "action",
    id,
    type,
    status: "completed",
    display: "Done. The CRM update was approved and applied.",
  };
}

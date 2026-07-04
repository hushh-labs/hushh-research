import {
  ConnectedSystemsService,
  type ConnectedSystemMcpResponse,
  type ConnectedSystemSummary,
} from "@/lib/services/connected-systems-service";
import type { DelegateResult, SpecialistDirective } from "@/lib/agent/specialist-directive-runtime";

const ALL_CONNECTED_CRM_SYSTEMS_SCOPE = "all_connected_crm_systems";
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
  for (const key of ["records", "Contact", "contacts", "data", "payload", "result", "records_"]) {
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

function displayValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function formatFieldLine(label: string, value: string): string {
  return value ? `  - ${label}: ${value}` : "";
}

function readResultLines(result: ConnectedSystemMcpResponse): string[] {
  const record = collectRecords(result.mcp)[0] || {};
  const id = recordIdFromSearch(result);
  const lines = [
    displayValue(record, "FirstName") || displayValue(record, "LastName")
      ? formatFieldLine(
          "Name",
          [displayValue(record, "FirstName"), displayValue(record, "LastName")]
            .filter(Boolean)
            .join(" ")
        )
      : "",
    formatFieldLine("Email", displayValue(record, "Email")),
    formatFieldLine("Phone", displayValue(record, "Phone")),
    formatFieldLine("Mobile", displayValue(record, "MobilePhone")),
    formatFieldLine("City", displayValue(record, "MailingCity")),
    formatFieldLine("Title", displayValue(record, "Title")),
    formatFieldLine("Department", displayValue(record, "Department")),
    formatFieldLine("Lead source", displayValue(record, "LeadSource")),
  ].filter(Boolean);
  return lines.length > 0 ? lines : [id ? `  - Record id: ${id}` : "  - Record found"];
}

function summarizeReadResult(result: ConnectedSystemMcpResponse): string {
  const lines = readResultLines(result);
  if (lines.length === 0) {
    return "CRM record found.";
  }
  return `CRM record found:\n${lines.join("\n")}`;
}

function brandLabel(system: ConnectedSystemSummary): string {
  return (
    readString(system.customerDisplayName) ||
    readString(system.displayName) ||
    readString(system.target) ||
    readString(system.systemId) ||
    "CRM brand"
  );
}

function isUpdatableSystem(system: ConnectedSystemSummary): boolean {
  return system.supportedActions?.update !== false && system.status !== "needs_configuration";
}

function isReadableSystem(system: ConnectedSystemSummary): boolean {
  return system.supportedActions?.read !== false && system.status !== "needs_configuration";
}

async function findRecordIdForSystem(input: {
  vaultOwnerToken: string;
  systemId: string;
  objectType: string;
  email: string;
  phone: string;
}): Promise<string> {
  const bindingResult = await ConnectedSystemsService.getRecordBinding({
    vaultOwnerToken: input.vaultOwnerToken,
    systemId: input.systemId,
    objectType: input.objectType,
  }).catch(() => null);
  if (bindingResult?.binding?.status === "active") {
    const bindingRecordId = readString(bindingResult.binding.recordId);
    if (bindingRecordId) return bindingRecordId;
  }

  if (!input.email || !input.phone) return "";
  const searchResult = await ConnectedSystemsService.searchRecord(input.vaultOwnerToken, {
    systemId: input.systemId,
    objectType: input.objectType,
    email: input.email,
    phone: input.phone,
    returnFields: DEFAULT_RETURN_FIELDS,
  });
  return recordIdFromSearch(searchResult);
}

async function updateOneSystem(input: {
  vaultOwnerToken: string;
  system: ConnectedSystemSummary;
  objectType: string;
  email: string;
  phone: string;
  additionalFields: Record<string, unknown>;
}): Promise<{ label: string; status: "updated" | "skipped" | "failed"; detail: string }> {
  const label = brandLabel(input.system);
  try {
    const recordId = await findRecordIdForSystem({
      vaultOwnerToken: input.vaultOwnerToken,
      systemId: input.system.systemId,
      objectType: input.objectType,
      email: input.email,
      phone: input.phone,
    });
    if (!recordId) {
      return {
        label,
        status: "skipped",
        detail: input.email && input.phone ? "No matching record found." : "No binding or lookup identity.",
      };
    }
    const pendingIntent = await ConnectedSystemsService.updateRecordIntent(input.vaultOwnerToken, {
      systemId: input.system.systemId,
      objectType: input.objectType,
      id: recordId,
      additionalFields: input.additionalFields,
      readbackLocator:
        input.email && input.phone ? { email: input.email, phone: input.phone } : undefined,
    });
    const approved = await ConnectedSystemsService.approveIntent({
      vaultOwnerToken: input.vaultOwnerToken,
      systemId: pendingIntent.systemId,
      intentId: pendingIntent.intentId,
    });
    if (approved.status === "failed") {
      return {
        label,
        status: "failed",
        detail: approved.errorMessage || "Update failed.",
      };
    }
    return { label, status: "updated", detail: "Updated." };
  } catch (error) {
    return {
      label,
      status: "failed",
      detail: error instanceof Error ? error.message : "Update failed.",
    };
  }
}

async function runAllConnectedCrmUpdate(input: {
  id: string;
  type: string;
  vaultOwnerToken: string;
  objectType: string;
  email: string;
  phone: string;
  additionalFields: Record<string, unknown>;
}): Promise<DelegateResult> {
  const systems = (await ConnectedSystemsService.listSystems(input.vaultOwnerToken)).filter(
    isUpdatableSystem
  );
  if (systems.length === 0) {
    return {
      delegate_agent_id: "agent_connected_systems",
      kind: "action",
      id: input.id,
      type: input.type,
      status: "failed",
      detail: "I could not find any connected CRM brands to update.",
    };
  }

  const results = [];
  for (const system of systems) {
    results.push(
      await updateOneSystem({
        vaultOwnerToken: input.vaultOwnerToken,
        system,
        objectType: input.objectType,
        email: input.email,
        phone: input.phone,
        additionalFields: input.additionalFields,
      })
    );
  }

  const updated = results.filter((result) => result.status === "updated");
  const failed = results.filter((result) => result.status === "failed");
  const skipped = results.filter((result) => result.status === "skipped");
  const lines = [
    `Updated ${updated.length} of ${results.length} connected CRM brand${
      results.length === 1 ? "" : "s"
    }.`,
    ...results.map((result) => `- ${result.label}: ${result.detail}`),
  ];
  return {
    delegate_agent_id: "agent_connected_systems",
    kind: "action",
    id: input.id,
    type: input.type,
    status: failed.length > 0 && updated.length === 0 ? "failed" : "completed",
    display: lines.join("\n"),
    detail:
      failed.length || skipped.length
        ? `${failed.length} failed, ${skipped.length} skipped.`
        : undefined,
  };
}

async function runCrmRead(input: {
  id: string;
  type: string;
  vaultOwnerToken: string;
  systemId: string;
  objectType: string;
  email: string;
  phone: string;
}): Promise<DelegateResult> {
  if (!input.email || !input.phone) {
    return {
      delegate_agent_id: "agent_connected_systems",
      kind: "action",
      id: input.id,
      type: input.type,
      status: "failed",
      detail: "I need the email and phone number before I can read the CRM record.",
    };
  }

  const result = await ConnectedSystemsService.readRecord(input.vaultOwnerToken, {
    systemId: input.systemId,
    objectType: input.objectType,
    email: input.email,
    phone: input.phone,
    returnFields: DEFAULT_RETURN_FIELDS,
  });
  const recordId = recordIdFromSearch(result);
  const records = collectRecords(result.mcp);
  if (!recordId && records.length === 0) {
    return {
      delegate_agent_id: "agent_connected_systems",
      kind: "action",
      id: input.id,
      type: input.type,
      status: "failed",
      detail: "No matching CRM record found.",
    };
  }

  return {
    delegate_agent_id: "agent_connected_systems",
    kind: "action",
    id: input.id,
    type: input.type,
    status: "completed",
    display: summarizeReadResult(result),
  };
}

async function readOneSystem(input: {
  vaultOwnerToken: string;
  system: ConnectedSystemSummary;
  objectType: string;
  email: string;
  phone: string;
}): Promise<{ label: string; status: "found" | "skipped" | "failed"; detail: string }> {
  const label = brandLabel(input.system);
  if (!input.email || !input.phone) {
    return { label, status: "skipped", detail: "No lookup identity." };
  }
  try {
    const result = await ConnectedSystemsService.readRecord(input.vaultOwnerToken, {
      systemId: input.system.systemId,
      objectType: input.objectType,
      email: input.email,
      phone: input.phone,
      returnFields: DEFAULT_RETURN_FIELDS,
    });
    const recordId = recordIdFromSearch(result);
    const records = collectRecords(result.mcp);
    if (!recordId && records.length === 0) {
      return { label, status: "skipped", detail: "No matching record found." };
    }
    return {
      label,
      status: "found",
      detail: readResultLines(result).join("\n"),
    };
  } catch (error) {
    return {
      label,
      status: "failed",
      detail: error instanceof Error ? error.message : "Read failed.",
    };
  }
}

async function runAllConnectedCrmRead(input: {
  id: string;
  type: string;
  vaultOwnerToken: string;
  objectType: string;
  email: string;
  phone: string;
}): Promise<DelegateResult> {
  const systems = (await ConnectedSystemsService.listSystems(input.vaultOwnerToken)).filter(
    isReadableSystem
  );
  if (systems.length === 0) {
    return {
      delegate_agent_id: "agent_connected_systems",
      kind: "action",
      id: input.id,
      type: input.type,
      status: "failed",
      detail: "I could not find any connected CRM brands to read.",
    };
  }

  const results = [];
  for (const system of systems) {
    results.push(
      await readOneSystem({
        vaultOwnerToken: input.vaultOwnerToken,
        system,
        objectType: input.objectType,
        email: input.email,
        phone: input.phone,
      })
    );
  }

  const found = results.filter((result) => result.status === "found");
  const failed = results.filter((result) => result.status === "failed");
  const skipped = results.filter((result) => result.status === "skipped");
  return {
    delegate_agent_id: "agent_connected_systems",
    kind: "action",
    id: input.id,
    type: input.type,
    status: failed.length > 0 && found.length === 0 ? "failed" : "completed",
    display: [
      `Found records in ${found.length} of ${results.length} connected CRM brand${
        results.length === 1 ? "" : "s"
      }.`,
      "",
      ...results.flatMap((result) => [`**${result.label}**`, result.detail, ""]),
    ]
      .join("\n")
      .trim(),
    detail:
      failed.length || skipped.length
        ? `${failed.length} failed, ${skipped.length} skipped.`
        : undefined,
  };
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
  const scope = readString(slots.scope);

  const email = readString(slots.email) || readString(profileLookup.email);
  const phone = readString(slots.phone) || readString(profileLookup.phone);

  if (type === "connected_system.crm.read") {
    if (scope === ALL_CONNECTED_CRM_SYSTEMS_SCOPE) {
      return runAllConnectedCrmRead({
        id,
        type,
        vaultOwnerToken,
        objectType,
        email,
        phone,
      });
    }
    return runCrmRead({
      id,
      type,
      vaultOwnerToken,
      systemId,
      objectType,
      email,
      phone,
    });
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

  if (scope === ALL_CONNECTED_CRM_SYSTEMS_SCOPE) {
    return runAllConnectedCrmUpdate({
      id,
      type,
      vaultOwnerToken,
      objectType,
      email,
      phone,
      additionalFields,
    });
  }

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

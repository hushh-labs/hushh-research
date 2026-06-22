import { ApiService } from "@/lib/services/api-service";

export const SALESFORCE_CRM_SYSTEM_ID = "salesforce-fsc-customer0";

export type ConnectedSystemStatus = "connected" | "needs_configuration" | string;

export type ConnectedSystemSummary = {
  systemId: string;
  displayName: string;
  customerDisplayName?: string;
  systemType?: string;
  systemName?: string;
  status: ConnectedSystemStatus;
  target: string;
  objectTypeDefault: string;
  transport: string;
  transportLabel?: string;
  endpointConfigured?: boolean;
  registrySource?: string;
  toolCatalog?: Array<{
    name: string;
    operation?: string;
    description?: string;
  }>;
  supportedActions?: {
    schema?: boolean;
    read?: boolean;
    create?: boolean;
    update?: boolean;
    delete?: boolean;
  };
  fieldAllowlist?: string[];
};

export type ConnectedSystemSchemaResponse = {
  systemId: string;
  target: string;
  objectType: string;
  supportedFields: string[];
  fields?: Array<{
    key: string;
    name?: string;
    label?: string;
    dataType?: string;
    required?: boolean;
    identityField?: boolean;
    writable?: boolean;
    source?: string;
  }>;
  mcp: Record<string, unknown>;
};

export type ConnectedSystemMcpResponse = {
  systemId: string;
  target: string;
  objectType: string;
  recordId?: string | null;
  resultClass: "succeeded" | "failed" | string;
  mcp: Record<string, unknown>;
  bindingStatus?: "active" | "unbound" | string;
  binding?: ConnectedSystemRecordBinding | null;
};

export type ConnectedSystemRecordBinding = {
  bindingId?: string | null;
  systemId: string;
  target?: string | null;
  objectType?: string | null;
  recordId?: string | null;
  status: "active" | "unbound" | "deleted" | string;
  createdIntentId?: string | null;
  lastIntentId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deletedAt?: string | null;
};

export type ConnectedSystemBindingResponse = {
  systemId: string;
  target: string;
  objectType: string;
  status: "active" | "unbound" | string;
  binding?: ConnectedSystemRecordBinding | null;
};

export type ConnectedSystemIntent = {
  intentId: string;
  systemId: string;
  target?: string;
  objectType?: string;
  action: "create" | "update" | string;
  status: "pending" | "approved" | "rejected" | "succeeded" | "partial" | "failed" | string;
  recordId?: string | null;
  approvalId?: string | null;
  fieldNames: string[];
  payloadSummary?: Record<string, unknown>;
  resultClass?: string | null;
  result?: Record<string, unknown>;
  readback?: Record<string, unknown>;
  binding?: ConnectedSystemRecordBinding | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ConnectedSystemReadInput = {
  systemId?: string;
  objectType?: string;
  email: string;
  phone: string;
  searchFields?: Record<string, unknown>;
  returnFields?: string[];
};

export type ConnectedSystemCreateIntentInput = {
  systemId?: string;
  objectType?: string;
  email: string;
  phone: string;
  firstName?: string;
  lastName: string;
  additionalFields?: Record<string, unknown>;
};

export type ConnectedSystemUpdateIntentInput = {
  systemId?: string;
  objectType?: string;
  id: string;
  additionalFields: Record<string, unknown>;
  readbackLocator?: {
    email: string;
    phone: string;
    searchFields?: Record<string, unknown>;
  };
};

export type ConnectedSystemDeleteInput = {
  systemId?: string;
  objectType?: string;
  id?: string;
};

function authHeaders(vaultOwnerToken: string): HeadersInit {
  return ApiService.getAuthHeaders(vaultOwnerToken);
}

async function readJsonOrThrow<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (response.ok) {
    return payload as T;
  }
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const detail = record.detail && typeof record.detail === "object"
    ? (record.detail as Record<string, unknown>)
    : record;
  const message =
    typeof detail.message === "string"
      ? detail.message
      : typeof record.message === "string"
        ? record.message
        : `Connected Systems request failed (${response.status}).`;
  throw new Error(message);
}

function systemPath(systemId?: string): string {
  return encodeURIComponent(systemId || SALESFORCE_CRM_SYSTEM_ID);
}

export class ConnectedSystemsService {
  static async listSystems(vaultOwnerToken: string): Promise<ConnectedSystemSummary[]> {
    const response = await ApiService.apiFetch("/api/connected-systems", {
      method: "GET",
      headers: authHeaders(vaultOwnerToken),
    });
    const payload = await readJsonOrThrow<{ systems?: ConnectedSystemSummary[] }>(response);
    return Array.isArray(payload.systems) ? payload.systems : [];
  }

  static async getSchema(input: {
    vaultOwnerToken: string;
    systemId?: string;
    objectType?: string;
  }): Promise<ConnectedSystemSchemaResponse> {
    const query = new URLSearchParams();
    if (input.objectType) query.set("objectType", input.objectType);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/schema${suffix}`,
      {
        method: "GET",
        headers: authHeaders(input.vaultOwnerToken),
      }
    );
    return readJsonOrThrow<ConnectedSystemSchemaResponse>(response);
  }

  static async readRecord(
    vaultOwnerToken: string,
    input: ConnectedSystemReadInput
  ): Promise<ConnectedSystemMcpResponse> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/records/read`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({
          objectType: input.objectType,
          email: input.email,
          phone: input.phone,
          searchFields: input.searchFields,
          returnFields: input.returnFields,
        }),
      }
    );
    return readJsonOrThrow<ConnectedSystemMcpResponse>(response);
  }

  static async getRecordBinding(input: {
    vaultOwnerToken: string;
    systemId?: string;
    objectType?: string;
  }): Promise<ConnectedSystemBindingResponse> {
    const query = new URLSearchParams();
    if (input.objectType) query.set("objectType", input.objectType);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/record-binding${suffix}`,
      {
        method: "GET",
        headers: authHeaders(input.vaultOwnerToken),
      }
    );
    return readJsonOrThrow<ConnectedSystemBindingResponse>(response);
  }

  static async searchRecord(
    vaultOwnerToken: string,
    input: ConnectedSystemReadInput
  ): Promise<ConnectedSystemMcpResponse> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/records/search`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({
          objectType: input.objectType,
          email: input.email,
          phone: input.phone,
          searchFields: input.searchFields,
          returnFields: input.returnFields,
        }),
      }
    );
    return readJsonOrThrow<ConnectedSystemMcpResponse>(response);
  }

  static async createRecordIntent(
    vaultOwnerToken: string,
    input: ConnectedSystemCreateIntentInput
  ): Promise<ConnectedSystemIntent> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/records/create-intents`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({
          objectType: input.objectType,
          email: input.email,
          phone: input.phone,
          firstName: input.firstName,
          lastName: input.lastName,
          additionalFields: input.additionalFields,
        }),
      }
    );
    return readJsonOrThrow<ConnectedSystemIntent>(response);
  }

  static async updateRecordIntent(
    vaultOwnerToken: string,
    input: ConnectedSystemUpdateIntentInput
  ): Promise<ConnectedSystemIntent> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/records/update-intents`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({
          objectType: input.objectType,
          id: input.id,
          additionalFields: input.additionalFields,
          readbackLocator: input.readbackLocator,
        }),
      }
    );
    return readJsonOrThrow<ConnectedSystemIntent>(response);
  }

  static async approveIntent(input: {
    vaultOwnerToken: string;
    systemId?: string;
    intentId: string;
  }): Promise<ConnectedSystemIntent> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/intents/${encodeURIComponent(
        input.intentId
      )}/approve`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
      }
    );
    return readJsonOrThrow<ConnectedSystemIntent>(response);
  }

  static async rejectIntent(input: {
    vaultOwnerToken: string;
    systemId?: string;
    intentId: string;
  }): Promise<ConnectedSystemIntent> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/intents/${encodeURIComponent(
        input.intentId
      )}/reject`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
      }
    );
    return readJsonOrThrow<ConnectedSystemIntent>(response);
  }

  static async deleteRecord(
    vaultOwnerToken: string,
    input: ConnectedSystemDeleteInput
  ): Promise<Record<string, unknown>> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/records/delete`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({
          objectType: input.objectType,
          id: input.id,
        }),
      }
    );
    return readJsonOrThrow<Record<string, unknown>>(response);
  }
}

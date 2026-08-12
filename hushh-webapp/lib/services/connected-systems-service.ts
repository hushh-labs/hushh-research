import { ApiService } from "@/lib/services/api-service";
import type {
  CrmZkUatConfiguration,
  CrmZkUatEncryptedFields,
} from "@/lib/connected-systems/crm-zk-uat-v1";

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
  capabilities?: {
    operations?: Array<"schema" | "read" | "create" | "update" | "delete">;
    primaryObject?: string;
    version?: string;
  };
  fieldAllowlist?: string[];
  configurationRevision?: number;
  crmZk?: {
    enabled?: boolean;
    profile?: "crm-zk.v1" | string | null;
    readReady?: boolean;
    updateReady?: boolean;
  };
};

export type ConnectedSystemsRegistryResponse = {
  registryRevision: number;
  systems: ConnectedSystemSummary[];
};

export type ConnectedSystemSchemaResponse = {
  systemId: string;
  target: string;
  objectType: string;
  objectMetadata?: {
    name: string;
    label: string;
  };
  supportedFields: string[];
  fields?: Array<{
    key: string;
    name?: string;
    label?: string;
    dataType?: string;
    required?: boolean;
    identityField?: boolean;
    readable?: boolean;
    createable?: boolean;
    updateable?: boolean;
    writable?: boolean;
    immutable?: boolean;
    /** CRM supplies this field automatically when a record is created. */
    defaultedOnCreate?: boolean;
    permissionsDeclared?: boolean;
    constraints?: Record<string, unknown>;
    source?: string;
  }>;
  /** Schema-derived mapping for basic onboarding fields, never user supplied. */
  profileFieldMappings?: Partial<{
    email: string;
    phone: string;
    firstName: string;
    lastName: string;
    fullName: string;
    address: string;
  }>;
  schemaMappingStatus?: "ready" | "unavailable" | "pending" | string;
  schemaStatus?: "ready" | "capability_metadata_missing" | string;
  accessMetadata?: "declared" | "partial" | string;
  effectiveActions?: {
    schema?: boolean;
    read?: boolean;
    create?: boolean;
    update?: boolean;
    delete?: boolean;
  };
  configurationMessage?: string | null;
  configurationRevision?: number;
  schemaFingerprint?: string;
  freshness?: "fresh" | "stale_display_only" | string;
  refreshedAt?: string | null;
  refreshGuidance?: string | null;
};

export type ConnectedSystemRecord = {
  recordId?: string | null;
  fields: Record<string, string | number | boolean | null>;
};

export type ConnectedSystemMcpResponse = {
  systemId: string;
  target: string;
  objectType: string;
  recordId?: string | null;
  resultClass: "succeeded" | "failed" | string;
  records?: ConnectedSystemRecord[];
  bindingStatus?: "active" | "unbound" | "remote_record_missing" | string;
  binding?: ConnectedSystemRecordBinding | null;
  recoveryAction?: "create_or_relink" | string;
};

export type ConnectedSystemRecordBinding = {
  bindingId?: string | null;
  systemId: string;
  target?: string | null;
  objectType?: string | null;
  recordId?: string | null;
  status: "active" | "unbound" | "deleted" | "disconnected" | string;
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
  action: "create" | "update" | "delete" | string;
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
  deliveryMode?: "legacy" | "crm-zk.v1" | "crm-zk-uat.v1" | string;
  envelopeDigest?: string | null;
  encryptedResponse?: Record<string, unknown>;
};

export type CrmZkConfiguration = {
  profile: "crm-zk.v1";
  hkdf: { hash: "SHA-256"; salt: string; info: "crm-zk.v1:key-wrap"; lengthBytes: 32 };
  configurationRevision: number;
  recipientKey: { keyId: string; publicKey: string; fingerprint: string };
  responseSigningKey: { keyId: string; publicKey: string; fingerprint: string; algorithm: string };
};

export type CrmZkContext = {
  profile: "crm-zk.v1";
  contextId: string;
  contextDigest: string;
  systemId: string;
  operation: "read" | "update";
  objectType: string;
  fieldNames: string[];
  schemaFingerprint?: string | null;
  configurationRevision: number;
  recipientKeyId: string;
  recipientKeyFingerprint: string;
  clientOperationId: string;
  expiresAtMs: number;
};

export type ConnectedSystemReadInput = {
  systemId?: string;
  objectType?: string;
  returnFields?: string[];
};

export type ConnectedSystemCreateIntentInput = {
  systemId?: string;
  objectType?: string;
};

export type ConnectedSystemUpdateIntentInput = {
  systemId?: string;
  objectType?: string;
  additionalFields: Record<string, unknown>;
  /** Typed field diff for schema-driven CRM forms. */
  recordFields?: Record<string, unknown>;
};

export type ConnectedSystemDeleteInput = {
  systemId?: string;
  objectType?: string;
};

function authHeaders(vaultOwnerToken: string): HeadersInit {
  return ApiService.getAuthHeaders(vaultOwnerToken);
}

export class ConnectedSystemsRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number
  ) {
    super(message);
    this.name = "ConnectedSystemsRequestError";
  }
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
  throw new ConnectedSystemsRequestError(
    message,
    typeof detail.code === "string" ? detail.code : null,
    response.status
  );
}

function systemPath(systemId?: string): string {
  const selectedSystemId = String(systemId || "").trim();
  if (!selectedSystemId) {
    throw new Error("Select a connected CRM before making a record request.");
  }
  return encodeURIComponent(selectedSystemId);
}

export class ConnectedSystemsService {
  /**
   * List connected CRM systems (registry metadata only; no user records).
   *
   * Signed-in is enough: pass a vault owner token when one is available (agent
   * lanes), otherwise the caller's Firebase ID token. The backend accepts both.
   */
  static async listSystems(authToken: string): Promise<ConnectedSystemSummary[]> {
    return (await this.getRegistry(authToken)).systems;
  }

  static async getRegistry(authToken: string): Promise<ConnectedSystemsRegistryResponse> {
    const response = await ApiService.apiFetch("/api/connected-systems", {
      method: "GET",
      headers: authHeaders(authToken),
    });
    const payload = await readJsonOrThrow<Partial<ConnectedSystemsRegistryResponse>>(response);
    return {
      registryRevision: Number(payload.registryRevision || 0),
      systems: Array.isArray(payload.systems) ? payload.systems : [],
    };
  }

  static async getSchema(input: {
    vaultOwnerToken: string;
    systemId?: string;
    objectType?: string;
    forceRefresh?: boolean;
  }): Promise<ConnectedSystemSchemaResponse> {
    const query = new URLSearchParams();
    if (input.objectType) query.set("objectType", input.objectType);
    if (input.forceRefresh) query.set("forceRefresh", "true");
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

  static async getCrmZkConfiguration(input: {
    vaultOwnerToken: string;
    systemId?: string;
  }): Promise<CrmZkConfiguration> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/crm-zk/config`,
      { method: "GET", headers: authHeaders(input.vaultOwnerToken) }
    );
    return readJsonOrThrow<CrmZkConfiguration>(response);
  }

  static async getCrmZkUatConfiguration(input: {
    vaultOwnerToken: string;
    systemId?: string;
  }): Promise<CrmZkUatConfiguration> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/crm-zk-uat/config`,
      { method: "GET", headers: authHeaders(input.vaultOwnerToken) }
    );
    return readJsonOrThrow<CrmZkUatConfiguration>(response);
  }

  static async searchCrmZkUatRecord(input: {
    vaultOwnerToken: string;
    systemId?: string;
    objectType?: string;
    returnFields: string[];
    encryptedFields: CrmZkUatEncryptedFields;
  }): Promise<{
    profile: "crm-zk-uat.v1";
    systemId: string;
    objectType: string;
    status: string;
    totalSize: number;
    recordId?: string | null;
    bindingStatus: string;
    binding?: ConnectedSystemRecordBinding | null;
    encryptedFields: CrmZkUatEncryptedFields;
  }> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/records/search-zk-uat`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
        body: JSON.stringify({
          objectType: input.objectType,
          returnFields: input.returnFields,
          encryptedFields: input.encryptedFields,
        }),
      }
    );
    return readJsonOrThrow(response);
  }

  static async createCrmZkUatUpdateIntent(input: {
    vaultOwnerToken: string;
    systemId?: string;
    objectType?: string;
    fieldNames: string[];
    encryptedFields: CrmZkUatEncryptedFields;
  }): Promise<ConnectedSystemIntent> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/records/update-intents-zk-uat`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
        body: JSON.stringify({
          objectType: input.objectType,
          fieldNames: input.fieldNames,
          encryptedFields: input.encryptedFields,
        }),
      }
    );
    return readJsonOrThrow<ConnectedSystemIntent>(response);
  }

  static async approveCrmZkUatIntent(input: {
    vaultOwnerToken: string;
    systemId?: string;
    intentId: string;
  }): Promise<ConnectedSystemIntent> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/intents/${encodeURIComponent(input.intentId)}/approve-zk-uat`,
      { method: "POST", headers: authHeaders(input.vaultOwnerToken) }
    );
    return readJsonOrThrow<ConnectedSystemIntent>(response);
  }

  static async registerCrmZkOwnerSigningKey(input: {
    vaultOwnerToken: string;
    systemId?: string;
    keyId: string;
    publicKeySpki: string;
  }): Promise<{ keyId: string; fingerprint: string; algorithm: string; status: string }> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/crm-zk/owner-signing-keys`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
        body: JSON.stringify({ keyId: input.keyId, publicKeySpki: input.publicKeySpki }),
      }
    );
    return readJsonOrThrow(response);
  }

  static async prepareCrmZkContext(input: {
    vaultOwnerToken: string;
    systemId?: string;
    operation: "read" | "update";
    objectType?: string;
    fieldNames: string[];
  }): Promise<CrmZkContext> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/crm-zk/contexts`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
        body: JSON.stringify({
          operation: input.operation,
          objectType: input.objectType,
          fieldNames: input.fieldNames,
        }),
      }
    );
    return readJsonOrThrow<CrmZkContext>(response);
  }

  static async readCrmZkRecord(input: {
    vaultOwnerToken: string;
    systemId?: string;
    encryptedFields: Record<string, unknown>;
  }): Promise<{ profile: "crm-zk.v1"; contextId: string; envelopeDigest: string; encryptedFields: Record<string, unknown> }> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/records/read-zk`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
        body: JSON.stringify({ encryptedFields: input.encryptedFields }),
      }
    );
    return readJsonOrThrow(response);
  }

  static async createCrmZkUpdateIntent(input: {
    vaultOwnerToken: string;
    systemId?: string;
    encryptedFields: Record<string, unknown>;
  }): Promise<ConnectedSystemIntent> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/records/update-intents-zk`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
        body: JSON.stringify({ encryptedFields: input.encryptedFields }),
      }
    );
    return readJsonOrThrow<ConnectedSystemIntent>(response);
  }

  static async createCrmZkApprovalChallenge(input: {
    vaultOwnerToken: string;
    systemId?: string;
    intentId: string;
  }): Promise<{ challengeId: string; intentId: string; envelopeDigest: string; nonce: string; expiresAtMs: number }> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/intents/${encodeURIComponent(input.intentId)}/approval-challenge`,
      { method: "POST", headers: authHeaders(input.vaultOwnerToken) }
    );
    return readJsonOrThrow(response);
  }

  static async approveCrmZkIntent(input: {
    vaultOwnerToken: string;
    systemId?: string;
    intentId: string;
    approvalProof: Record<string, unknown>;
  }): Promise<ConnectedSystemIntent> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/intents/${encodeURIComponent(input.intentId)}/approve-zk`,
      {
        method: "POST",
        headers: authHeaders(input.vaultOwnerToken),
        body: JSON.stringify({ approvalProof: input.approvalProof }),
      }
    );
    return readJsonOrThrow<ConnectedSystemIntent>(response);
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

  static async disconnectRecordBinding(input: {
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
        method: "DELETE",
        headers: authHeaders(input.vaultOwnerToken),
      }
    );
    return readJsonOrThrow<ConnectedSystemBindingResponse>(response);
  }

  static async listRecordBindingStatuses(
    vaultOwnerToken: string
  ): Promise<{ bindings: Array<{ systemId: string; objectType: string; status: string }> }> {
    const response = await ApiService.apiFetch("/api/connected-systems/record-bindings", {
      method: "GET",
      headers: authHeaders(vaultOwnerToken),
    });
    const payload = await readJsonOrThrow<{
      bindings?: Array<{ systemId: string; objectType: string; status: string }>;
    }>(response);
    return { bindings: Array.isArray(payload.bindings) ? payload.bindings : [] };
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
          additionalFields: input.additionalFields,
          recordFields: input.recordFields,
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

  /** Create a reviewable delete intent. Approval is a separate explicit call. */
  static async createDeleteIntent(
    vaultOwnerToken: string,
    input: ConnectedSystemDeleteInput
  ): Promise<ConnectedSystemIntent> {
    const response = await ApiService.apiFetch(
      `/api/connected-systems/${systemPath(input.systemId)}/records/delete-intents`,
      {
        method: "POST",
        headers: authHeaders(vaultOwnerToken),
        body: JSON.stringify({
          objectType: input.objectType,
        }),
      }
    );
    return readJsonOrThrow<ConnectedSystemIntent>(response);
  }
}

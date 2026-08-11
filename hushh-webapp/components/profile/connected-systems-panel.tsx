"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Building2,
  Database,
  ListChecks,
  LockKeyhole,
  Pencil,
  RefreshCw,
  SendHorizontal,
  Trash2,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/profile/settings-ui";
import { DataTable } from "@/components/app-ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Icon } from "@/lib/morphy-ux/ui";
import { Button } from "@/lib/morphy-ux/morphy";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { buildConnectedSystemRoute, ROUTES } from "@/lib/navigation/routes";
import { resolveCrmLogoAsset } from "@/lib/branding/crm-logo-registry";
import { cn } from "@/lib/utils";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { ConnectedSystemsResourceService } from "@/lib/services/connected-systems-resource-service";
import {
  createCrmZkEnvelope,
  decryptCrmZkPartnerResponse,
  ensureCrmZkOwnerSigningKey,
  signCrmZkApproval,
  type CrmZkPartnerResponseEnvelope,
} from "@/lib/connected-systems/crm-zk-v1";
import {
  ConnectedSystemsService,
  ConnectedSystemsRequestError,
  type ConnectedSystemMcpResponse,
  type ConnectedSystemIntent,
  type ConnectedSystemRecordBinding,
  type ConnectedSystemSchemaResponse,
  type ConnectedSystemSummary,
  type ConnectedSystemsRegistryResponse,
} from "@/lib/services/connected-systems-service";

type BusyState =
  | "systems"
  | "schema"
  | "binding"
  | "lookup"
  | "read"
  | "create"
  | "update"
  | "delete"
  | null;

type ConnectedSystemsPanelProps = {
  cacheUserId?: string | null;
  /** Unlock-bound key used only to encrypt the owner's P-256 signing key in PKM. */
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
  onRequestUnlock?: () => void;
  mode?: "list" | "detail";
  systemId?: string | null;
  agentInstruction?: ConnectedSystemAgentInstruction | null;
  profile?: {
    displayName?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  /** Setup adapter hook; normal workspaces leave this undefined. */
  onSetupReadinessChange?: (ready: boolean) => void;
  /** Keeps a setup list inside its static setup workspace. */
  setupRouteBase?: string | null;
  /** Removes post-setup administration while preserving secure CRM contracts. */
  presentation?: "workspace" | "setup";
  /** Lets the route shell own the single CRM title without a body duplicate. */
  onSystemResolved?: (system: ConnectedSystemSummary) => void;
};

export type ConnectedSystemAgentInstruction = {
  actionId: string;
  slots?: Record<string, unknown>;
  createdAt?: string;
};

type CrmProfileFieldKey = string;
type CrmFieldValues = Record<string, string>;

type CrmProfileField = {
  key: CrmProfileFieldKey;
  label: string;
  placeholder: string;
  inputType?: string;
  required?: boolean;
  identityField?: boolean;
  /** A verified-identity field used to bind this CRM record to its owner. */
  bindingKey?: boolean;
  readable?: boolean;
  createable?: boolean;
  updateable?: boolean;
  writable?: boolean;
  immutable?: boolean;
  rawName?: string;
  source?: string;
  dataType?: string;
  constraints?: Record<string, unknown>;
};

type CrmFieldTableRow = {
  key: string;
  label: string;
  currentValue: string;
  field: CrmProfileField;
};

type PendingUpdateReviewField = {
  key: string;
  label: string;
  previousValue: string;
  nextValue: string;
};

type PendingUpdateReview = {
  recordFields: CrmFieldValues;
  fields: PendingUpdateReviewField[];
};

function statusBadge(status: string | undefined | null): string {
  if (!status) return "Unknown";
  return status
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function registryAvailabilityLabel(
  system?: ConnectedSystemSummary | null,
): string {
  // `status: connected` is a legacy registry transport label. It says the
  // configured CRM endpoint is reachable, not that this person has a CRM
  // record linked to One. Keep that distinction explicit in every surface.
  if (system?.endpointConfigured || system?.status === "connected") {
    return "Available";
  }
  if (system?.status === "needs_configuration") return "Needs setup";
  return statusBadge(system?.status);
}

const DEFAULT_CRM_PROFILE_VALUES: CrmFieldValues = {};

function inputTypeFromSchema(dataType?: string): string | undefined {
  const normalized = String(dataType || "")
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("email")) return "email";
  if (normalized.includes("phone") || normalized.includes("tel")) return "tel";
  if (normalized.includes("url")) return "url";
  return "text";
}

function crmFieldFromSchemaDescriptor(
  descriptor: NonNullable<ConnectedSystemSchemaResponse["fields"]>[number],
): CrmProfileField | null {
  const key = String(descriptor.key || descriptor.name || "").trim();
  if (!key) return null;
  const label = String(descriptor.label || key)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return {
    key,
    label: label || key,
    placeholder: `Enter ${label || key}`,
    inputType: inputTypeFromSchema(descriptor.dataType),
    required: descriptor.required === true,
    identityField: descriptor.identityField === true,
    readable: descriptor.readable,
    createable: descriptor.createable,
    updateable: descriptor.updateable,
    writable: descriptor.writable ?? descriptor.updateable,
    immutable: descriptor.immutable,
    rawName: String(descriptor.name || key).trim() || key,
    source: String(descriptor.source || "mcp_schema").trim() || "mcp_schema",
    dataType: String(descriptor.dataType || "string"),
    constraints: descriptor.constraints,
  };
}

export function crmTypeDisplayLabel(
  system?: Pick<ConnectedSystemSummary, "systemType" | "systemName"> | null,
): string {
  return String(system?.systemType || system?.systemName || "").trim();
}

export function ConnectedSystemLogo({
  system,
  size = "row",
}: {
  system?: ConnectedSystemSummary | null;
  size?: "row" | "hero";
}) {
  const logo = resolveCrmLogoAsset(system);
  const label = system?.customerDisplayName || system?.target || "CRM system";
  // A registry mark is optional presentation metadata. Its absence must not
  // change the row geometry: every system occupies the same fixed logo frame.
  const dimensions =
    size === "hero"
      ? "h-14 w-28 rounded-[18px] p-2"
      : "h-11 w-[4.75rem] rounded-[14px] p-2";

  return (
    <span
      data-logo-kind={logo ? "brand" : "fallback"}
      data-slot="connected-system-logo"
      className={`${dimensions} inline-flex shrink-0 items-center justify-center overflow-hidden border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] shadow-[var(--shadow-xs)] ${logo ? "!bg-white dark:!bg-white" : "text-muted-foreground"}`}
    >
      {logo ? (
        <Image
          src={logo.src}
          alt={logo.alt || `${label} logo`}
          width={size === "hero" ? 48 : 40}
          height={size === "hero" ? 48 : 40}
          className="h-full w-full object-contain filter-none"
          unoptimized
        />
      ) : (
        <Icon icon={Building2} size={size === "hero" ? "md" : "sm"} />
      )}
    </span>
  );
}

function extractRecords(
  result: ConnectedSystemMcpResponse | null,
): Record<string, unknown>[] {
  return (result?.records || []).map((record) => ({
    ...record.fields,
    __connectedSystemRecordId: record.recordId || "",
  }));
}

function recordIdFromRecord(record?: Record<string, unknown> | null): string {
  if (!record) return "";
  return cleanFieldValue(
    record.__connectedSystemRecordId ||
      record.Id ||
      record.id ||
      record.recordId ||
      record.record_id,
  );
}

function selectRecordForId(
  result: ConnectedSystemMcpResponse | null,
  recordId?: string | null,
): Record<string, unknown> | null {
  const records = extractRecords(result);
  if (records.length === 0) return null;
  const cleanRecordId = cleanFieldValue(recordId);
  if (!cleanRecordId) return records[0] || null;
  return (
    records.find((record) => recordIdFromRecord(record) === cleanRecordId) ||
    null
  );
}

function extractFirstRecordId(
  result: ConnectedSystemMcpResponse | null,
): string {
  return recordIdFromRecord(extractRecords(result)[0]);
}

function displayRecordValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not set";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function VerifiedProfileSummary({
  profile,
  action,
}: {
  profile?: ConnectedSystemsPanelProps["profile"];
  action: "find" | "create";
}) {
  const entries = [
    { label: "Name", value: cleanFieldValue(profile?.displayName) },
    { label: "Email", value: cleanFieldValue(profile?.email) },
    { label: "Phone", value: cleanFieldValue(profile?.phone) },
  ].filter((entry) => entry.value);

  return (
    <div className="space-y-3">
      <p className="text-sm leading-6 text-muted-foreground">
        {action === "find"
          ? "We’ll look for a profile using the verified details on your account."
          : "We’ll prepare a new profile using the verified details on your account."}
      </p>
      {entries.length > 0 ? (
        <dl className="overflow-hidden rounded-[var(--app-card-radius-compact)] border border-border/70 bg-muted/20">
          {entries.map((entry, index) => (
            <div
              key={entry.label}
              className={cn(
                "flex min-h-11 items-center justify-between gap-4 px-3 py-2.5 text-sm",
                index > 0 && "border-t border-border/70",
              )}
            >
              <dt className="shrink-0 text-muted-foreground">{entry.label}</dt>
              <dd className="min-w-0 truncate text-right font-medium text-foreground">
                {entry.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function cleanFieldValue(value: unknown): string {
  return String(value ?? "").trim();
}

function agentInstructionSlot(
  instruction: ConnectedSystemAgentInstruction | null | undefined,
  key: string,
): string {
  const value = instruction?.slots?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function agentInstructionFields(
  instruction: ConnectedSystemAgentInstruction | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = agentInstructionSlot(instruction, "additionalFieldsJson");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          const cleaned = cleanFieldValue(value);
          if (cleaned) out[key] = cleaned;
        }
      }
    } catch {
      // The private agent proposal is optional. Invalid proposal fields are
      // ignored and the backend remains the schema-validation authority.
    }
  }
  return out;
}

function isWorkflowStorageNotReady(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("workflow storage is not ready") ||
    normalized.includes("connected_systems_schema_not_ready") ||
    normalized.includes("connected systems workflow storage is not ready")
  );
}

function connectedSystemsUserMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : "Connected Systems request failed.";
  if (isWorkflowStorageNotReady(message)) {
    return "Record linking is temporarily unavailable.";
  }
  return message;
}

function mutationResultError(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const status =
    typeof record.status === "string" ? record.status.toLowerCase() : "";
  const resultClass =
    typeof record.resultClass === "string"
      ? record.resultClass.toLowerCase()
      : "";
  if (status !== "failed" && resultClass !== "failed") return null;
  return (
    cleanFieldValue(record.errorMessage) ||
    cleanFieldValue(record.errorCode) ||
    "CRM request failed."
  );
}

function crmValuesFromRecord(
  record: Record<string, unknown> | null | undefined,
  fields: CrmProfileField[],
): CrmFieldValues {
  const values: CrmFieldValues = { ...DEFAULT_CRM_PROFILE_VALUES };
  if (!record) return values;
  for (const field of fields) {
    values[field.key] = crmRecordFieldValue(record, field);
  }
  return values;
}

function crmRecordFieldValue(
  record: Record<string, unknown>,
  field: CrmProfileField,
): string {
  const key = crmRecordFieldKey(record, field);
  return key ? cleanFieldValue(record[key]) : "";
}

function crmRecordFieldKey(
  record: Record<string, unknown>,
  field: CrmProfileField,
): string | null {
  for (const candidate of [field.rawName, field.key]) {
    if (candidate && candidate in record) return candidate;
    const matchedKey = Object.keys(record).find(
      (key) => key.toLowerCase() === candidate?.toLowerCase(),
    );
    if (matchedKey) return matchedKey;
  }
  return null;
}

function normalizedCrmFieldToken(value?: string | null): string {
  return String(value || "")
    .trim()
    .toLocaleLowerCase();
}

function isCrmFieldLocked(field: CrmProfileField): boolean {
  return (
    field.identityField === true ||
    field.bindingKey === true ||
    field.updateable === false ||
    field.immutable === true
  );
}

function changedFieldsFromValues(
  values: CrmFieldValues,
  baseline: CrmFieldValues,
  fields: CrmProfileField[],
): Record<string, string> {
  const additionalFields: Record<string, string> = {};
  for (const field of fields) {
    if (isCrmFieldLocked(field)) continue;
    const nextValue = (values[field.key] || "").trim();
    const previousValue = (baseline[field.key] || "").trim();
    if (nextValue !== previousValue) additionalFields[field.key] = nextValue;
  }
  return additionalFields;
}

export function ConnectedSystemsPanel({
  cacheUserId,
  vaultKey,
  vaultOwnerToken,
  onRequestUnlock,
  mode = "detail",
  systemId,
  agentInstruction,
  profile,
  onSetupReadinessChange,
  setupRouteBase,
  presentation = "workspace",
  onSystemResolved,
}: ConnectedSystemsPanelProps) {
  const router = useRouter();
  const [binding, setBinding] = useState<ConnectedSystemRecordBinding | null>(
    null,
  );
  const [readResult, setReadResult] =
    useState<ConnectedSystemMcpResponse | null>(null);
  const [deleteResult, setDeleteResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [pendingIntent, setPendingIntent] =
    useState<ConnectedSystemIntent | null>(null);
  const [pendingUpdateReview, setPendingUpdateReview] =
    useState<PendingUpdateReview | null>(null);
  const updateReviewSubmittingRef = useRef(false);
  const [busy, setBusy] = useState<BusyState>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<CrmProfileField | null>(
    null,
  );
  const [editingValue, setEditingValue] = useState("");

  const [crmFieldValues, setCrmFieldValues] = useState<CrmFieldValues>(
    DEFAULT_CRM_PROFILE_VALUES,
  );
  const [crmBaselineValues, setCrmBaselineValues] = useState<CrmFieldValues>(
    DEFAULT_CRM_PROFILE_VALUES,
  );
  const [updateId, setUpdateId] = useState("");
  const [deleteId, setDeleteId] = useState("");
  const [bindingResolvedKey, setBindingResolvedKey] = useState<string | null>(
    null,
  );
  const [readResolvedKey, setReadResolvedKey] = useState<string | null>(null);
  const [cachedRecordRefreshPending, setCachedRecordRefreshPending] =
    useState(false);
  const [unboundLookupState, setUnboundLookupState] = useState<
    "idle" | "checking" | "no_match" | "remote_missing" | "failed"
  >("idle");
  const consumedAgentInstructionRef = useRef<string | null>(null);
  // Tracks which systems (by systemId) have an active record binding, across
  // ALL available systems, not just the one currently open in detail view.
  // The step is complete once the person has linked any one of them.
  const [boundSystemIds, setBoundSystemIds] = useState<Set<string>>(new Set());

  const cacheScope = cacheUserId?.trim() || "pending-user";
  const systemsCacheKey =
    ConnectedSystemsResourceService.registryCacheKey(cacheScope);
  const loadSystems = useCallback(async () => {
    let authToken = vaultOwnerToken || "";
    if (!authToken) {
      const { AuthService } = await import("@/lib/services/auth-service");
      authToken = (await AuthService.getIdToken()) || "";
    }
    if (!authToken) throw new Error("Sign in to review connected systems.");
    return ConnectedSystemsResourceService.loadRegistry({
      userId: cacheScope,
      authToken,
    });
  }, [cacheScope, vaultOwnerToken]);
  const systemsResource = useStaleResource<ConnectedSystemsRegistryResponse>({
    cacheKey: systemsCacheKey,
    enabled: Boolean(cacheUserId),
    load: loadSystems,
    resourceLabel: "connected-systems-registry",
  });
  const systems = useMemo(
    () => systemsResource.data?.systems || [],
    [systemsResource.data],
  );

  const selectedSystem =
    systems.find((system) => system.systemId === systemId) ||
    (!systemId ? systems[0] || null : null);
  const crmZkEnabled = selectedSystem?.crmZk?.enabled === true;
  const crmZkReadReady = selectedSystem?.crmZk?.readReady === true;
  const crmZkUpdateReady = selectedSystem?.crmZk?.updateReady === true;
  useEffect(() => {
    if (selectedSystem) onSystemResolved?.(selectedSystem);
  }, [onSystemResolved, selectedSystem]);
  const selectedSystemKey = selectedSystem
    ? `${selectedSystem.systemId}:${selectedSystem.objectTypeDefault || "Contact"}`
    : "";
  const selectedConfigurationRevision =
    selectedSystem?.configurationRevision || 1;
  const schemaCacheKey = ConnectedSystemsResourceService.schemaCacheKey({
    userId: cacheScope,
    systemId: selectedSystem?.systemId || "none",
    objectType: selectedSystem?.objectTypeDefault || "Contact",
    configurationRevision: selectedConfigurationRevision,
  });
  const loadSelectedSchema = useCallback(
    async (options?: { force?: boolean }) => {
      if (!vaultOwnerToken || !selectedSystem) {
        throw new Error("Unlock your vault to review CRM fields.");
      }
      return ConnectedSystemsResourceService.loadSchema({
        userId: cacheScope,
        vaultOwnerToken,
        systemId: selectedSystem.systemId,
        objectType: selectedSystem.objectTypeDefault || "Contact",
        configurationRevision: selectedConfigurationRevision,
        forceRefresh: options?.force,
      });
    },
    [
      cacheScope,
      selectedConfigurationRevision,
      selectedSystem,
      vaultOwnerToken,
    ],
  );
  const schemaResource = useStaleResource<ConnectedSystemSchemaResponse>({
    cacheKey: schemaCacheKey,
    enabled: Boolean(
      cacheUserId && vaultOwnerToken && selectedSystem && mode === "detail",
    ),
    load: loadSelectedSchema,
    resourceLabel: "connected-system-schema",
  });
  const schema = schemaResource.data;
  const effectiveError = error || systemsResource.error || schemaResource.error;
  const canUseBackend = Boolean(vaultOwnerToken);
  const isSetupPresentation = presentation === "setup";
  const schemaReady = schema?.schemaStatus === "ready";
  const schemaMatchesSelectedConfiguration = Boolean(
    schema &&
      selectedSystem &&
      schema.systemId === selectedSystem.systemId &&
      schema.objectType === (selectedSystem.objectTypeDefault || "Contact") &&
      schema.configurationRevision === selectedConfigurationRevision,
  );
  const supportsAction = (
    action: "schema" | "read" | "create" | "update" | "delete",
  ) =>
    action === "schema"
      ? selectedSystem?.supportedActions?.schema === true
      : schemaReady && schema?.effectiveActions?.[action] === true;
  const customerName = selectedSystem?.customerDisplayName || "Connected CRM";
  const primaryObjectLabel =
    schema?.objectMetadata?.label ||
    schema?.objectType ||
    selectedSystem?.capabilities?.primaryObject ||
    selectedSystem?.objectTypeDefault ||
    "record";
  const crmRecords = useMemo(() => extractRecords(readResult), [readResult]);
  const activeBinding = binding?.status === "active" ? binding : null;
  // Complete when ANY system has an active binding: the currently open one
  // (instant, from local state) OR any other system already linked
  // (from the cross-system aggregate below).
  const anySystemBound = Boolean(activeBinding) || boundSystemIds.size > 0;
  useEffect(() => {
    onSetupReadinessChange?.(anySystemBound);
  }, [anySystemBound, onSetupReadinessChange]);
  const schemaDrivenProfileFields = useMemo(() => {
    const liveFields = Array.isArray(schema?.fields) ? schema.fields : [];
    return liveFields
      .map((field) => crmFieldFromSchemaDescriptor(field))
      .filter((field): field is CrmProfileField => Boolean(field));
  }, [schema?.fields]);
  const bindingFieldTokens = useMemo(
    () =>
      new Set(
        Object.values(schema?.profileFieldMappings || {})
          .map((value) => normalizedCrmFieldToken(String(value || "")))
          .filter(Boolean),
      ),
    [schema?.profileFieldMappings],
  );
  const visibleProfileFields = useMemo(() => {
    if (schemaDrivenProfileFields.length > 0) {
      return schemaDrivenProfileFields.map((field) => ({
        ...field,
        bindingKey:
          field.identityField === true ||
          [field.rawName, field.key].some((value) =>
            bindingFieldTokens.has(normalizedCrmFieldToken(value)),
          ),
      }));
    }
    return [];
  }, [bindingFieldTokens, schemaDrivenProfileFields]);
  const displayedProfileFields = useMemo(() => {
    // The CRM table is the one complete field inventory. Preserve schema
    // ordering inside each partition, while leading with the fields that
    // establish the verified lookup or are required by the CRM.
    const basicFields: CrmProfileField[] = [];
    const remainingFields: CrmProfileField[] = [];
    for (const field of visibleProfileFields) {
      if (field.bindingKey || field.identityField || field.required) {
        basicFields.push(field);
      } else {
        remainingFields.push(field);
      }
    }
    return [...basicFields, ...remainingFields];
  }, [visibleProfileFields]);
  const changedProfileFields = useMemo(
    () =>
      changedFieldsFromValues(
        crmFieldValues,
        crmBaselineValues,
        visibleProfileFields,
      ),
    [crmBaselineValues, crmFieldValues, visibleProfileFields],
  );
  const boundRecordId = cleanFieldValue(activeBinding?.recordId);
  const recordIsMissing = unboundLookupState === "remote_missing";
  const currentRecordId = useMemo(
    () => boundRecordId || updateId.trim(),
    [boundRecordId, updateId],
  );
  const hasBoundRecord = Boolean(currentRecordId) && !recordIsMissing;
  const currentReadRecord = useMemo(
    () => selectRecordForId(readResult, currentRecordId),
    [currentRecordId, readResult],
  );
  const primaryCrmRecord = currentRecordId
    ? currentReadRecord
    : crmRecords[0] || null;
  // Schema metadata and the linked record can hydrate from different cache
  // tiers. Reconcile the editable working copy whenever both are available so
  // a record that arrived first does not leave later-discovered fields blank.
  useEffect(() => {
    if (!primaryCrmRecord || visibleProfileFields.length === 0) return;
    const values = crmValuesFromRecord(primaryCrmRecord, visibleProfileFields);
    setCrmFieldValues(values);
    setCrmBaselineValues(values);
  }, [primaryCrmRecord, visibleProfileFields]);
  const readResultHasCurrentRecord = Boolean(currentReadRecord);
  const crmRecordReadKey = useMemo(
    () =>
      selectedSystem && currentRecordId
        ? [
            selectedSystem.systemId,
            selectedSystem.objectTypeDefault || "Contact",
            currentRecordId,
          ].join(":")
        : "",
    [currentRecordId, selectedSystem],
  );
  const bindingResolved = Boolean(
    selectedSystemKey && bindingResolvedKey === selectedSystemKey,
  );
  const boundRecordReadResolved =
    !hasBoundRecord ||
    readResultHasCurrentRecord ||
    Boolean(crmRecordReadKey && readResolvedKey === crmRecordReadKey);
  const isBoundRecordHydrating =
    mode === "detail" &&
    canUseBackend &&
    !effectiveError &&
    hasBoundRecord &&
    schemaReady &&
    supportsAction("read") &&
    !boundRecordReadResolved;
  const isSchemaPreparationPending =
    mode === "detail" &&
    canUseBackend &&
    !effectiveError &&
    Boolean(selectedSystem) &&
    (!schemaMatchesSelectedConfiguration ||
      schemaResource.loading ||
      schemaResource.refreshing);
  const isRecordStateLoading =
    mode === "detail" &&
    canUseBackend &&
    !effectiveError &&
    (!selectedSystem ||
      !bindingResolved ||
      isSchemaPreparationPending ||
      isBoundRecordHydrating);
  const canShowUnboundRecordActions =
    !hasBoundRecord &&
    !isRecordStateLoading &&
    schemaReady &&
    visibleProfileFields.length > 0 &&
    (supportsAction("read") || supportsAction("create"));
  const hasCompletedUnboundLookup =
    unboundLookupState === "no_match" ||
    unboundLookupState === "remote_missing";
  const canCreateUnboundRecord = supportsAction("create");
  const shouldOfferCreate =
    canCreateUnboundRecord &&
    (!supportsAction("read") || hasCompletedUnboundLookup);
  const canShowBoundRecordActions =
    !isSetupPresentation &&
    hasBoundRecord &&
    !isRecordStateLoading &&
    schemaReady &&
    supportsAction("update");
  const isFieldTableRefreshing =
    busy === "schema" ||
    busy === "read" ||
    schemaResource.loading ||
    schemaResource.refreshing ||
    cachedRecordRefreshPending;
  const showCatalogueOnly = Boolean(
    schema &&
    hasBoundRecord &&
    (!schemaReady || (!isSetupPresentation && !canShowBoundRecordActions)),
  );

  useEffect(() => {
    if (mode !== "detail") return;
    const cachedRecordSnapshot =
      cacheUserId && selectedSystem
        ? ConnectedSystemsResourceService.getLiveRecordSnapshot(
            cacheUserId,
            selectedSystem.systemId,
          )
        : null;
    setReadResolvedKey(null);
    setReadResult(cachedRecordSnapshot?.record ?? null);
    setCachedRecordRefreshPending(Boolean(cachedRecordSnapshot));
    setUnboundLookupState("idle");
  }, [cacheUserId, mode, selectedSystem, selectedSystemKey]);

  useEffect(() => {
    if (vaultOwnerToken) return;
    setBinding(null);
    setReadResult(null);
    setCachedRecordRefreshPending(false);
    setPendingIntent(null);
    setEditingField(null);
    setEditingValue("");
    setCrmFieldValues({});
    setCrmBaselineValues({});
    setUpdateId("");
    setDeleteId("");
    setBoundSystemIds(new Set());
  }, [vaultOwnerToken]);

  const refreshSystems = useCallback(async () => {
    setBusy("systems");
    setError(null);
    try {
      await systemsResource.refresh({ force: true });
    } finally {
      setBusy(null);
    }
  }, [systemsResource]);

  // Resolve every row in one vault-owner request. Binding IDs and record values
  // remain server-side and are never placed in device storage.
  useEffect(() => {
    if (!vaultOwnerToken || systems.length === 0) return;
    let cancelled = false;
    const cached =
      ConnectedSystemsResourceService.getBindingStatuses(cacheScope);
    if (cached.length > 0) {
      setBoundSystemIds(
        new Set(
          cached
            .filter((result) => result.status === "active")
            .map((result) => result.systemId),
        ),
      );
    }
    void (async () => {
      const results = await ConnectedSystemsResourceService.warmBindingStatuses(
        {
          userId: cacheScope,
          vaultOwnerToken,
        },
      ).catch(() => []);
      if (cancelled) return;
      setBoundSystemIds(
        new Set(
          results
            .filter((result) => result.status === "active")
            .map((result) => result.systemId),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheScope, systems, vaultOwnerToken]);

  const refreshBinding = useCallback(async () => {
    if (!vaultOwnerToken || !selectedSystem || mode !== "detail") return null;
    const nextBindingKey = selectedSystemKey;
    setBusy("binding");
    setError(null);
    try {
      const response = await ConnectedSystemsService.getRecordBinding({
        vaultOwnerToken,
        systemId: selectedSystem.systemId,
        objectType: selectedSystem.objectTypeDefault || "Contact",
      });
      const nextBinding =
        response.binding?.status === "active" ? response.binding : null;
      setBinding(nextBinding || null);
      if (nextBinding?.recordId) {
        setUpdateId(nextBinding.recordId);
        setDeleteId(nextBinding.recordId);
      } else {
        setUpdateId("");
        setDeleteId("");
      }
      return nextBinding || null;
    } catch (err) {
      if (err instanceof ConnectedSystemsRequestError) {
        if (err.code === "CONNECTED_SYSTEM_PHONE_VERIFICATION_REQUIRED") {
          router.push(ROUTES.PROFILE_ACCOUNT_PHONE);
        } else if (
          err.code === "CONNECTED_SYSTEM_EMAIL_VERIFICATION_REQUIRED"
        ) {
          router.push(ROUTES.PROFILE_ACCOUNT);
        }
      }
      const message = connectedSystemsUserMessage(err);
      if (
        isWorkflowStorageNotReady(err instanceof Error ? err.message : message)
      ) {
        setBinding(null);
        setUpdateId("");
        setDeleteId("");
        return null;
      }
      setError(message);
      return null;
    } finally {
      setBindingResolvedKey(nextBindingKey);
      setBusy(null);
    }
  }, [mode, router, selectedSystem, selectedSystemKey, vaultOwnerToken]);

  useEffect(() => {
    if (!vaultOwnerToken || !selectedSystem || mode !== "detail") return;
    void refreshBinding();
  }, [mode, refreshBinding, selectedSystem, vaultOwnerToken]);

  const resetWorkingCopy = () => {
    setCrmFieldValues({ ...crmBaselineValues });
    setDeleteResult(null);
  };

  async function runAction<T>(
    state: BusyState,
    action: () => Promise<T>,
    options: { showErrorToast?: boolean; background?: boolean } = {},
  ): Promise<T | null> {
    if (!vaultOwnerToken) {
      onRequestUnlock?.();
      return null;
    }
    if (!options.background) {
      setBusy(state);
      setError(null);
    }
    try {
      return await action();
    } catch (err) {
      if (err instanceof ConnectedSystemsRequestError) {
        if (err.code === "CONNECTED_SYSTEM_PHONE_VERIFICATION_REQUIRED") {
          router.push(ROUTES.PROFILE_ACCOUNT_PHONE);
        } else if (
          err.code === "CONNECTED_SYSTEM_EMAIL_VERIFICATION_REQUIRED"
        ) {
          router.push(ROUTES.PROFILE_ACCOUNT);
        }
      }
      const message = connectedSystemsUserMessage(err);
      if (!options.background) setError(message);
      if (options.showErrorToast !== false) {
        toast.error(message);
      }
      return null;
    } finally {
      if (!options.background) setBusy(null);
    }
  }

  async function runMutation<T>(
    state: Exclude<BusyState, "systems" | "schema" | "binding" | "read" | null>,
    messages: {
      loading: string;
      success: string | ((value: T) => string);
      error: string;
    },
    action: () => Promise<T>,
  ): Promise<T | null> {
    if (!vaultOwnerToken) {
      onRequestUnlock?.();
      return null;
    }
    setBusy(state);
    setError(null);
    const promise = action()
      .then((value) => {
        const resultError = mutationResultError(value);
        if (resultError) {
          throw new Error(resultError);
        }
        return value;
      })
      .catch((err) => {
        if (err instanceof ConnectedSystemsRequestError) {
          if (err.code === "CONNECTED_SYSTEM_PHONE_VERIFICATION_REQUIRED") {
            router.push(ROUTES.PROFILE_ACCOUNT_PHONE);
          } else if (
            err.code === "CONNECTED_SYSTEM_EMAIL_VERIFICATION_REQUIRED"
          ) {
            router.push(ROUTES.PROFILE_ACCOUNT);
          }
        }
        throw new Error(connectedSystemsUserMessage(err));
      });
    toast.promise(promise, {
      ...messages,
      error: (err) => (err instanceof Error ? err.message : messages.error),
    });
    try {
      return await promise;
    } catch (err) {
      const message = err instanceof Error ? err.message : messages.error;
      setError(message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  const loadSchema = async (options: { silent?: boolean } = {}) => {
    setBusy("schema");
    let result: ConnectedSystemSchemaResponse | null = null;
    try {
      result = await schemaResource.refresh({ force: true });
    } finally {
      setBusy(null);
    }
    if (result) {
      if (!options.silent) {
        toast.success("CRM schema loaded.");
      }
    }
  };

  const applyReadResult = (result: ConnectedSystemMcpResponse) => {
    setReadResult(result);
    setCachedRecordRefreshPending(false);
    if (
      cacheUserId &&
      selectedSystem &&
      result.bindingStatus !== "remote_record_missing"
    ) {
      ConnectedSystemsResourceService.rememberLiveRecord(
        cacheUserId,
        selectedSystem.systemId,
        result,
      );
    }
    const nextBinding =
      result.binding?.status === "active" ? result.binding : null;
    if (result.bindingStatus === "remote_record_missing") {
      setCrmFieldValues({});
      setCrmBaselineValues({});
      setUnboundLookupState("remote_missing");
      if (cacheUserId && selectedSystem) {
        ConnectedSystemsResourceService.forgetLiveRecord(
          cacheUserId,
          selectedSystem.systemId,
        );
      }
    }
    if (nextBinding) {
      setBinding(nextBinding);
      if (nextBinding.recordId) {
        setUpdateId(nextBinding.recordId);
        setDeleteId(nextBinding.recordId);
      }
    }
    const record = selectRecordForId(
      result,
      nextBinding?.recordId || currentRecordId || result.recordId,
    );
    if (record) {
      const values = crmValuesFromRecord(record, visibleProfileFields);
      setCrmFieldValues(values);
      setCrmBaselineValues(values);
      const resolvedRecordId = cleanFieldValue(
        nextBinding?.recordId ||
          currentRecordId ||
          result.recordId ||
          extractFirstRecordId(result),
      );
      if (selectedSystem && resolvedRecordId) {
        setReadResolvedKey(
          [
            selectedSystem.systemId,
            selectedSystem.objectTypeDefault || "Contact",
            resolvedRecordId,
          ].join(":"),
        );
      }
    }
    const recordId = result.recordId || extractFirstRecordId(result);
    if (recordId && (nextBinding || currentRecordId)) {
      setUpdateId(recordId);
      setDeleteId(recordId);
    }
  };

  const readBoundCrmZkRecord = async (returnFields: string[]) => {
    if (!selectedSystem || !cacheUserId || !vaultKey || !vaultOwnerToken) {
      throw new Error("Unlock your vault to read this CRM record privately.");
    }
    if (!crmZkReadReady) {
      throw new Error("This CRM is not ready for its required private read protocol.");
    }
    const [configuration, context] = await Promise.all([
      ConnectedSystemsService.getCrmZkConfiguration({
        vaultOwnerToken,
        systemId: selectedSystem.systemId,
      }),
      ConnectedSystemsService.prepareCrmZkContext({
        vaultOwnerToken,
        systemId: selectedSystem.systemId,
        operation: "read",
        objectType: selectedSystem.objectTypeDefault,
        fieldNames: returnFields,
      }),
    ]);
    const ownerSigningKey = await ensureCrmZkOwnerSigningKey({
      userId: cacheUserId,
      vaultKey,
      vaultOwnerToken,
      systemId: selectedSystem.systemId,
    });
    const envelope = await createCrmZkEnvelope({
      context,
      configuration,
      ownerSigningKey,
      payload: {},
    });
    const response = await ConnectedSystemsService.readCrmZkRecord({
      vaultOwnerToken,
      systemId: selectedSystem.systemId,
      encryptedFields: envelope,
    });
    const decrypted = await decryptCrmZkPartnerResponse({
      context,
      configuration,
      response: response.encryptedFields as CrmZkPartnerResponseEnvelope,
    });
    const rawFields =
      decrypted.fields && typeof decrypted.fields === "object" && !Array.isArray(decrypted.fields)
        ? (decrypted.fields as Record<string, unknown>)
        : decrypted.record && typeof decrypted.record === "object" && !Array.isArray(decrypted.record)
          ? (decrypted.record as Record<string, unknown>)
          : {};
    const allowed = new Set(context.fieldNames);
    const fields = Object.fromEntries(
      Object.entries(rawFields).filter(([name, value]) =>
        allowed.has(name) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)
      )
    ) as ConnectedSystemMcpResponse["records"] extends Array<infer RecordType>
      ? RecordType extends { fields: infer FieldType } ? FieldType : never
      : never;
    return {
      systemId: selectedSystem.systemId,
      target: selectedSystem.target,
      objectType: selectedSystem.objectTypeDefault,
      recordId: currentRecordId || null,
      resultClass: "succeeded",
      records: [{ recordId: currentRecordId || null, fields }],
      bindingStatus: "active",
      binding: binding || undefined,
    } satisfies ConnectedSystemMcpResponse;
  };

  const readRecord = async (
    options: {
      silent?: boolean;
      bindSearch?: boolean;
      background?: boolean;
    } = {},
  ) => {
    const result = await runAction(
      options.bindSearch ? "lookup" : "read",
      async () => {
        const returnFields = visibleProfileFields
          .filter((field) => field.readable !== false)
          .map((field) => field.rawName || field.key);
        const completedReadKey =
          !options.bindSearch && selectedSystem && currentRecordId
            ? [
                selectedSystem.systemId,
                selectedSystem.objectTypeDefault || "Contact",
                currentRecordId,
              ].join(":")
            : "";
        const payload = {
          systemId: selectedSystem?.systemId,
          objectType: selectedSystem?.objectTypeDefault,
          returnFields,
        };
        const nextResult = options.bindSearch
          ? await ConnectedSystemsService.searchRecord(
              vaultOwnerToken || "",
              payload,
            )
          : crmZkEnabled
            ? await readBoundCrmZkRecord(returnFields)
            : await ConnectedSystemsService.readRecord(
                vaultOwnerToken || "",
                payload,
              );
        if (completedReadKey) setReadResolvedKey(completedReadKey);
        return nextResult;
      },
      { showErrorToast: !options.silent, background: options.background },
    );
    if (result) {
      applyReadResult(result);
      if (options.bindSearch && result.binding?.status !== "active") {
        setBinding(null);
        setUpdateId("");
        setDeleteId("");
      }
      if (!options.silent) {
        const recordLoaded = extractRecords(result).length > 0;
        if (recordLoaded) {
          toast.success(`${customerName} record refreshed.`);
        } else if (result.bindingStatus === "remote_record_missing") {
          toast.info(
            "The saved CRM link was removed because the record no longer exists.",
          );
        } else if (currentRecordId) {
          toast.info(
            `${customerName} record is linked, but the CRM did not return field values.`,
          );
        } else {
          toast.info(`No matching ${customerName} record found.`);
        }
      }
    }
    if (options.background) setCachedRecordRefreshPending(false);
    return result || null;
  };

  useEffect(() => {
    if (
      !agentInstruction ||
      !vaultOwnerToken ||
      !selectedSystem ||
      mode !== "detail"
    ) {
      return;
    }
    if (!bindingResolved) return;
    if (!agentInstruction.actionId.startsWith("connected_system.crm.")) return;
    if (!schemaReady || visibleProfileFields.length === 0) return;

    const instructionKey = JSON.stringify(agentInstruction);
    if (consumedAgentInstructionRef.current === instructionKey) return;
    consumedAgentInstructionRef.current = instructionKey;

    const proposedFields = agentInstructionFields(agentInstruction);
    const declaredFields = new Map<string, CrmProfileField>();
    for (const field of visibleProfileFields) {
      declaredFields.set(field.key.toLowerCase(), field);
      declaredFields.set((field.rawName || field.key).toLowerCase(), field);
    }
    const stagedFields = Object.entries(proposedFields).flatMap(
      ([candidate, value]) => {
        const field = declaredFields.get(candidate.toLowerCase());
        return field ? [[field.key, value] as const] : [];
      },
    );
    if (stagedFields.length === 0) return;
    setCrmFieldValues((current) => {
      const next = { ...current };
      for (const [fieldKey, value] of stagedFields) next[fieldKey] = value;
      return next;
    });
    toast.info(
      "CRM proposal staged. Review it before linking or updating the record.",
    );
  }, [
    agentInstruction,
    bindingResolved,
    mode,
    schemaReady,
    selectedSystem,
    visibleProfileFields,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (
      !vaultOwnerToken ||
      mode !== "detail" ||
      !activeBinding ||
      !currentRecordId ||
      !schemaReady ||
      !supportsAction("read") ||
      (boundRecordReadResolved && !cachedRecordRefreshPending)
    ) {
      return;
    }
    void readRecord({
      silent: true,
      background: cachedRecordRefreshPending,
    });
    // readRecord is intentionally keyed by the active binding and lookup state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeBinding,
    boundRecordReadResolved,
    cachedRecordRefreshPending,
    currentRecordId,
    mode,
    vaultOwnerToken,
    schemaReady,
  ]);

  const updateCrmFieldValue = (field: CrmProfileField, value: string) => {
    if (!schemaReady || isCrmFieldLocked(field)) return;
    setCrmFieldValues((current) => ({ ...current, [field.key]: value }));
  };

  const createRecordFromSchema = async () => {
    const result = await runMutation(
      "create",
      {
        loading: "Preparing CRM record review...",
        success: "CRM record is ready for review.",
        error: "CRM record could not be prepared.",
      },
      () =>
        ConnectedSystemsService.createRecordIntent(vaultOwnerToken || "", {
          systemId: selectedSystem?.systemId,
          objectType: selectedSystem?.objectTypeDefault,
        }),
    );
    if (result) {
      setPendingIntent(result);
    }
    return result;
  };

  const recoverMissingRecord = async () => {
    if (!selectedSystem || unboundLookupState !== "remote_missing") return;
    const disconnected = await runAction("binding", () =>
      ConnectedSystemsService.disconnectRecordBinding({
        vaultOwnerToken: vaultOwnerToken || "",
        systemId: selectedSystem.systemId,
        objectType: selectedSystem.objectTypeDefault,
      }),
    );
    if (!disconnected) return;
    setBinding(null);
    setReadResult(null);
    setUpdateId("");
    setDeleteId("");
    setUnboundLookupState("no_match");
    setBoundSystemIds((current) => {
      const next = new Set(current);
      next.delete(selectedSystem.systemId);
      return next;
    });
    if (cacheUserId) {
      ConnectedSystemsResourceService.forgetLiveRecord(
        cacheUserId,
        selectedSystem.systemId,
      );
      ConnectedSystemsResourceService.rememberBindingStatus(cacheUserId, {
        systemId: selectedSystem.systemId,
        objectType: selectedSystem.objectTypeDefault || "Contact",
        status: "unbound",
      });
    }
    await createRecordFromSchema();
  };

  const findExistingProfile = async () => {
    if (!supportsAction("read")) return;
    setUnboundLookupState("checking");
    const found = await readRecord({ silent: true, bindSearch: true });
    if (found?.binding?.status === "active") {
      setUnboundLookupState("idle");
      setBoundSystemIds((current) => new Set(current).add(found.systemId));
      toast.success(
        `Found your existing ${customerName} profile and linked it.`,
      );
      if (isSetupPresentation && setupRouteBase) router.push(setupRouteBase);
      return;
    }
    if (!found) {
      setUnboundLookupState("failed");
      return;
    }
    setUnboundLookupState("no_match");
    toast.info(`No matching ${customerName} profile was found.`);
  };

  const updateRecordFromSchema = () => {
    const recordFields = changedProfileFields;
    if (Object.keys(recordFields).length === 0) {
      toast.error("Change at least one CRM field before updating the record.");
      return;
    }
    // Open the review from the already staged local snapshot. There is no
    // reason to make a remote request before the person has reviewed it.
    const fieldsByKey = new Map(
      visibleProfileFields.map((field) => [field.key, field]),
    );
    setPendingUpdateReview({
      recordFields,
      fields: Object.entries(recordFields).map(([key, nextValue]) => ({
        key,
        label: fieldsByKey.get(key)?.label || key,
        previousValue: crmBaselineValues[key] || "",
        nextValue,
      })),
    });
  };

  const approveUpdateReview = async () => {
    if (!pendingUpdateReview) return;
    const review = pendingUpdateReview;
    updateReviewSubmittingRef.current = true;
    let preparedIntent: ConnectedSystemIntent | null = null;
    const result = await runMutation(
      "update",
      {
        loading: "Updating CRM record…",
        success: `${customerName} record updated.`,
        error: `${customerName} record could not be updated.`,
      },
      async () => {
        if (crmZkEnabled) {
          if (!selectedSystem || !cacheUserId || !vaultKey || !vaultOwnerToken) {
            throw new Error("Unlock your vault to approve this private CRM update.");
          }
          if (!crmZkUpdateReady) {
            throw new Error("This CRM is not ready for its required private update protocol.");
          }
          const [configuration, context] = await Promise.all([
            ConnectedSystemsService.getCrmZkConfiguration({
              vaultOwnerToken,
              systemId: selectedSystem.systemId,
            }),
            ConnectedSystemsService.prepareCrmZkContext({
              vaultOwnerToken,
              systemId: selectedSystem.systemId,
              operation: "update",
              objectType: selectedSystem.objectTypeDefault,
              fieldNames: Object.keys(review.recordFields),
            }),
          ]);
          const ownerSigningKey = await ensureCrmZkOwnerSigningKey({
            userId: cacheUserId,
            vaultKey,
            vaultOwnerToken,
            systemId: selectedSystem.systemId,
          });
          const envelope = await createCrmZkEnvelope({
            context,
            configuration,
            ownerSigningKey,
            payload: review.recordFields,
          });
          preparedIntent = await ConnectedSystemsService.createCrmZkUpdateIntent({
            vaultOwnerToken,
            systemId: selectedSystem.systemId,
            encryptedFields: envelope,
          });
          const challenge = await ConnectedSystemsService.createCrmZkApprovalChallenge({
            vaultOwnerToken,
            systemId: selectedSystem.systemId,
            intentId: preparedIntent.intentId,
          });
          const approvalProof = await signCrmZkApproval({
            ownerSigningKey,
            intentId: challenge.intentId,
            envelopeDigest: challenge.envelopeDigest,
            challengeId: challenge.challengeId,
            nonce: challenge.nonce,
            expiresAtMs: challenge.expiresAtMs,
          });
          const approved = await ConnectedSystemsService.approveCrmZkIntent({
            vaultOwnerToken,
            systemId: selectedSystem.systemId,
            intentId: preparedIntent.intentId,
            approvalProof,
          });
          if (approved.encryptedResponse) {
            // Verify/decrypt the partner readback in runtime memory only. A
            // fresh bound read remains the recovery path if this session dies.
            await decryptCrmZkPartnerResponse({
              context,
              configuration,
              response: approved.encryptedResponse as CrmZkPartnerResponseEnvelope,
            });
          }
          return approved;
        }
        preparedIntent = await ConnectedSystemsService.updateRecordIntent(
          vaultOwnerToken || "",
          {
            systemId: selectedSystem?.systemId,
            objectType: selectedSystem?.objectTypeDefault,
            additionalFields: {},
            recordFields: review.recordFields,
          },
        );
        return ConnectedSystemsService.approveIntent({
          vaultOwnerToken: vaultOwnerToken || "",
          systemId: preparedIntent.systemId,
          intentId: preparedIntent.intentId,
        });
      },
    );
    updateReviewSubmittingRef.current = false;
    if (!result) {
      // A prepared intent remains safely pending server-side. Reuse it rather
      // than submitting a second update if approval has to be retried.
      if (preparedIntent) {
        setPendingUpdateReview(null);
        setPendingIntent(preparedIntent);
      }
      return;
    }
    setPendingUpdateReview(null);
    setCrmBaselineValues((current) => ({
      ...current,
      ...review.recordFields,
    }));
    void readRecord({ silent: true });
  };

  const deleteRecord = async () => {
    const result = await runMutation(
      "delete",
      {
        loading: "Preparing delete review...",
        success: "Delete is ready for review.",
        error: "Delete could not be prepared.",
      },
      () =>
        ConnectedSystemsService.createDeleteIntent(vaultOwnerToken || "", {
          systemId: selectedSystem?.systemId,
          objectType: selectedSystem?.objectTypeDefault || "Contact",
        }),
    );
    if (result) {
      setPendingIntent(result);
    }
  };

  const approvePendingIntent = async () => {
    if (!pendingIntent) return;
    const intent = pendingIntent;
    const result = await runMutation(
      intent.action === "delete"
        ? "delete"
        : intent.action === "create"
          ? "create"
          : "update",
      {
        loading: `Applying ${intent.action}…`,
        success: `${customerName} record ${intent.action} completed.`,
        error: `${customerName} record ${intent.action} failed.`,
      },
      () =>
        ConnectedSystemsService.approveIntent({
          vaultOwnerToken: vaultOwnerToken || "",
          systemId: intent.systemId,
          intentId: intent.intentId,
        }),
    );
    if (!result) return;
    setPendingIntent(null);
    if (result.action === "delete") {
      setDeleteResult(result);
      setBinding(null);
      setReadResult(null);
      setUpdateId("");
      setDeleteId("");
      return;
    }
    const recordId = cleanFieldValue(
      result.binding?.recordId || result.recordId,
    );
    if (recordId) {
      const nextBinding: ConnectedSystemRecordBinding =
        result.binding?.status === "active"
          ? result.binding
          : {
              bindingId: null,
              systemId: result.systemId,
              target: result.target,
              objectType: result.objectType || intent.objectType,
              recordId,
              status: "active",
              createdIntentId: intent.intentId,
              lastIntentId: intent.intentId,
              createdAt: result.createdAt,
              updatedAt: result.updatedAt,
            };
      setBinding(nextBinding);
      setUpdateId(recordId);
      setDeleteId(recordId);
    } else {
      await refreshBinding();
    }
    setCrmBaselineValues((current) => ({ ...current, ...crmFieldValues }));
    if (isSetupPresentation && setupRouteBase && result.action === "create") {
      setBoundSystemIds((current) => new Set(current).add(result.systemId));
      router.push(setupRouteBase);
      return;
    }
    void readRecord({ silent: true });
  };

  const rejectPendingIntent = async () => {
    if (!pendingIntent) return;
    await runAction("update", async () => {
      await ConnectedSystemsService.rejectIntent({
        vaultOwnerToken: vaultOwnerToken || "",
        systemId: pendingIntent.systemId,
        intentId: pendingIntent.intentId,
      });
      setPendingIntent(null);
    });
  };

  const crmFieldRows: CrmFieldTableRow[] = displayedProfileFields.map(
    (field) => {
      const currentValue = !hasBoundRecord
        ? "No linked record"
        : !readResult
          ? supportsAction("read")
            ? "Loading record"
            : "Record values unavailable"
          : !primaryCrmRecord
            ? "No record returned"
            : !crmRecordFieldKey(primaryCrmRecord, field)
              ? "Not returned by CRM"
              : displayRecordValue(crmFieldValues[field.key]);
      return {
        key: field.key,
        label: field.label,
        currentValue,
        field,
      };
    },
  );

  const crmFieldColumns: ColumnDef<CrmFieldTableRow>[] = [
    {
      accessorKey: "label",
      header: "Field",
      size: 156,
      cell: ({ row }) => (
        <span
          className="block truncate font-medium text-foreground"
          title={row.original.label}
        >
          {row.original.label}
        </span>
      ),
    },
    {
      accessorKey: "currentValue",
      header: "Current value",
      cell: ({ row }) => (
        <span
          className="block truncate text-foreground"
          title={row.original.currentValue}
        >
          {row.original.currentValue}
        </span>
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Edit</span>,
      size: 52,
      cell: ({ row }) => {
        const field = row.original.field;
        if (
          !hasBoundRecord ||
          !schemaReady ||
          !supportsAction("update") ||
          isCrmFieldLocked(field)
        ) {
          return (
            <span
              className="flex w-full items-center justify-end"
              title={
                field.bindingKey || field.identityField
                  ? "Primary CRM lookup field"
                  : "This CRM field is read-only"
              }
            >
              <span className="flex size-8 items-center justify-center rounded-full bg-muted/55 text-muted-foreground">
                <Icon icon={LockKeyhole} size="sm" />
              </span>
              <span className="sr-only">
                {field.bindingKey || field.identityField
                  ? "Primary CRM lookup field is locked"
                  : "CRM field is read-only"}
              </span>
            </span>
          );
        }
        return (
          <span className="flex w-full items-center justify-end">
            <Button
              type="button"
              variant="none"
              effect="fade"
              size="icon-sm"
              disabled={busy !== null}
              aria-label={`Edit ${field.label}`}
              onClick={() => {
                setEditingField(field);
                setEditingValue(cleanFieldValue(crmFieldValues[field.key]));
              }}
            >
              <Icon icon={Pencil} size="sm" />
            </Button>
          </span>
        );
      },
    },
  ];

  const renderCrmFieldTable = (configurationMessage?: string | null) => (
    <div className="space-y-2">
      <DataTable
        columns={crmFieldColumns}
        data={crmFieldRows}
        globalSearchKeys={["label", "currentValue"]}
        searchPlaceholder="Search fields"
        initialPageSize={6}
        pageSizeOptions={[6, 10, 20]}
        density="compact"
        stickyHeader
        tableContainerClassName="max-w-full"
        tableClassName="w-full table-fixed"
      />
      {configurationMessage ? (
        <SurfaceInset className="px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          {configurationMessage}
        </SurfaceInset>
      ) : null}
    </div>
  );

  const renderPendingUpdatePreview = () =>
    Object.keys(changedProfileFields).length > 0 ? (
      <div className="rounded-lg bg-muted/40 p-3">
        <div className="mb-2 text-[12px] font-medium text-foreground">
          Pending update preview
        </div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(changedProfileFields).map(([field, value]) => (
            <Badge key={field} variant="secondary">
              {field}: {value || "Clear value"}
            </Badge>
          ))}
        </div>
      </div>
    ) : null;

  const deleteRecordControl =
    !isSetupPresentation &&
    hasBoundRecord &&
    !isRecordStateLoading &&
    supportsAction("delete") ? (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="destructive"
            effect="fade"
            size="icon-sm"
            disabled={busy !== null || !(deleteId || currentRecordId)}
            aria-label={`Delete ${primaryObjectLabel.toLowerCase()} from ${customerName}`}
          >
            <Icon icon={Trash2} size="sm" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this CRM record?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the {primaryObjectLabel} in {customerName}. The One
              binding will be cleared only after the CRM no longer returns this
              record through its registered read tool.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "delete"}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy === "delete"}
              onClick={() => void deleteRecord()}
            >
              Delete record
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ) : null;

  if (!canUseBackend && mode !== "list") {
    return (
      <SettingsGroup title="CRM system">
        <SettingsRow
          icon={Database}
          title="Unlock vault"
          description="Unlock your vault to inspect connected CRM systems."
          chevron
          onClick={onRequestUnlock}
        />
      </SettingsGroup>
    );
  }

  if (mode === "list") {
    return (
      <div className="space-y-4 sm:space-y-5">
        {systems.length === 0 &&
        (busy === "systems" || systemsResource.loading) ? (
          <SettingsGroup>
            <SettingsRow
              icon={RefreshCw}
              title="Loading connected systems"
              description="Fetching CRM systems configured for this One account."
              trailing={
                <Icon icon={RefreshCw} size="sm" className="animate-spin" />
              }
              stackTrailingOnMobile
            />
          </SettingsGroup>
        ) : null}
        {systems.length === 0 &&
        busy !== "systems" &&
        !systemsResource.loading ? (
          <SettingsGroup>
            <SettingsRow
              icon={Database}
              title="No CRM systems available"
              description="Refresh to check which systems are available to this account."
              trailing={
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void refreshSystems()}
                  aria-label="Refresh CRM systems"
                >
                  <Icon icon={RefreshCw} size="sm" />
                </Button>
              }
              stackTrailingOnMobile
            />
          </SettingsGroup>
        ) : null}
        {systems.length > 0 ? (
          <SettingsGroup separatorInset>
            {systems.map((system) => {
              const title =
                system.displayName ||
                system.customerDisplayName ||
                "CRM system";
              const availability = registryAvailabilityLabel(system);
              const rowState =
                availability === "Needs setup"
                  ? "Needs setup"
                  : availability !== "Available"
                    ? "Temporarily unavailable"
                    : boundSystemIds.has(system.systemId)
                      ? "Connected"
                      : "Set up";
              return (
                <SettingsRow
                  key={system.systemId}
                  leading={<ConnectedSystemLogo system={system} />}
                  title={title}
                  description={crmTypeDisplayLabel(system) || "CRM"}
                  trailing={
                    <span
                      className={
                        rowState === "Connected"
                          ? "text-xs font-medium text-emerald-700 dark:text-emerald-300"
                          : "text-xs font-medium text-muted-foreground"
                      }
                    >
                      {rowState}
                    </span>
                  }
                  chevron
                  onClick={() =>
                    router.push(
                      setupRouteBase
                        ? `${setupRouteBase}?system=${encodeURIComponent(system.systemId)}`
                        : buildConnectedSystemRoute(system.systemId),
                    )
                  }
                />
              );
            })}
          </SettingsGroup>
        ) : null}

        {effectiveError ? (
          <SurfaceInset className="px-3.5 py-3.5 text-sm text-destructive sm:px-4 sm:py-4">
            {effectiveError}
          </SurfaceInset>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      {effectiveError ? (
        <SurfaceInset className="px-3.5 py-3.5 text-sm text-destructive sm:px-4 sm:py-4">
          {effectiveError}
        </SurfaceInset>
      ) : null}

      {isRecordStateLoading ? (
        <span
          role="status"
          aria-label={
            isSchemaPreparationPending
              ? "Preparing your CRM profile"
              : "Checking saved CRM record"
          }
          className="flex justify-center py-2 text-muted-foreground"
        >
          <Icon icon={RefreshCw} size="sm" className="animate-spin" />
        </span>
      ) : null}

      {showCatalogueOnly ? (
        <SettingsGroup title="Profile fields">
          <div className="space-y-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="flex justify-end">
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                disabled={busy !== null}
                onClick={() => void loadSchema()}
              >
                <Icon icon={ListChecks} size="sm" className="mr-2" />
                Refresh fields
              </Button>
            </div>
            {renderCrmFieldTable(
              !schemaReady
                ? schema?.configurationMessage ||
                    "This is a discovered field catalogue. Record actions are unavailable until its verified onboarding mapping refreshes."
                : schema?.configurationMessage ||
                    "This CRM is shown as a field catalogue until its verified onboarding mapping is available.",
            )}
          </div>
        </SettingsGroup>
      ) : null}

      {canShowUnboundRecordActions ? (
        <SettingsGroup
          title={shouldOfferCreate ? "Create a new profile" : "Find my profile"}
        >
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <VerifiedProfileSummary
              profile={profile}
              action={shouldOfferCreate ? "create" : "find"}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {unboundLookupState === "remote_missing"
                  ? "The linked record no longer exists in this CRM. Unlink it to prepare a new profile."
                  : unboundLookupState === "no_match"
                    ? "No matching profile was found."
                    : unboundLookupState === "failed"
                      ? "We couldn’t complete that search. Try again."
                      : "You’ll review any new profile before it is created."}
              </p>
              {unboundLookupState === "remote_missing" ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" size="sm" disabled={busy !== null}>
                      <Icon icon={SendHorizontal} size="sm" className="mr-2" />
                      Unlink and create profile
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Replace the missing CRM record?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes the stale One link and prepares a new
                        profile for your review. It does not delete anything in
                        the CRM.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={busy !== null}>
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        disabled={busy !== null}
                        onClick={() => void recoverMissingRecord()}
                      >
                        Unlink and continue
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void (supportsAction("read") && !shouldOfferCreate
                      ? findExistingProfile()
                      : createRecordFromSchema())
                  }
                >
                  <Icon
                    icon={SendHorizontal}
                    size="sm"
                    className={
                      busy === "lookup" || busy === "create"
                        ? "mr-2 animate-pulse"
                        : "mr-2"
                    }
                  />
                  {busy === "lookup"
                    ? "Finding your record..."
                    : busy === "create"
                      ? "Preparing review..."
                      : supportsAction("read") && !shouldOfferCreate
                        ? "Find my record"
                        : "Create profile"}
                </Button>
              )}
            </div>
          </div>
        </SettingsGroup>
      ) : null}

      {!hasBoundRecord &&
      !isRecordStateLoading &&
      schema &&
      !canShowUnboundRecordActions ? (
        <SettingsGroup title="Profile">
          <SettingsRow
            icon={Database}
            title="Profile setup is temporarily unavailable"
            description={
              schema.configurationMessage ||
              "This CRM is preparing its profile setup. Try again shortly."
            }
            trailing={
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                disabled={busy !== null}
                onClick={() => void loadSchema()}
              >
                Refresh
              </Button>
            }
            stackTrailingOnMobile
          />
        </SettingsGroup>
      ) : null}

      {isSetupPresentation && hasBoundRecord && !isRecordStateLoading ? (
        <SettingsGroup title="CRM ready">
          <SettingsRow
            icon={Database}
            title="Record connected"
            description="Your verified CRM record is ready for approved reads and writes."
            trailing={
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                Connected
              </span>
            }
          />
        </SettingsGroup>
      ) : null}

      {canShowBoundRecordActions ? (
        <section className="space-y-3" aria-label="CRM record fields">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                disabled={busy !== null}
                onClick={() => void loadSchema()}
              >
                <Icon icon={ListChecks} size="sm" className="mr-2" />
                {schema ? "Refresh fields" : "Discover fields"}
              </Button>
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                disabled={busy !== null}
                onClick={() => void readRecord()}
              >
                <Icon icon={RefreshCw} size="sm" className="mr-2" />
                Refresh
              </Button>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                disabled={busy !== null}
                onClick={resetWorkingCopy}
              >
                Reset
              </Button>
              {deleteRecordControl}
            </div>
          </div>
          {isFieldTableRefreshing ? (
            <SurfaceInset className="px-3.5 py-3 text-sm text-muted-foreground sm:px-4">
              Refreshing the latest CRM fields…
            </SurfaceInset>
          ) : (
            renderCrmFieldTable()
          )}
          {renderPendingUpdatePreview()}
          <div className="flex justify-center">
            <Button
              type="button"
              fullWidth
              className="min-h-14 max-w-[30rem] text-base font-semibold"
              disabled={
                busy !== null ||
                !currentRecordId.trim() ||
                Object.keys(changedProfileFields).length === 0
              }
              onClick={() => void updateRecordFromSchema()}
            >
              <Icon
                icon={SendHorizontal}
                size="sm"
                className={busy === "update" ? "mr-2 animate-pulse" : "mr-2"}
              />
              {busy === "update" ? "Updating..." : "Update record"}
            </Button>
          </div>
        </section>
      ) : null}
      {deleteResult ? (
        <SurfaceInset className="px-3.5 py-3.5 text-sm text-muted-foreground sm:px-4 sm:py-4">
          Delete request returned{" "}
          {statusBadge(String(deleteResult.resultClass || "completed"))}.
        </SurfaceInset>
      ) : null}
      {!isSetupPresentation ? (
        <SettingsDetailPanel
          open={Boolean(editingField)}
          onOpenChange={(open) => {
            if (!open) setEditingField(null);
          }}
          title={editingField ? `Edit ${editingField.label}` : "Edit CRM field"}
          description="This change is staged locally and will be reviewed before the CRM is updated."
          desktopMaxWidthClassName="sm:!max-w-[520px]"
        >
          {editingField ? (
            <div className="space-y-4 p-4 sm:p-5">
              {Array.isArray(editingField.constraints?.allowedValues) ? (
                <select
                  value={editingValue}
                  onChange={(event) => setEditingValue(event.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Not set</option>
                  {editingField.constraints?.allowedValues
                    ?.filter(
                      (value): value is string => typeof value === "string",
                    )
                    .map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                </select>
              ) : (
                <Input
                  type={editingField.inputType || "text"}
                  value={editingValue}
                  maxLength={
                    typeof editingField.constraints?.maxLength === "number"
                      ? editingField.constraints.maxLength
                      : undefined
                  }
                  onChange={(event) => setEditingValue(event.target.value)}
                  placeholder={editingField.placeholder}
                  autoComplete="off"
                />
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  size="sm"
                  onClick={() => setEditingField(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    updateCrmFieldValue(editingField, editingValue);
                    setEditingField(null);
                  }}
                >
                  Stage change
                </Button>
              </div>
            </div>
          ) : null}
        </SettingsDetailPanel>
      ) : null}
      <AlertDialog
        open={Boolean(pendingUpdateReview)}
        onOpenChange={(open) => {
          if (!open && !updateReviewSubmittingRef.current && busy === null) {
            setPendingUpdateReview(null);
          }
        }}
      >
        <AlertDialogContent className="!grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] !max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 !overflow-hidden !p-0">
          <AlertDialogHeader className="shrink-0 px-5 pt-5 pb-4 sm:px-6 sm:pt-6">
            <AlertDialogTitle>Review changes</AlertDialogTitle>
            <AlertDialogDescription>
              {customerName} · {primaryObjectLabel}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div
            aria-label="Changes to apply"
            className="min-h-0 max-h-[min(46dvh,30rem)] overflow-y-auto overscroll-contain border-y border-[color:var(--app-card-border-standard)]"
          >
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 bg-muted/45 px-5 py-2 text-[13px] font-normal leading-[18px] tracking-normal text-muted-foreground sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] sm:px-6">
              <span>Field</span>
              <span className="hidden sm:block">Current value</span>
              <span>Updated value</span>
            </div>
            <dl className="divide-y divide-[color:var(--app-card-border-standard)]">
              {pendingUpdateReview?.fields.map((field) => (
                <div
                  key={field.key}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-4 sm:px-6"
                >
                  <dt className="min-w-0 text-sm font-medium text-foreground">
                    {field.label}
                  </dt>
                  <dd className="hidden min-w-0 break-words text-sm text-muted-foreground sm:block">
                    {field.previousValue || "Not set"}
                  </dd>
                  <dd className="min-w-0 break-words text-sm text-foreground">
                    {field.nextValue || "Clear value"}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <AlertDialogFooter className="shrink-0 px-5 py-4 sm:px-6 sm:py-5">
            <AlertDialogCancel disabled={busy !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy !== null}
              onClick={() => void approveUpdateReview()}
            >
              Confirm update
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(pendingIntent)}
        onOpenChange={(open) => {
          if (!open && busy === null) setPendingIntent(null);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Review {pendingIntent?.action || "CRM"} request
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingIntent
                ? `${customerName} · ${pendingIntent.objectType || primaryObjectLabel}`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingIntent?.action === "delete" ? (
            <p className="text-sm text-muted-foreground">
              This permanently removes the selected record from {customerName}{" "}
              and clears its One binding after confirmation.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {pendingIntent?.fieldNames.map((field) => (
                <Badge key={field} variant="secondary">
                  {field}
                </Badge>
              ))}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={busy !== null}
              onClick={() => void rejectPendingIntent()}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant={
                pendingIntent?.action === "delete" ? "destructive" : "default"
              }
              disabled={busy !== null}
              onClick={() => void approvePendingIntent()}
            >
              Confirm {pendingIntent?.action || "request"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Building2,
  Database,
  ListChecks,
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
import { SettingsDetailPanel, SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { DataTable } from "@/components/app-ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Icon } from "@/lib/morphy-ux/ui";
import { Button } from "@/lib/morphy-ux/morphy";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { buildConnectedSystemRoute } from "@/lib/navigation/routes";
import {
  ConnectedSystemsService,
  type ConnectedSystemMcpResponse,
  type ConnectedSystemIntent,
  type ConnectedSystemRecordBinding,
  type ConnectedSystemSchemaResponse,
  type ConnectedSystemSummary,
} from "@/lib/services/connected-systems-service";

type BusyState =
  | "systems"
  | "schema"
  | "binding"
  | "read"
  | "create"
  | "update"
  | "delete"
  | null;

type ConnectedSystemsPanelProps = {
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
  dataType: string;
  access: string;
  required: string;
  currentValue: string;
  field: CrmProfileField;
};

function statusBadge(status: string | undefined | null): string {
  if (!status) return "Unknown";
  return status
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

const MACYS_LOGO_SRC = "/brand/macys-logo.svg";
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

function customerLogoSrc(
  system?: ConnectedSystemSummary | null,
): string | null {
  const customer = String(system?.customerDisplayName || system?.target || "")
    .trim()
    .toLowerCase();
  if (customer.includes("macy") || customer.includes("macys")) {
    return MACYS_LOGO_SRC;
  }
  return null;
}

function crmTypeDisplayLabel(
  system?: Pick<ConnectedSystemSummary, "systemType" | "systemName"> | null,
): string {
  return [system?.systemType, system?.systemName].filter(Boolean).join(" ");
}

function ConnectedSystemLogo({
  system,
  size = "row",
}: {
  system?: ConnectedSystemSummary | null;
  size?: "row" | "hero";
}) {
  const logoSrc = customerLogoSrc(system);
  const label = system?.customerDisplayName || system?.target || "CRM system";
  const dimensions =
    size === "hero"
      ? "h-14 w-28 rounded-xl px-3 py-2"
      : "h-10 w-16 rounded-xl px-2.5 py-1.5";

  return (
    <span
      className={`${dimensions} inline-flex shrink-0 items-center justify-center border border-border/60 bg-white shadow-sm`}
    >
      {logoSrc ? (
        <Image
          src={logoSrc}
          alt={`${label} logo`}
          width={size === "hero" ? 112 : 64}
          height={size === "hero" ? 56 : 40}
          className="h-full w-full object-contain"
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
    record.__connectedSystemRecordId || record.Id || record.id || record.recordId || record.record_id,
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
    records[0] ||
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
  for (const candidate of [field.rawName, field.key]) {
    if (candidate && candidate in record) return cleanFieldValue(record[candidate]);
    const matchedKey = Object.keys(record).find(
      (key) => key.toLowerCase() === candidate?.toLowerCase(),
    );
    if (matchedKey) return cleanFieldValue(record[matchedKey]);
  }
  return "";
}

function changedFieldsFromValues(
  values: CrmFieldValues,
  baseline: CrmFieldValues,
  fields: CrmProfileField[],
): Record<string, string> {
  const additionalFields: Record<string, string> = {};
  for (const field of fields) {
    if (field.identityField || field.updateable === false || field.immutable === true) continue;
    const nextValue = (values[field.key] || "").trim();
    const previousValue = (baseline[field.key] || "").trim();
    if (nextValue !== previousValue) additionalFields[field.key] = nextValue;
  }
  return additionalFields;
}

export function ConnectedSystemsPanel({
  vaultOwnerToken,
  onRequestUnlock,
  mode = "detail",
  systemId,
  agentInstruction,
  profile,
  onSetupReadinessChange,
  setupRouteBase,
}: ConnectedSystemsPanelProps) {
  const router = useRouter();
  const [systems, setSystems] = useState<ConnectedSystemSummary[]>([]);
  const [schema, setSchema] = useState<ConnectedSystemSchemaResponse | null>(
    null,
  );
  const [binding, setBinding] = useState<ConnectedSystemRecordBinding | null>(
    null,
  );
  const [readResult, setReadResult] =
    useState<ConnectedSystemMcpResponse | null>(null);
  const [deleteResult, setDeleteResult] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [pendingIntent, setPendingIntent] = useState<ConnectedSystemIntent | null>(null);
  const [busy, setBusy] = useState<BusyState>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<CrmProfileField | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const [crmFieldValues, setCrmFieldValues] = useState<
    CrmFieldValues
  >(DEFAULT_CRM_PROFILE_VALUES);
  const [crmBaselineValues, setCrmBaselineValues] = useState<
    CrmFieldValues
  >(DEFAULT_CRM_PROFILE_VALUES);
  const [updateId, setUpdateId] = useState("");
  const [deleteId, setDeleteId] = useState("");
  const [fieldView, setFieldView] = useState<"basic" | "all">("basic");
  const [bindingResolvedKey, setBindingResolvedKey] = useState<string | null>(
    null,
  );
  const [readResolvedKey, setReadResolvedKey] = useState<string | null>(null);
  const consumedAgentInstructionRef = useRef<string | null>(null);
  // Tracks which systems (by systemId) have an active record binding, across
  // ALL available systems, not just the one currently open in detail view.
  // The step is complete once the person has linked any one of them.
  const [boundSystemIds, setBoundSystemIds] = useState<Set<string>>(new Set());

  const selectedSystem =
    systems.find((system) => system.systemId === systemId) ||
    (!systemId ? systems[0] || null : null);
  const selectedSystemKey = selectedSystem
    ? `${selectedSystem.systemId}:${selectedSystem.objectTypeDefault || "Contact"}`
    : "";
  const canUseBackend = Boolean(vaultOwnerToken);
  const schemaReady = schema?.schemaStatus === "ready";
  const supportsAction = (action: "schema" | "read" | "create" | "update" | "delete") =>
    action === "schema"
      ? selectedSystem?.supportedActions?.schema === true
      : schemaReady && schema?.effectiveActions?.[action] === true;
  const customerName = selectedSystem?.customerDisplayName || "Connected CRM";
  const systemType = selectedSystem?.systemType || "CRM";
  const systemName = selectedSystem?.systemName || "FSC";
  const systemLabel = crmTypeDisplayLabel({ systemType, systemName });
  const primaryObjectLabel =
    schema?.objectMetadata?.label ||
    schema?.objectType ||
    selectedSystem?.capabilities?.primaryObject ||
    selectedSystem?.objectTypeDefault ||
    "record";
  const crmRecords = useMemo(() => extractRecords(readResult), [readResult]);
  const hasReadback = Boolean(readResult);
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
  const visibleProfileFields = useMemo(() => {
    if (schemaDrivenProfileFields.length > 0) return schemaDrivenProfileFields;
    return [];
  }, [schemaDrivenProfileFields]);
  const displayedProfileFields = useMemo(() => {
    if (fieldView === "all") return visibleProfileFields;
    const mappedFields = new Set(
      Object.values(schema?.profileFieldMappings || {})
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    );
    const basicFields = visibleProfileFields.filter(
      (field) => mappedFields.has(field.rawName || field.key) || field.required,
    );
    return basicFields.length > 0 ? basicFields : visibleProfileFields;
  }, [fieldView, schema?.profileFieldMappings, visibleProfileFields]);
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
  const currentRecordId = useMemo(
    () => boundRecordId || updateId.trim(),
    [boundRecordId, updateId],
  );
  const hasBoundRecord = Boolean(currentRecordId);
  const currentReadRecord = useMemo(
    () => selectRecordForId(readResult, currentRecordId),
    [currentRecordId, readResult],
  );
  const primaryCrmRecord = currentReadRecord || crmRecords[0] || null;
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
    !error &&
    hasBoundRecord &&
    schemaReady && supportsAction("read") &&
    !boundRecordReadResolved;
  const isRecordStateLoading =
    mode === "detail" &&
    canUseBackend &&
    !error &&
    (!selectedSystem ||
      !bindingResolved ||
      isBoundRecordHydrating);
  const canShowUnboundRecordActions =
    !hasBoundRecord &&
    !isRecordStateLoading &&
    schemaReady &&
    visibleProfileFields.length > 0 &&
    (supportsAction("read") || supportsAction("create"));
  const canShowBoundRecordActions =
    hasBoundRecord && !isRecordStateLoading && schemaReady && supportsAction("update");
  const showCatalogueOnly = Boolean(
    schema &&
      (!schemaReady ||
        (hasBoundRecord ? !canShowBoundRecordActions : !canShowUnboundRecordActions)),
  );

  useEffect(() => {
    if (mode !== "detail") return;
    setReadResolvedKey(null);
    setReadResult(null);
  }, [crmRecordReadKey, mode]);

  const refreshSystems = useCallback(async () => {
    // Listing needs sign-in only, not vault unlock: fall back to the Firebase
    // ID token when the vault is locked so the CRM overview never dead-ends
    // into an unlock prompt. Record-level actions below still require the
    // vault owner token.
    let authToken = vaultOwnerToken || "";
    if (!authToken) {
      const { AuthService } = await import("@/lib/services/auth-service");
      authToken = (await AuthService.getIdToken()) || "";
    }
    if (!authToken) return;
    setBusy("systems");
    setError(null);
    try {
      setSystems(await ConnectedSystemsService.listSystems(authToken));
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Connected Systems could not load.";
      setError(message);
    } finally {
      setBusy(null);
    }
  }, [vaultOwnerToken]);

  useEffect(() => {
    void refreshSystems();
  }, [refreshSystems]);

  // Aggregate binding status across every OTHER listed system (the
  // currently selected one is already tracked live via `activeBinding`/
  // `refreshBinding`, so it is excluded here to avoid a redundant duplicate
  // fetch) so completion can fire on ANY connected CRM, not only the one
  // currently open in detail view. Best-effort and silent: a single
  // system's lookup failing (e.g. one CRM briefly unavailable) must not
  // block detecting completion from the others. Skipped entirely when there
  // is only one system, since that system's own binding already covers it.
  useEffect(() => {
    if (!vaultOwnerToken || systems.length < 2) return;
    let cancelled = false;
    const otherSystems = systems.filter(
      (system) => system.systemId !== selectedSystem?.systemId,
    );
    if (otherSystems.length === 0) return;
    void (async () => {
      const results = await Promise.all(
        otherSystems.map(async (system) => {
          try {
            const response = await ConnectedSystemsService.getRecordBinding({
              vaultOwnerToken,
              systemId: system.systemId,
              objectType: system.objectTypeDefault || "Contact",
            });
            return response.binding?.status === "active"
              ? system.systemId
              : null;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      setBoundSystemIds(new Set(results.filter((id): id is string => Boolean(id))));
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSystem?.systemId, systems, vaultOwnerToken]);

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
  }, [mode, selectedSystem, selectedSystemKey, vaultOwnerToken]);

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
    options: { showErrorToast?: boolean } = {},
  ): Promise<T | null> {
    if (!vaultOwnerToken) {
      onRequestUnlock?.();
      return null;
    }
    setBusy(state);
    setError(null);
    try {
      return await action();
    } catch (err) {
      const message = connectedSystemsUserMessage(err);
      setError(message);
      if (options.showErrorToast !== false) {
        toast.error(message);
      }
      return null;
    } finally {
      setBusy(null);
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
    const result = await runAction("schema", () =>
      ConnectedSystemsService.getSchema({
        vaultOwnerToken: vaultOwnerToken || "",
        systemId: selectedSystem?.systemId,
        objectType: selectedSystem?.objectTypeDefault || "Contact",
      }),
    );
    if (result) {
      setSchema(result);
      if (!options.silent) {
        toast.success("CRM schema loaded.");
      }
    }
  };

  const applyReadResult = (result: ConnectedSystemMcpResponse) => {
    setReadResult(result);
    const nextBinding =
      result.binding?.status === "active" ? result.binding : null;
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
    }
    const recordId = result.recordId || extractFirstRecordId(result);
    if (recordId && (nextBinding || currentRecordId)) {
      setUpdateId(recordId);
      setDeleteId(recordId);
    }
  };

  const readRecord = async (
    options: {
      silent?: boolean;
      bindSearch?: boolean;
    } = {},
  ) => {
    const result = await runAction(
      "read",
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
          : await ConnectedSystemsService.readRecord(
              vaultOwnerToken || "",
              payload,
            );
        if (completedReadKey) setReadResolvedKey(completedReadKey);
        return nextResult;
      },
      { showErrorToast: !options.silent },
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
        } else if (currentRecordId) {
          toast.info(
            `${customerName} record is linked, but the CRM did not return field values.`,
          );
        } else {
          toast.info(`No matching ${customerName} record found.`);
        }
      }
    }
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
    toast.info("CRM proposal staged. Review it before linking or updating the record.");
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
    if (!vaultOwnerToken || !selectedSystem || mode !== "detail") return;
    void loadSchema({ silent: true });
    // loadSchema is intentionally keyed by selected system and vault state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedSystem, vaultOwnerToken]);

  useEffect(() => {
    if (
      !vaultOwnerToken ||
      mode !== "detail" ||
      !activeBinding ||
      !currentRecordId ||
      !schemaReady ||
      !supportsAction("read") ||
      readResultHasCurrentRecord
    ) {
      return;
    }
    void readRecord({ silent: true });
    // readRecord is intentionally keyed by the active binding and lookup state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeBinding,
    currentRecordId,
    mode,
    readResultHasCurrentRecord,
    vaultOwnerToken,
    schemaReady,
  ]);

  const updateCrmFieldValue = (field: CrmProfileField, value: string) => {
    if (!schemaReady || field.updateable === false || field.identityField || field.immutable === true) return;
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
      () => ConnectedSystemsService.createRecordIntent(vaultOwnerToken || "", {
        systemId: selectedSystem?.systemId,
        objectType: selectedSystem?.objectTypeDefault,
      }),
    );
    if (result) {
      setPendingIntent(result);
    }
    return result;
  };

  /**
   * Single create-or-update entry point for the unbound state: search for an
   * existing record first, and only create a new one if the search comes back
   * empty. Replaces the old two-button "Find my record" / "Create my record"
   * split so the person takes one action instead of guessing which to try
   * first.
   */
  const linkThisSystem = async () => {
    const canRead = supportsAction("read");
    const canCreate = supportsAction("create");
    if (canRead) {
      const found = await readRecord({
        silent: true,
        bindSearch: true,
      });
      if (found?.binding?.status === "active") {
        toast.success(`Found your existing ${customerName} record and linked it.`);
        return;
      }
      if (!canCreate) {
        toast.info(`No matching ${customerName} record was found.`);
        return;
      }
    }
    if (!canCreate) return;
    await createRecordFromSchema();
  };

  const updateRecordFromSchema = async () => {
    const recordId = currentRecordId;
    const recordFields = changedProfileFields;
    if (Object.keys(recordFields).length === 0) {
      toast.error("Change at least one CRM field before updating the record.");
      return;
    }
    setUpdateId(recordId);
    const result = await runMutation(
      "update",
      {
        loading: "Preparing CRM update review...",
        success: "CRM update is ready for review.",
        error: "CRM update could not be prepared.",
      },
      () => ConnectedSystemsService.updateRecordIntent(
          vaultOwnerToken || "",
          {
            systemId: selectedSystem?.systemId,
            objectType: selectedSystem?.objectTypeDefault,
            additionalFields: {},
            recordFields,
          },
        ),
    );
    if (result) {
      setPendingIntent(result);
    }
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
      intent.action === "delete" ? "delete" : intent.action === "create" ? "create" : "update",
      {
        loading: `Applying ${intent.action}…`,
        success: `${customerName} record ${intent.action} completed.`,
        error: `${customerName} record ${intent.action} failed.`,
      },
      () => ConnectedSystemsService.approveIntent({
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
    const recordId = cleanFieldValue(result.binding?.recordId || result.recordId);
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

  const renderSchemaStatus = (
    options: { showPendingChanges?: boolean } = {},
  ) => {
    const pendingChanges = Object.keys(changedProfileFields).length;
    const parts = [
      schema ? `${visibleProfileFields.length} fields discovered` : "Waiting for CRM schema",
      schema?.schemaStatus === "capability_metadata_missing"
        ? "Configuration update required"
        : null,
      primaryCrmRecord
        ? `${crmRecords.length} record${crmRecords.length === 1 ? "" : "s"} loaded`
        : hasReadback && currentRecordId
          ? "Record linked"
          : hasReadback
            ? "No record returned"
            : "Profile values ready",
      currentRecordId ? `Record ${currentRecordId}` : null,
      options.showPendingChanges
        ? `${pendingChanges} pending change${pendingChanges === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean);

    return <p className="text-xs text-muted-foreground">{parts.join(" / ")}</p>;
  };

  const crmFieldRows: CrmFieldTableRow[] = displayedProfileFields.map((field) => {
    const access = [
      field.readable ? "read" : null,
      field.createable ? "create" : null,
      field.updateable ? "update" : null,
      field.immutable ? "immutable" : null,
      field.identityField ? "identity" : null,
    ].filter(Boolean).join(" · ") || "not declared";
    return {
      key: field.key,
      label: field.label,
      dataType: field.dataType || "string",
      access,
      required: field.required ? "Required" : "Optional",
      currentValue: displayRecordValue(crmFieldValues[field.key]),
      field,
    };
  });

  const crmFieldColumns: ColumnDef<CrmFieldTableRow>[] = [
    { accessorKey: "label", header: "Field" },
    { accessorKey: "dataType", header: "Type" },
    {
      accessorKey: "access",
      header: "Access",
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.access}</span>,
    },
    { accessorKey: "required", header: "Required" },
    {
      accessorKey: "currentValue",
      header: "Current value",
      cell: ({ row }) => <span className="block max-w-56 truncate">{row.original.currentValue}</span>,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const field = row.original.field;
        if (
          !hasBoundRecord ||
          !schemaReady ||
          !supportsAction("update") ||
          field.updateable === false ||
          field.identityField ||
          field.immutable
        ) {
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        return (
          <Button
            type="button"
            variant="none"
            effect="fade"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setEditingField(field);
              setEditingValue(cleanFieldValue(crmFieldValues[field.key]));
            }}
          >
            Edit
          </Button>
        );
      },
    },
  ];

  const renderCrmFieldTable = (configurationMessage?: string | null) => (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {fieldView === "all" ? "All CRM fields" : "Basic profile fields"}
        </p>
        <select
          aria-label="Field view"
          className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          value={fieldView}
          onChange={(event) => setFieldView(event.target.value as "basic" | "all")}
        >
          <option value="basic">Basic fields</option>
          <option value="all">All fields</option>
        </select>
      </div>
      <DataTable
        columns={crmFieldColumns}
        data={crmFieldRows}
        globalSearchKeys={["label", "dataType", "access", "required", "currentValue"]}
        searchPlaceholder="Search fields"
        initialPageSize={16}
        pageSizeOptions={[16, 32, 64]}
        density="compact"
        stickyHeader
        tableContainerClassName="max-w-full"
        tableClassName="min-w-[920px]"
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
        {systems.length === 0 && busy === "systems" ? (
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
        {systems.length === 0 && busy !== "systems" ? (
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
          <SettingsGroup title="Available systems" separatorInset>
            {systems.map((system) => {
              const title =
                system.displayName || system.customerDisplayName || "CRM system";
              return (
                <SettingsRow
                  key={system.systemId}
                  leading={<ConnectedSystemLogo system={system} />}
                  title={title}
                  description={crmTypeDisplayLabel(system) || "CRM"}
                  trailing={
                    <span className="max-w-[7.5rem] truncate text-xs text-muted-foreground sm:max-w-[10rem]">
                      {statusBadge(system.status)}
                    </span>
                  }
                  chevron
                  stackTrailingOnMobile
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

        {error ? (
          <SurfaceInset className="px-3.5 py-3.5 text-sm text-destructive sm:px-4 sm:py-4">
            {error}
          </SurfaceInset>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <SurfaceInset className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <ConnectedSystemLogo system={selectedSystem} size="hero" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                CRM system
              </p>
              <h2 className="text-lg font-semibold tracking-normal text-foreground">
                {customerName}
              </h2>
              <p className="text-sm text-muted-foreground">
                {systemLabel || selectedSystem?.displayName || "CRM"} /{" "}
                {primaryObjectLabel}.
              </p>
            </div>
          </div>
          <div className="text-left text-xs text-muted-foreground sm:text-right">
            {statusBadge(selectedSystem?.status || "connected")} through{" "}
            {selectedSystem?.transportLabel || "External CRM MCP"}
          </div>
        </div>
      </SurfaceInset>

      {error ? (
        <SurfaceInset className="px-3.5 py-3.5 text-sm text-destructive sm:px-4 sm:py-4">
          {error}
        </SurfaceInset>
      ) : null}

      {isRecordStateLoading ? (
        <SettingsGroup title={`Checking ${customerName} record`}>
          <SettingsRow
            icon={RefreshCw}
            title="Looking for your saved CRM record"
            description="Checking the saved record before showing record actions."
            trailing={
              <Icon icon={RefreshCw} size="sm" className="animate-spin" />
            }
            stackTrailingOnMobile
          />
        </SettingsGroup>
      ) : null}

      {showCatalogueOnly ? (
        <SettingsGroup title={`${customerName} field catalogue`}>
          <div className="space-y-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {renderSchemaStatus()}
              <div className="flex flex-wrap gap-2">
                {schemaReady && hasBoundRecord && supportsAction("read") ? (
                  <Button
                    type="button"
                    variant="none"
                    effect="fade"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void readRecord()}
                  >
                    <Icon icon={RefreshCw} size="sm" className="mr-2" />
                    Refresh record
                  </Button>
                ) : null}
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
        <SettingsGroup title={`Link my ${customerName} record`}>
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {renderSchemaStatus()}
              <div className="flex flex-wrap gap-2">
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
              </div>
            </div>
            {renderCrmFieldTable()}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {supportsAction("read") && supportsAction("create")
                ? "We’ll look up only the verified email and phone on your Hussh account, then create a basic record only when no match exists."
                : supportsAction("read")
                  ? "We’ll look only for an existing CRM record."
                  : "This CRM allows a new record to be prepared for review."}
            </p>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={busy !== null}
                onClick={() => void linkThisSystem()}
              >
                <Icon
                  icon={SendHorizontal}
                  size="sm"
                  className={
                    busy === "read" || busy === "create"
                      ? "mr-2 animate-pulse"
                      : "mr-2"
                  }
                />
                {busy === "read"
                  ? "Looking for your record..."
                  : busy === "create"
                    ? "Creating your record..."
                    : supportsAction("read") && supportsAction("create")
                      ? "Link this system"
                      : supportsAction("read")
                        ? "Find record"
                        : "Create record"}
              </Button>
            </div>
          </div>
        </SettingsGroup>
      ) : null}

      {canShowBoundRecordActions ? (
        <SettingsGroup title={`Update my ${customerName} information`}>
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {renderSchemaStatus({ showPendingChanges: true })}
              <div className="flex flex-wrap gap-2">
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
            </div>
            {renderCrmFieldTable()}
            {renderPendingUpdatePreview()}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                size="sm"
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
          </div>
        </SettingsGroup>
      ) : null}

      {hasBoundRecord && !isRecordStateLoading && supportsAction("delete") ? (
        <SettingsGroup title="Delete record">
          <SettingsRow
            icon={Trash2}
            title={`Delete ${primaryObjectLabel}`}
            description={`Remove record ${currentRecordId} from ${customerName}.`}
            trailing={
              <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      size="sm"
                      disabled={busy !== null || !(deleteId || currentRecordId)}
                    >
                      <Icon icon={Trash2} size="sm" className="mr-2" />
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Delete this CRM record?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This deletes the {primaryObjectLabel} in {customerName}. The One
                        binding will be cleared only after the CRM no longer
                        returns this record through its registered read tool.
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
              </div>
            }
            stackTrailingOnMobile
          />
        </SettingsGroup>
      ) : null}
      {deleteResult ? (
        <SurfaceInset className="px-3.5 py-3.5 text-sm text-muted-foreground sm:px-4 sm:py-4">
          Delete request returned{" "}
          {statusBadge(String(deleteResult.resultClass || "completed"))}.
        </SurfaceInset>
      ) : null}
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
                  ?.filter((value): value is string => typeof value === "string")
                  .map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            ) : (
              <Input
                type={editingField.inputType || "text"}
                value={editingValue}
                maxLength={typeof editingField.constraints?.maxLength === "number" ? editingField.constraints.maxLength : undefined}
                onChange={(event) => setEditingValue(event.target.value)}
                placeholder={editingField.placeholder}
                autoComplete="off"
              />
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="none" effect="fade" size="sm" onClick={() => setEditingField(null)}>
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
                ? `${customerName} · ${pendingIntent.objectType || primaryObjectLabel}${pendingIntent.recordId ? ` · record ${pendingIntent.recordId}` : ""}`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingIntent?.action === "delete" ? (
            <p className="text-sm text-muted-foreground">
              This permanently removes the selected record from {customerName} and clears its One binding after confirmation.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {pendingIntent?.fieldNames.map((field) => (
                <Badge key={field} variant="secondary">{field}</Badge>
              ))}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null} onClick={() => void rejectPendingIntent()}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant={pendingIntent?.action === "delete" ? "destructive" : "default"}
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

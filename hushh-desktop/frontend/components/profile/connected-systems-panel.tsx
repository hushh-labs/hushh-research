"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  Database,
  ListChecks,
  RefreshCw,
  Search,
  SendHorizontal,
  Shuffle,
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
  SettingsGroup,
  SettingsRow,
} from "@/components/profile/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Icon } from "@/lib/morphy-ux/ui";
import { Button } from "@/lib/morphy-ux/morphy";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { buildConnectedSystemRoute } from "@/lib/navigation/routes";
import {
  ConnectedSystemsService,
  SALESFORCE_CRM_SYSTEM_ID,
  type ConnectedSystemMcpResponse,
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
  profile?: {
    displayName?: string | null;
    email?: string | null;
    phone?: string | null;
  };
};

type CrmProfileFieldKey =
  | "FirstName"
  | "LastName"
  | "Email"
  | "Phone"
  | "MobilePhone"
  | "Title"
  | "Department"
  | "MailingCity"
  | "MailingStreet"
  | "LeadSource";

type CrmProfileField = {
  key: CrmProfileFieldKey;
  label: string;
  placeholder: string;
  inputType?: string;
  required?: boolean;
  rawName?: string;
  source?: string;
};

function statusBadge(status: string | undefined | null): string {
  if (!status) return "Unknown";
  return status
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

const RANDOM_DEMO_CHANGES = [
  { Title: "VP Sales", MailingCity: "New York", Department: "Retail Partnerships" },
  { Title: "Director, Customer Experience", MailingCity: "Chicago", LeadSource: "Connected Systems Demo" },
  { Title: "SVP Merchandising", MailingCity: "San Francisco", MailingStreet: "170 O'Farrell St" },
  { Title: "Head of Loyalty", MailingCity: "Atlanta", Department: "Customer Growth" },
];

const RANDOM_DEMO_NAMES = [
  { FirstName: "Avery", LastName: "Patel" },
  { FirstName: "Jordan", LastName: "Lee" },
  { FirstName: "Maya", LastName: "Chen" },
  { FirstName: "Kushal", LastName: "Trivedi" },
];

const CRM_LIST_PAGE_SIZE = 12;
const SALESFORCE_CRM_LOGO_SRC = "/brand/salesforce-crm-logo.svg";
const MACYS_LOGO_SRC = "/brand/macys-logo.svg";
const RESPONSIVE_ACTION_ROW_CLASSNAME = "flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap";
const RESPONSIVE_ACTION_BUTTON_CLASSNAME = "w-full justify-center sm:w-auto";
const RESPONSIVE_BADGE_ROW_CLASSNAME = "flex min-w-0 max-w-full flex-wrap items-center justify-start gap-2 sm:justify-end";
const CRM_FIELD_PLACEHOLDERS: Record<CrmProfileFieldKey, string> = {
  FirstName: "Maria",
  LastName: "Joe",
  Email: "name@example.com",
  Phone: "1234567899",
  MobilePhone: "(415) 555-1212",
  Title: "VP Sales",
  Department: "Retail Partnerships",
  MailingCity: "Dallas",
  MailingStreet: "170 O'Farrell St",
  LeadSource: "Connected Systems",
};

const CRM_PROFILE_FIELD_KEYS: CrmProfileFieldKey[] = [
  "FirstName",
  "LastName",
  "Email",
  "Phone",
  "MobilePhone",
  "Title",
  "Department",
  "MailingCity",
  "MailingStreet",
  "LeadSource",
];

const CRM_PROFILE_FIELD_METADATA: Record<CrmProfileFieldKey, CrmProfileField> = {
  FirstName: {
    key: "FirstName",
    label: "First name",
    placeholder: CRM_FIELD_PLACEHOLDERS.FirstName,
  },
  LastName: {
    key: "LastName",
    label: "Last name",
    placeholder: CRM_FIELD_PLACEHOLDERS.LastName,
  },
  Email: {
    key: "Email",
    label: "Email",
    placeholder: CRM_FIELD_PLACEHOLDERS.Email,
    inputType: "email",
  },
  Phone: {
    key: "Phone",
    label: "Phone",
    placeholder: CRM_FIELD_PLACEHOLDERS.Phone,
    inputType: "tel",
  },
  MobilePhone: {
    key: "MobilePhone",
    label: "Mobile phone",
    placeholder: CRM_FIELD_PLACEHOLDERS.MobilePhone,
    inputType: "tel",
  },
  Title: {
    key: "Title",
    label: "Title",
    placeholder: CRM_FIELD_PLACEHOLDERS.Title,
  },
  Department: {
    key: "Department",
    label: "Department",
    placeholder: CRM_FIELD_PLACEHOLDERS.Department,
  },
  MailingCity: {
    key: "MailingCity",
    label: "Mailing city",
    placeholder: CRM_FIELD_PLACEHOLDERS.MailingCity,
  },
  MailingStreet: {
    key: "MailingStreet",
    label: "Mailing street",
    placeholder: CRM_FIELD_PLACEHOLDERS.MailingStreet,
  },
  LeadSource: {
    key: "LeadSource",
    label: "Lead source",
    placeholder: CRM_FIELD_PLACEHOLDERS.LeadSource,
  },
};

const CRM_PROFILE_FIELDS: CrmProfileField[] = CRM_PROFILE_FIELD_KEYS.map(
  (key) => CRM_PROFILE_FIELD_METADATA[key]
);

const READ_ONLY_CRM_IDENTITY_FIELDS = new Set<CrmProfileFieldKey>(["Email", "Phone"]);

const DEFAULT_CRM_PROFILE_VALUES: Record<CrmProfileFieldKey, string> = {
  FirstName: "",
  LastName: "",
  Email: "",
  Phone: "",
  MobilePhone: "",
  Title: "",
  Department: "",
  MailingCity: "",
  MailingStreet: "",
  LeadSource: "",
};

function isCrmProfileFieldKey(value: unknown): value is CrmProfileFieldKey {
  return CRM_PROFILE_FIELD_KEYS.includes(value as CrmProfileFieldKey);
}

function inputTypeFromSchema(dataType?: string): string | undefined {
  const normalized = String(dataType || "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("email")) return "email";
  if (normalized.includes("phone") || normalized.includes("tel")) return "tel";
  if (normalized.includes("url")) return "url";
  return "text";
}

function crmFieldFromSchemaDescriptor(
  descriptor: NonNullable<ConnectedSystemSchemaResponse["fields"]>[number]
): CrmProfileField | null {
  if (!isCrmProfileFieldKey(descriptor.key)) return null;
  const fallback = CRM_PROFILE_FIELD_METADATA[descriptor.key];
  return {
    ...fallback,
    label: String(descriptor.label || fallback.label).trim() || fallback.label,
    inputType: inputTypeFromSchema(descriptor.dataType) || fallback.inputType,
    required: descriptor.required === true,
    rawName: String(descriptor.name || descriptor.key).trim() || descriptor.key,
    source: String(descriptor.source || "mcp_schema").trim() || "mcp_schema",
  };
}

function customerLogoSrc(system?: ConnectedSystemSummary | null): string | null {
  const customer = String(system?.customerDisplayName || system?.target || "")
    .trim()
    .toLowerCase();
  if (customer.includes("macy") || customer.includes("macys")) {
    return MACYS_LOGO_SRC;
  }
  return null;
}

function crmTypeLogoSrc(system?: ConnectedSystemSummary | null): string | null {
  const systemType = String(system?.systemType || system?.displayName || "")
    .trim()
    .toLowerCase();
  if (systemType.includes("salesforce")) {
    return SALESFORCE_CRM_LOGO_SRC;
  }
  return null;
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

function CrmTypeLogoBadge({ system }: { system?: ConnectedSystemSummary | null }) {
  const logoSrc = crmTypeLogoSrc(system);
  if (!logoSrc) return null;
  const label = [system?.systemType, system?.systemName].filter(Boolean).join(" ") || system?.displayName || "CRM";
  return (
    <span className="inline-flex h-7 w-20 items-center justify-center rounded-md border border-border/60 bg-white px-2 py-1 shadow-sm">
      <Image
        src={logoSrc}
        alt={`${label} logo`}
        width={80}
        height={28}
        className="max-h-4 w-full object-contain"
        unoptimized
      />
    </span>
  );
}

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] || items[0]!;
}

function extractRecords(result: ConnectedSystemMcpResponse | null): Record<string, unknown>[] {
  const mcp = result?.mcp;
  const payload =
    mcp && typeof mcp === "object" && "payload" in mcp
      ? ((mcp as { payload?: unknown }).payload as Record<string, unknown> | undefined)
      : undefined;
  if (!payload || typeof payload !== "object") return [];
  return collectCrmRecords(payload);
}

function looksLikeCrmRecord(record: Record<string, unknown>): boolean {
  return CRM_PROFILE_FIELD_KEYS.some((key) => key in record) ||
    ["Id", "id", "recordId", "record_id", "Name", "firstName", "lastName", "mailingCity"].some(
      (key) => key in record
    );
}

function collectCrmRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (!value || depth > 3) return [];
  if (Array.isArray(value)) {
    const directRecords = value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        looksLikeCrmRecord(item as Record<string, unknown>)
    );
    if (directRecords.length > 0) return directRecords;
    return value.flatMap((item) => collectCrmRecords(item, depth + 1));
  }
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["records", "Contact", "contacts", "data", "result", "records_"]) {
    const nested = collectCrmRecords(record[key], depth + 1);
    if (nested.length > 0) return nested;
  }
  if (looksLikeCrmRecord(record)) return [record];
  for (const nestedValue of Object.values(record)) {
    const nested = collectCrmRecords(nestedValue, depth + 1);
    if (nested.length > 0) return nested;
  }
  return [];
}

function recordIdFromRecord(record?: Record<string, unknown> | null): string {
  if (!record) return "";
  return cleanFieldValue(record.Id || record.id || record.recordId || record.record_id);
}

function selectRecordForId(
  result: ConnectedSystemMcpResponse | null,
  recordId?: string | null
): Record<string, unknown> | null {
  const records = extractRecords(result);
  if (records.length === 0) return null;
  const cleanRecordId = cleanFieldValue(recordId);
  if (!cleanRecordId) return records[0] || null;
  return records.find((record) => recordIdFromRecord(record) === cleanRecordId) || records[0] || null;
}

function extractFirstRecordId(result: ConnectedSystemMcpResponse | null): string {
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

function crmLookupPhoneCandidates(phone: string): string[] {
  const clean = cleanFieldValue(phone);
  const digits = clean.replace(/\D/g, "");
  const withoutCountryCode =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : "";
  return Array.from(new Set([clean, digits, withoutCountryCode].filter(Boolean)));
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
    error instanceof Error ? error.message : "Connected Systems request failed.";
  if (isWorkflowStorageNotReady(message)) {
    return "Record linking is temporarily unavailable.";
  }
  return message;
}

function mutationResultError(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  const resultClass =
    typeof record.resultClass === "string" ? record.resultClass.toLowerCase() : "";
  if (status !== "failed" && resultClass !== "failed") return null;
  return (
    cleanFieldValue(record.errorMessage) ||
    cleanFieldValue(record.errorCode) ||
    "Macy's CRM request failed."
  );
}

function crmValuesFromRecord(record?: Record<string, unknown> | null): Record<CrmProfileFieldKey, string> {
  const values = { ...DEFAULT_CRM_PROFILE_VALUES };
  if (!record) return values;
  for (const field of CRM_PROFILE_FIELDS) {
    values[field.key] = crmRecordFieldValue(record, field.key);
  }
  const name = cleanFieldValue(record.Name);
  if (name && !values.FirstName && !values.LastName) {
    const [firstName, ...rest] = name.split(/\s+/);
    values.FirstName = firstName || "";
    values.LastName = rest.join(" ");
  }
  return values;
}

function crmRecordFieldValue(record: Record<string, unknown>, key: CrmProfileFieldKey): string {
  const aliases: Record<CrmProfileFieldKey, string[]> = {
    FirstName: ["FirstName", "firstName", "first_name"],
    LastName: ["LastName", "lastName", "last_name"],
    Email: ["Email", "email"],
    Phone: ["Phone", "phone"],
    MobilePhone: ["MobilePhone", "mobilePhone", "mobile_phone"],
    Title: ["Title", "title"],
    Department: ["Department", "department"],
    MailingCity: ["MailingCity", "mailingCity", "mailing_city"],
    MailingStreet: ["MailingStreet", "mailingStreet", "mailing_street"],
    LeadSource: ["LeadSource", "leadSource", "lead_source"],
  };
  for (const alias of aliases[key]) {
    if (alias in record) return cleanFieldValue(record[alias]);
  }
  return "";
}

function changedFieldsFromValues(
  values: Record<CrmProfileFieldKey, string>,
  baseline: Record<CrmProfileFieldKey, string>,
  fields: CrmProfileField[]
): Record<string, string> {
  const additionalFields: Record<string, string> = {};
  for (const field of fields) {
    if (READ_ONLY_CRM_IDENTITY_FIELDS.has(field.key)) continue;
    const nextValue = values[field.key].trim();
    const previousValue = baseline[field.key].trim();
    if (nextValue !== previousValue) additionalFields[field.key] = nextValue;
  }
  return additionalFields;
}

function createAdditionalFieldsFromValues(
  values: Record<CrmProfileFieldKey, string>
): Record<string, string> {
  const additionalFields: Record<string, string> = {};
  for (const field of CRM_PROFILE_FIELDS) {
    if (["FirstName", "LastName", "Email", "Phone"].includes(field.key)) continue;
    const value = values[field.key].trim();
    if (value) additionalFields[field.key] = value;
  }
  return additionalFields;
}

export function ConnectedSystemsPanel({
  vaultOwnerToken,
  onRequestUnlock,
  mode = "detail",
  systemId,
  profile,
}: ConnectedSystemsPanelProps) {
  const [systems, setSystems] = useState<ConnectedSystemSummary[]>([]);
  const [schema, setSchema] = useState<ConnectedSystemSchemaResponse | null>(null);
  const [binding, setBinding] = useState<ConnectedSystemRecordBinding | null>(null);
  const [readResult, setReadResult] = useState<ConnectedSystemMcpResponse | null>(null);
  const [deleteResult, setDeleteResult] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState<BusyState>(null);
  const [error, setError] = useState<string | null>(null);

  const [crmFieldValues, setCrmFieldValues] = useState<Record<CrmProfileFieldKey, string>>(
    DEFAULT_CRM_PROFILE_VALUES
  );
  const [crmBaselineValues, setCrmBaselineValues] = useState<Record<CrmProfileFieldKey, string>>(
    DEFAULT_CRM_PROFILE_VALUES
  );
  const [updateId, setUpdateId] = useState("");
  const [updateReadbackEmail, setUpdateReadbackEmail] = useState("");
  const [updateReadbackPhone, setUpdateReadbackPhone] = useState("");
  const [deleteId, setDeleteId] = useState("");
  const [listSearchQuery, setListSearchQuery] = useState("");
  const [listPage, setListPage] = useState(1);
  const [bindingResolvedKey, setBindingResolvedKey] = useState<string | null>(null);
  const [autoLinkResolvedKey, setAutoLinkResolvedKey] = useState<string | null>(null);
  const [readResolvedKey, setReadResolvedKey] = useState<string | null>(null);
  const autoLinkAttemptKeyRef = useRef<string | null>(null);

  const selectedSystem =
    systems.find((system) => system.systemId === systemId) ||
    systems.find((system) => system.systemId === SALESFORCE_CRM_SYSTEM_ID) ||
    systems[0] ||
    null;
  const selectedSystemKey = selectedSystem
    ? `${selectedSystem.systemId}:${selectedSystem.objectTypeDefault || "Contact"}`
    : "";
  const supportedFields = useMemo(
    () => schema?.supportedFields || selectedSystem?.fieldAllowlist || [],
    [schema?.supportedFields, selectedSystem?.fieldAllowlist]
  );
  const canUseBackend = Boolean(vaultOwnerToken);
  const customerName = selectedSystem?.customerDisplayName || "Macy's";
  const systemType = selectedSystem?.systemType || "Salesforce";
  const systemName = selectedSystem?.systemName || "FSC";
  const systemLabel = [systemType, systemName].filter(Boolean).join(" ");
  const registeredEmail = cleanFieldValue(profile?.email);
  const registeredPhone = cleanFieldValue(profile?.phone);
  const hasRegisteredLookup = Boolean(registeredEmail && registeredPhone);
  const crmRecords = useMemo(() => extractRecords(readResult), [readResult]);
  const hasReadback = Boolean(readResult);
  const activeBinding = binding?.status === "active" ? binding : null;
  const schemaFieldSet = useMemo(() => new Set(supportedFields), [supportedFields]);
  const schemaDrivenProfileFields = useMemo(() => {
    const liveFields = Array.isArray(schema?.fields) ? schema.fields : [];
    return liveFields
      .map((field) => crmFieldFromSchemaDescriptor(field))
      .filter((field): field is CrmProfileField => Boolean(field));
  }, [schema?.fields]);
  const visibleProfileFields = useMemo(() => {
    if (schemaDrivenProfileFields.length > 0) return schemaDrivenProfileFields;
    if (schemaFieldSet.size === 0) return CRM_PROFILE_FIELDS;
    return CRM_PROFILE_FIELDS.filter((field) => schemaFieldSet.has(field.key));
  }, [schemaDrivenProfileFields, schemaFieldSet]);
  const changedProfileFields = useMemo(
    () => changedFieldsFromValues(crmFieldValues, crmBaselineValues, visibleProfileFields),
    [crmBaselineValues, crmFieldValues, visibleProfileFields]
  );
  const boundRecordId = cleanFieldValue(activeBinding?.recordId);
  const currentRecordId = useMemo(
    () => boundRecordId || updateId.trim(),
    [boundRecordId, updateId]
  );
  const hasBoundRecord = Boolean(currentRecordId);
  const hasLookup = hasRegisteredLookup;
  const currentReadRecord = useMemo(
    () => selectRecordForId(readResult, currentRecordId),
    [currentRecordId, readResult]
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
            registeredEmail,
            registeredPhone,
          ].join(":")
        : "",
    [currentRecordId, registeredEmail, registeredPhone, selectedSystem]
  );
  const bindingResolved = Boolean(selectedSystemKey && bindingResolvedKey === selectedSystemKey);
  const autoLinkKey = useMemo(
    () =>
      selectedSystem
        ? [
            selectedSystem.systemId,
            selectedSystem.objectTypeDefault || "Contact",
            registeredEmail,
            registeredPhone,
          ].join(":")
        : "",
    [registeredEmail, registeredPhone, selectedSystem]
  );
  const shouldAutoLink =
    mode === "detail" &&
    bindingResolved &&
    !activeBinding &&
    !currentRecordId &&
    hasRegisteredLookup &&
    Boolean(autoLinkKey);
  const autoLinkResolved = !shouldAutoLink || autoLinkResolvedKey === autoLinkKey;
  const boundRecordReadResolved =
    !hasBoundRecord ||
    !hasLookup ||
    readResultHasCurrentRecord ||
    Boolean(crmRecordReadKey && readResolvedKey === crmRecordReadKey);
  const isBoundRecordHydrating =
    mode === "detail" &&
    canUseBackend &&
    !error &&
    hasBoundRecord &&
    hasLookup &&
    !boundRecordReadResolved;
  const isRecordStateLoading =
    mode === "detail" &&
    canUseBackend &&
    !error &&
    (!selectedSystem || !bindingResolved || !autoLinkResolved || isBoundRecordHydrating);
  const canShowUnboundRecordActions = !hasBoundRecord && !isRecordStateLoading;
  const canShowBoundRecordActions = hasBoundRecord && !isRecordStateLoading;
  const filteredSystems = useMemo(() => {
    const query = listSearchQuery.trim().toLowerCase();
    if (!query) return systems;
    return systems.filter((system) => {
      const haystack = [
        system.displayName,
        system.customerDisplayName,
        system.systemType,
        system.systemName,
        system.target,
        system.objectTypeDefault,
        system.transportLabel,
        system.status,
        system.registrySource,
        ...(system.toolCatalog || []).map((tool) =>
          [tool.name, tool.operation, tool.description].filter(Boolean).join(" ")
        ),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [listSearchQuery, systems]);
  const listPageCount = Math.max(1, Math.ceil(filteredSystems.length / CRM_LIST_PAGE_SIZE));
  const normalizedListPage = Math.min(listPage, listPageCount);
  const pagedSystems = useMemo(() => {
    const start = (normalizedListPage - 1) * CRM_LIST_PAGE_SIZE;
    return filteredSystems.slice(start, start + CRM_LIST_PAGE_SIZE);
  }, [filteredSystems, normalizedListPage]);

  useEffect(() => {
    setListPage(1);
  }, [listSearchQuery, systems.length]);

  useEffect(() => {
    const email = cleanFieldValue(profile?.email);
    const phone = cleanFieldValue(profile?.phone);
    const displayName = cleanFieldValue(profile?.displayName);
    const [firstName, ...lastNameParts] = displayName.split(/\s+/).filter(Boolean);
    setCrmFieldValues((current) => ({
      ...current,
      FirstName: current.FirstName || firstName || "",
      LastName: current.LastName || lastNameParts.join(" "),
      Email: email,
      Phone: phone,
    }));
    setCrmBaselineValues((current) => ({
      ...current,
      FirstName: current.FirstName || firstName || "",
      LastName: current.LastName || lastNameParts.join(" "),
      Email: email,
      Phone: phone,
    }));
    setUpdateReadbackEmail(email);
    setUpdateReadbackPhone(phone);
  }, [profile?.displayName, profile?.email, profile?.phone]);

  useEffect(() => {
    if (mode !== "detail") return;
    setReadResolvedKey(null);
    setReadResult(null);
  }, [crmRecordReadKey, mode]);

  const refreshSystems = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy("systems");
    setError(null);
    try {
      setSystems(await ConnectedSystemsService.listSystems(vaultOwnerToken));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connected Systems could not load.";
      setError(message);
    } finally {
      setBusy(null);
    }
  }, [vaultOwnerToken]);

  useEffect(() => {
    void refreshSystems();
  }, [refreshSystems]);

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
      const nextBinding = response.binding?.status === "active" ? response.binding : null;
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
      if (isWorkflowStorageNotReady(err instanceof Error ? err.message : message)) {
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
    setCrmFieldValues({
      ...crmBaselineValues,
      Email: registeredEmail,
      Phone: registeredPhone,
    });
    setDeleteResult(null);
  };

  const fillRandomUpdateChange = () => {
    const change = randomItem(RANDOM_DEMO_CHANGES);
    setCrmFieldValues((current) => ({
      ...current,
      Title: cleanFieldValue(change.Title) || current.Title,
      Department: cleanFieldValue(change.Department) || current.Department,
      MailingCity: cleanFieldValue(change.MailingCity) || current.MailingCity,
      MailingStreet: cleanFieldValue(change.MailingStreet) || current.MailingStreet,
      LeadSource: cleanFieldValue(change.LeadSource) || current.LeadSource,
    }));
    setUpdateId(currentRecordId);
    setDeleteId((current) => current || currentRecordId);
    setUpdateReadbackEmail(registeredEmail);
    setUpdateReadbackPhone(registeredPhone);
  };

  const fillRandomCreateDetails = () => {
    const change = randomItem(RANDOM_DEMO_CHANGES);
    const name = randomItem(RANDOM_DEMO_NAMES);
    setCrmFieldValues((current) => ({
      ...current,
      FirstName: cleanFieldValue(name.FirstName) || current.FirstName,
      LastName: cleanFieldValue(name.LastName) || current.LastName,
      Email: registeredEmail || current.Email,
      Phone: registeredPhone || current.Phone,
      MobilePhone: current.MobilePhone || CRM_FIELD_PLACEHOLDERS.MobilePhone,
      Title: cleanFieldValue(change.Title) || current.Title,
      Department: cleanFieldValue(change.Department) || current.Department,
      MailingCity: cleanFieldValue(change.MailingCity) || current.MailingCity,
      MailingStreet: cleanFieldValue(change.MailingStreet) || current.MailingStreet,
      LeadSource: cleanFieldValue(change.LeadSource) || current.LeadSource,
    }));
  };

  async function runAction<T>(
    state: BusyState,
    action: () => Promise<T>,
    options: { showErrorToast?: boolean } = {}
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
    action: () => Promise<T>
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
      })
    );
    if (result) {
      setSchema(result);
      if (!options.silent) {
        toast.success("Salesforce CRM schema loaded.");
      }
    }
  };

  const applyReadResult = (result: ConnectedSystemMcpResponse) => {
    setReadResult(result);
    const nextBinding = result.binding?.status === "active" ? result.binding : null;
    if (nextBinding) {
      setBinding(nextBinding);
      if (nextBinding.recordId) {
        setUpdateId(nextBinding.recordId);
        setDeleteId(nextBinding.recordId);
      }
    }
    const record = selectRecordForId(
      result,
      nextBinding?.recordId || currentRecordId || result.recordId
    );
    if (record) {
      const values = crmValuesFromRecord(record);
      const identityLockedValues = {
        ...values,
        Email: registeredEmail || values.Email,
        Phone: registeredPhone || values.Phone,
      };
      setCrmFieldValues(identityLockedValues);
      setCrmBaselineValues(identityLockedValues);
    }
    const recordId = result.recordId || extractFirstRecordId(result);
    if (recordId && (nextBinding || currentRecordId)) {
      setUpdateId(recordId);
      setDeleteId(recordId);
    }
  };

  const readRecord = async (
    options: { silent?: boolean; bindSearch?: boolean; email?: string; phone?: string } = {}
  ) => {
    const result = await runAction(
      "read",
      async () => {
        const returnFields = visibleProfileFields.map((field) => field.key);
        const lookupEmail = options.email ?? registeredEmail;
        const lookupPhone = options.phone ?? registeredPhone;
        const completedReadKey =
          !options.bindSearch && selectedSystem && currentRecordId
            ? [
                selectedSystem.systemId,
                selectedSystem.objectTypeDefault || "Contact",
                currentRecordId,
                lookupEmail,
                lookupPhone,
              ].join(":")
            : "";
        const buildPayload = (phone: string) => ({
          systemId: selectedSystem?.systemId,
          objectType: selectedSystem?.objectTypeDefault || "Contact",
          email: lookupEmail,
          phone,
          returnFields,
        });
        const callRead = (phone: string) => {
          const payload = buildPayload(phone);
          return options.bindSearch
            ? ConnectedSystemsService.searchRecord(vaultOwnerToken || "", payload)
            : ConnectedSystemsService.readRecord(vaultOwnerToken || "", payload);
        };
        const phoneCandidates = crmLookupPhoneCandidates(lookupPhone);
        const firstPhone = phoneCandidates[0] || lookupPhone;
        let nextResult = await callRead(firstPhone);
        if (!options.bindSearch && extractRecords(nextResult).length === 0) {
          for (const phone of phoneCandidates) {
            nextResult = await callRead(phone);
            if (extractRecords(nextResult).length > 0) break;
          }
        }
        if (completedReadKey) setReadResolvedKey(completedReadKey);
        return nextResult;
      },
      { showErrorToast: !options.silent }
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
          toast.success("Macy's CRM record refreshed.");
        } else if (currentRecordId) {
          toast.info("Macy's record is linked, but Salesforce did not return field values.");
        } else {
          toast.info("No matching Macy's CRM record found.");
        }
      }
    }
    return result || null;
  };

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
      !hasLookup ||
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
    hasLookup,
    mode,
    readResultHasCurrentRecord,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    if (
      !vaultOwnerToken ||
      !selectedSystem ||
      mode !== "detail" ||
      !bindingResolved ||
      activeBinding ||
      currentRecordId ||
      !hasRegisteredLookup
    ) {
      return;
    }
    const attemptKey = autoLinkKey;
    if (autoLinkAttemptKeyRef.current === attemptKey) return;
    autoLinkAttemptKeyRef.current = attemptKey;
    void (async () => {
      await readRecord({
        silent: true,
        bindSearch: true,
        email: registeredEmail,
        phone: registeredPhone,
      });
      setAutoLinkResolvedKey(attemptKey);
    })();
    // readRecord is intentionally keyed by the lookup identity and route state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeBinding,
    autoLinkKey,
    bindingResolved,
    currentRecordId,
    hasRegisteredLookup,
    mode,
    registeredEmail,
    registeredPhone,
    selectedSystem,
    vaultOwnerToken,
  ]);

  const updateCrmFieldValue = (field: CrmProfileFieldKey, value: string) => {
    if (READ_ONLY_CRM_IDENTITY_FIELDS.has(field)) return;
    setCrmFieldValues((current) => ({ ...current, [field]: value }));
  };

  const createRecordFromSchema = async () => {
    const email = registeredEmail;
    const phone = registeredPhone;
    const lastName = crmFieldValues.LastName.trim();
    if (!email || !phone || !lastName) {
      toast.error("Registered email, registered phone, and last name are required to create the Macy's record.");
      return;
    }
    const additionalFields = createAdditionalFieldsFromValues(crmFieldValues);
    const result = await runMutation(
      "create",
      {
        loading: "Creating Macy's CRM record...",
        success: "Macy's CRM record created.",
        error: "Macy's CRM record could not be created.",
      },
      async () => {
        const pendingIntent = await ConnectedSystemsService.createRecordIntent(vaultOwnerToken || "", {
          systemId: selectedSystem?.systemId,
          objectType: selectedSystem?.objectTypeDefault || "Contact",
          email,
          phone,
          firstName: crmFieldValues.FirstName.trim() || undefined,
          lastName,
          additionalFields,
        });
        return ConnectedSystemsService.approveIntent({
          vaultOwnerToken: vaultOwnerToken || "",
          systemId: pendingIntent.systemId,
          intentId: pendingIntent.intentId,
        });
      }
    );
    if (result) {
      const responseBinding =
        result.binding?.status === "active" ? result.binding : null;
      const recordId = cleanFieldValue(responseBinding?.recordId || result.recordId);
      if (recordId) {
        const nextBinding: ConnectedSystemRecordBinding =
          responseBinding || {
            bindingId: null,
            systemId: result.systemId,
            target: result.target,
            objectType: result.objectType,
            recordId,
            status: "active",
            createdIntentId: result.intentId,
            lastIntentId: result.intentId,
            createdAt: result.createdAt,
            updatedAt: result.updatedAt,
          };
        setBinding(nextBinding);
        setUpdateId(recordId);
        setDeleteId(recordId);
      } else {
        await refreshBinding();
      }
      setCrmBaselineValues({
        ...crmFieldValues,
        Email: registeredEmail,
        Phone: registeredPhone,
      });
      await readRecord({ silent: true, email, phone });
    }
  };

  const updateRecordFromSchema = async () => {
    const recordId = currentRecordId;
    const additionalFields = changedProfileFields;
    const readbackEmail = registeredEmail || updateReadbackEmail;
    const readbackPhone = registeredPhone || updateReadbackPhone;
    if (Object.keys(additionalFields).length === 0) {
      toast.error("Change at least one CRM field before updating the record.");
      return;
    }
    setUpdateId(recordId);
    setUpdateReadbackEmail(registeredEmail);
    setUpdateReadbackPhone(registeredPhone);
    const result = await runMutation(
      "update",
      {
        loading: "Updating Macy's CRM record...",
        success: "Macy's CRM record updated.",
        error: "Macy's CRM update failed.",
      },
      async () => {
        const pendingIntent = await ConnectedSystemsService.updateRecordIntent(vaultOwnerToken || "", {
          systemId: selectedSystem?.systemId,
          objectType: selectedSystem?.objectTypeDefault || "Contact",
          id: recordId,
          additionalFields,
          readbackLocator:
            readbackEmail.trim() && readbackPhone.trim()
              ? {
                  email: readbackEmail,
                  phone: readbackPhone,
                }
              : undefined,
        });
        return ConnectedSystemsService.approveIntent({
          vaultOwnerToken: vaultOwnerToken || "",
          systemId: pendingIntent.systemId,
          intentId: pendingIntent.intentId,
        });
      }
    );
    if (result) {
      if (result.binding?.status === "active") {
        setBinding(result.binding);
        if (result.binding.recordId) {
          setUpdateId(result.binding.recordId);
          setDeleteId(result.binding.recordId);
        }
      }
      setCrmBaselineValues((current) => ({ ...current, ...additionalFields }));
      await refreshBinding();
      void readRecord({ silent: true });
    }
  };

  const deleteRecord = async () => {
    const result = await runMutation(
      "delete",
      {
        loading: "Deleting Macy's CRM record...",
        success: "Macy's CRM record deleted.",
        error: "Macy's CRM record could not be deleted.",
      },
      () =>
        ConnectedSystemsService.deleteRecord(vaultOwnerToken || "", {
          systemId: selectedSystem?.systemId,
          objectType: selectedSystem?.objectTypeDefault || "Contact",
          id: deleteId || currentRecordId,
        })
    );
    if (result) {
      setDeleteResult(result);
      setBinding(null);
      setReadResult(null);
      setUpdateId("");
      setDeleteId("");
      setAutoLinkResolvedKey(autoLinkKey || null);
      if (autoLinkKey) {
        autoLinkAttemptKeyRef.current = autoLinkKey;
      }
      setCrmBaselineValues(DEFAULT_CRM_PROFILE_VALUES);
      setCrmFieldValues((current) => ({
        ...DEFAULT_CRM_PROFILE_VALUES,
        Email: registeredEmail || current.Email,
        Phone: registeredPhone || current.Phone,
      }));
    }
  };

  const renderSchemaStatus = (options: { showPendingChanges?: boolean } = {}) => {
    const pendingChanges = Object.keys(changedProfileFields).length;
    const parts = [
      schema ? "Fields discovered" : "Using Contact defaults",
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

  return (
    <p className="min-w-0 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
      {parts.join(" / ")}
    </p>
  );
  };

  const renderRegisteredLookup = (buttonLabel: string) => (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          ["Registered email", registeredEmail || "Not registered"],
          ["Registered phone", registeredPhone || "Not registered"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg border border-border/60 bg-background/70 px-3 py-2.5"
          >
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {label}
            </div>
            <div className="mt-1 min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
              {value}
            </div>
          </div>
        ))}
      </div>
      {!hasRegisteredLookup ? (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
          Add a verified email and phone number to your One profile before finding a Macy's record.
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          className="w-full sm:w-auto"
          disabled={busy !== null || !hasRegisteredLookup}
          onClick={() =>
            void readRecord({
              bindSearch: true,
              email: registeredEmail,
              phone: registeredPhone,
            })
          }
        >
          <Icon
            icon={RefreshCw}
            size="sm"
            className={busy === "read" ? "mr-2 animate-spin" : "mr-2"}
          />
          {buttonLabel}
        </Button>
      </div>
    </div>
  );

  const renderCrmFieldGrid = () => (
    <div className="grid gap-3 sm:grid-cols-2">
      {visibleProfileFields.map((field) => {
        const identityField = READ_ONLY_CRM_IDENTITY_FIELDS.has(field.key);
        const identityValue =
          field.key === "Email"
            ? registeredEmail
            : field.key === "Phone"
              ? registeredPhone
              : "";
        const value = identityField
          ? identityValue || crmFieldValues[field.key]
          : crmFieldValues[field.key];
        return (
          <label key={field.key} className="min-w-0 space-y-1.5">
            <span className="flex min-w-0 flex-col gap-1 text-[12px] font-medium text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:gap-2">
              <span className="min-w-0 [overflow-wrap:anywhere]">{field.label}</span>
              {identityField ? (
                <span className="shrink-0">From One profile</span>
              ) : field.required ? (
                <span className="shrink-0">Required</span>
              ) : field.key in changedProfileFields ? (
                <span className="shrink-0">Changed</span>
              ) : null}
            </span>
            <Input
              type={field.inputType || "text"}
              value={value}
              disabled={identityField}
              onChange={(event) => updateCrmFieldValue(field.key, event.target.value)}
              placeholder={field.placeholder}
              autoComplete="off"
            />
            {crmBaselineValues[field.key] && !identityField ? (
              <span className="block min-w-0 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                Current: {displayRecordValue(crmBaselineValues[field.key])}
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );

  const renderPendingUpdatePreview = () =>
    Object.keys(changedProfileFields).length > 0 ? (
      <div className="rounded-lg bg-muted/40 p-3">
        <div className="mb-2 text-[12px] font-medium text-foreground">
          Pending update preview
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          {Object.entries(changedProfileFields).map(([field, value]) => (
            <Badge key={field} variant="secondary" className="max-w-full whitespace-normal text-left leading-5">
              {field}: {value || "Clear value"}
            </Badge>
          ))}
        </div>
      </div>
    ) : null;

  if (!canUseBackend) {
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
        <SettingsGroup
          title="CRM systems"
          description="Open a connected system to inspect the bound record and run user-approved record actions."
        >
          <div className="space-y-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <label className="sr-only" htmlFor="connected-systems-search">
              Search CRM systems
            </label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="connected-systems-search"
                type="search"
                value={listSearchQuery}
                onChange={(event) => setListSearchQuery(event.target.value)}
                placeholder="Search by CRM, customer, target, or status"
                className="pl-9"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {filteredSystems.length} CRM system{filteredSystems.length === 1 ? "" : "s"}
              </span>
              {filteredSystems.length > CRM_LIST_PAGE_SIZE ? (
                <span>
                  Page {normalizedListPage} of {listPageCount}
                </span>
              ) : null}
            </div>
          </div>
          {systems.length === 0 && busy === "systems" ? (
            <SettingsRow
              icon={RefreshCw}
              title="Loading connected systems"
              description="Fetching CRM systems configured for this One account."
              trailing={<Icon icon={RefreshCw} size="sm" className="animate-spin" />}
              stackTrailingOnMobile
            />
          ) : null}
          {systems.length === 0 && busy !== "systems" ? (
            <SettingsRow
              icon={Database}
              title="No connected CRM systems"
              description="Refresh to check the Customer 0 Salesforce CRM MCP registry."
              trailing={
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void refreshSystems()}
                >
                  <Icon
                    icon={RefreshCw}
                    size="sm"
                  />
                </Button>
              }
              stackTrailingOnMobile
            />
          ) : null}
          {systems.length > 0 && filteredSystems.length === 0 ? (
            <SettingsRow
              icon={Search}
              title="No matching CRM systems"
              description="Try a different customer, CRM type, target, or status."
              stackTrailingOnMobile
            />
          ) : null}
          {pagedSystems.map((system) => {
            const systemCustomer = system.customerDisplayName || system.target || "Customer";
            const typeLabel = [system.systemType, system.systemName].filter(Boolean).join(" ");
            return (
              <SettingsRow
                key={system.systemId}
                asChild
                leading={<ConnectedSystemLogo system={system} />}
                title={system.displayName || "CRM system"}
                description={`${systemCustomer} / ${
                  system.objectTypeDefault || "Contact"
                } / ${system.transportLabel || "External CRM MCP"}`}
                trailing={
                  <div className={RESPONSIVE_BADGE_ROW_CLASSNAME}>
                    <CrmTypeLogoBadge system={system} />
                    <Badge variant="secondary" className="max-w-full whitespace-normal text-left">
                      {statusBadge(system.status)}
                    </Badge>
                    {typeLabel ? (
                      <Badge variant="secondary" className="max-w-full whitespace-normal text-left">
                        {typeLabel}
                      </Badge>
                    ) : null}
                    {system.toolCatalog?.length ? (
                      <Badge variant="secondary" className="max-w-full whitespace-normal text-left">
                        {system.toolCatalog.length} MCP tools
                      </Badge>
                    ) : null}
                  </div>
                }
                chevron
                stackTrailingOnMobile
              >
                <Link href={buildConnectedSystemRoute(system.systemId)} />
              </SettingsRow>
            );
          })}
          {filteredSystems.length > CRM_LIST_PAGE_SIZE ? (
            <div className="flex flex-wrap items-center justify-between gap-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                disabled={normalizedListPage <= 1}
                onClick={() => setListPage((page) => Math.max(1, page - 1))}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                {Math.min(filteredSystems.length, (normalizedListPage - 1) * CRM_LIST_PAGE_SIZE + 1)}
                -
                {Math.min(filteredSystems.length, normalizedListPage * CRM_LIST_PAGE_SIZE)} of{" "}
                {filteredSystems.length}
              </span>
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                disabled={normalizedListPage >= listPageCount}
                onClick={() => setListPage((page) => Math.min(listPageCount, page + 1))}
              >
                Next
              </Button>
            </div>
          ) : null}
        </SettingsGroup>

        {error ? (
          <SurfaceInset className="px-3.5 py-3.5 text-sm text-destructive sm:px-4 sm:py-4">
            {error}
          </SurfaceInset>
        ) : null}

        <SettingsGroup title="Actions">
          <SettingsRow
            icon={RefreshCw}
            title="Refresh CRM systems"
            description="Reload the connected-system registry and status from the backend."
            disabled={busy !== null}
            chevron
            onClick={() => void refreshSystems()}
          />
        </SettingsGroup>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <SurfaceInset className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
            <ConnectedSystemLogo system={selectedSystem} size="hero" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                CRM system
              </p>
              <h2 className="text-lg font-semibold tracking-normal text-foreground [overflow-wrap:anywhere]">
                {customerName}
              </h2>
              <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                {systemLabel || selectedSystem?.displayName || "Salesforce CRM"} /{" "}
                {selectedSystem?.objectTypeDefault || "Contact"}.
              </p>
            </div>
          </div>
          <div className="min-w-0 text-left text-xs leading-5 text-muted-foreground md:max-w-[18rem] md:text-right">
            <CrmTypeLogoBadge system={selectedSystem} />
            <div className="mt-2 [overflow-wrap:anywhere]">
              {statusBadge(selectedSystem?.status || "connected")} through{" "}
              {selectedSystem?.transportLabel || "External CRM MCP"}
              {selectedSystem?.toolCatalog?.length
                ? ` / ${selectedSystem.toolCatalog.length} MCP tools`
                : ""}
            </div>
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
            trailing={<Icon icon={RefreshCw} size="sm" className="animate-spin" />}
            stackTrailingOnMobile
          />
        </SettingsGroup>
      ) : null}

      {canShowUnboundRecordActions ? (
        <SettingsGroup title="Find existing record">
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            {renderSchemaStatus()}
            {renderRegisteredLookup("Find my record")}
          </div>
        </SettingsGroup>
      ) : null}

      {canShowUnboundRecordActions ? (
        <SettingsGroup title={`Create my ${customerName} record`}>
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {renderSchemaStatus()}
              <div className={RESPONSIVE_ACTION_ROW_CLASSNAME}>
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  size="sm"
                  className={RESPONSIVE_ACTION_BUTTON_CLASSNAME}
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
                  className={RESPONSIVE_ACTION_BUTTON_CLASSNAME}
                  disabled={busy !== null}
                  onClick={fillRandomCreateDetails}
                >
                  <Icon icon={Shuffle} size="sm" className="mr-2" />
                  Suggest sample details
                </Button>
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  size="sm"
                  className={RESPONSIVE_ACTION_BUTTON_CLASSNAME}
                  disabled={busy !== null}
                  onClick={() => void loadSchema()}
                >
                  <Icon icon={ListChecks} size="sm" className="mr-2" />
                  {schema ? "Refresh fields" : "Discover fields"}
                </Button>
              </div>
            </div>
            {renderCrmFieldGrid()}
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                className="w-full sm:w-auto"
                disabled={
                  busy !== null ||
                  !hasRegisteredLookup ||
                  !crmFieldValues.LastName.trim()
                }
                onClick={() => void createRecordFromSchema()}
              >
                <Icon
                  icon={SendHorizontal}
                  size="sm"
                  className={busy === "create" ? "mr-2 animate-pulse" : "mr-2"}
                />
                {busy === "create" ? "Creating..." : "Create record"}
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
              <div className={RESPONSIVE_ACTION_ROW_CLASSNAME}>
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  size="sm"
                  className={RESPONSIVE_ACTION_BUTTON_CLASSNAME}
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
                  className={RESPONSIVE_ACTION_BUTTON_CLASSNAME}
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
                  className={RESPONSIVE_ACTION_BUTTON_CLASSNAME}
                  disabled={busy !== null || !hasLookup}
                  onClick={() => void readRecord()}
                >
                  <Icon icon={RefreshCw} size="sm" className="mr-2" />
                  Refresh
                </Button>
              </div>
            </div>
            {renderCrmFieldGrid()}
            {renderPendingUpdatePreview()}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <Button
                type="button"
                variant="none"
                effect="fade"
                size="sm"
                className={RESPONSIVE_ACTION_BUTTON_CLASSNAME}
                disabled={busy !== null}
                onClick={fillRandomUpdateChange}
              >
                <Icon icon={Shuffle} size="sm" className="mr-2" />
                Suggest a sample change
              </Button>
              <Button
                type="button"
                size="sm"
                className={RESPONSIVE_ACTION_BUTTON_CLASSNAME}
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

      {canShowBoundRecordActions ? (
        <SettingsGroup title="Delete record">
          <SettingsRow
            icon={Trash2}
            title={`Delete ${customerName} Contact`}
            description={`Remove record ${currentRecordId} from ${customerName} Salesforce CRM.`}
            trailing={
              <div className={RESPONSIVE_BADGE_ROW_CLASSNAME}>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      size="sm"
                      className={RESPONSIVE_ACTION_BUTTON_CLASSNAME}
                      disabled={busy !== null || !(deleteId || currentRecordId)}
                    >
                      <Icon icon={Trash2} size="sm" className="mr-2" />
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this CRM record?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This deletes the Salesforce Contact in {customerName}. The One binding will be cleared after the MCP confirms deletion.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={busy === "delete"}>Cancel</AlertDialogCancel>
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
          Delete request returned {statusBadge(String(deleteResult.resultClass || "completed"))}.
        </SurfaceInset>
      ) : null}
    </div>
  );
}

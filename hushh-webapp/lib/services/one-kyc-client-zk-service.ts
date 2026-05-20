"use client";

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import type { PkmWriteCoordinatorResult } from "@/lib/services/pkm-write-coordinator";
import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";
import { OneKycService } from "@/lib/services/one-kyc-service";
import { bytesToBase64 } from "@/lib/vault/base64";

export const KYC_CONNECTOR_PKM_DOMAIN = "kyc_connector" as const;
export const KYC_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM" as const;

export type KycClientConnectorPrivateRecord = {
  connector_key_id: string;
  connector_public_key: string;
  connector_private_key: string;
  connector_private_key_format: "pkcs8";
  connector_wrapping_alg: typeof KYC_CONNECTOR_WRAPPING_ALG;
  public_key_fingerprint: string;
  created_at: string;
};

export type KycScopedExportPackage = {
  status?: string;
  encrypted_data: string;
  iv: string;
  tag: string;
  wrapped_key_bundle: {
    wrapped_export_key: string;
    wrapped_key_iv: string;
    wrapped_key_tag: string;
    sender_public_key: string;
    wrapping_alg?: string;
    connector_key_id?: string;
  };
  scope?: string;
  request_id?: string;
  export_revision?: number;
  export_generated_at?: string;
  export_refresh_status?: string;
};

export type KycDraftBuildResult = {
  subject: string;
  body: string;
  htmlBody: string;
  approvedValues: Record<string, string>;
  missingFields: string[];
  renderModel: KycDraftRenderModel;
  scopeSummaries: Array<{
    scope: string;
    approvedFields: string[];
    missingFields: string[];
  }>;
  draftHash: string;
};

type KycDraftExportPayload = {
  scope?: string | null;
  payload: Record<string, unknown>;
};

export type KycDraftStyle = {
  compact: boolean;
  formal: boolean;
  bulletList: boolean;
  structured: boolean;
  table: boolean;
  fullDetail: boolean;
  human: boolean;
  cleanHeaders: boolean;
};

export type KycDraftRenderEntry = {
  field: string;
  label: string;
  value: string;
  scope: string;
};

export type KycDraftRenderSection = {
  scope: string;
  title: string;
  entries: KycDraftRenderEntry[];
  missingFields: string[];
};

export type KycDraftRenderModel = {
  accountHolder: string;
  style: KycDraftStyle;
  sections: KycDraftRenderSection[];
  missingFields: string[];
};

const MAX_DRAFT_BODY_LENGTH = 12000;

const EMAIL_THEME = {
  accent: "#D4A847",
  accentBorder: "#E7C969",
  background: "#18181b",
  border: "#3f3f46",
  card: "#242426",
  chip: "#2f3033",
  heading: "#f8fafc",
  muted: "#a1a1aa",
  panel: "#1f2023",
  text: "#e5e7eb",
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64ToBytesCompat(value: string | undefined | null): Uint8Array {
  if (!value) return new Uint8Array();
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4) normalized += "=";
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Bytes(value: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    value instanceof Uint8Array ? toArrayBuffer(value) : value
  );
  return new Uint8Array(digest);
}

function normalizeFieldKey(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function truncate(value: unknown, limit = 500): string | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, limit) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const INTERNAL_APPROVED_VALUE_KEYS = new Set([
  "__export_metadata",
  "analyze_eligible",
  "analyze_eligible_reason",
  "artifact_id",
  "basis_codes",
  "changes",
  "confidence",
  "created_at",
  "deterministic_projection_hash",
  "domain_intent",
  "enrichment_hash",
  "entities",
  "entity_id",
  "identifier_type",
  "is_sec_common_equity_ticker",
  "is_short_position",
  "latest_receipt_updated_at",
  "manifest",
  "metadata",
  "metadata_confidence",
  "optimize_eligible",
  "parse_context",
  "parse_fallback",
  "pending_delete",
  "provenance",
  "raw_extract_v2",
  "receipt_count_used",
  "schema_version",
  "security_listing_status",
  "signal_id",
  "source",
  "source_id",
  "source_kind",
  "source_label",
  "source_metadata",
  "sources",
  "status",
  "symbol_cusip",
  "symbol_kind",
  "symbol_quality",
  "symbol_source",
  "symbol_trust_reason",
  "symbol_trust_tier",
  "tradable",
  "updated_at",
]);

const SENSITIVE_APPROVED_VALUE_KEYS = new Set([
  "account_number",
  "routing_number",
  "ssn",
  "tax_id",
  "tax_identifier",
]);

function normalizedObjectKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isInternalApprovedKey(key: string): boolean {
  return INTERNAL_APPROVED_VALUE_KEYS.has(normalizedObjectKey(key));
}

function isSensitiveByDefaultKey(key: string): boolean {
  return SENSITIVE_APPROVED_VALUE_KEYS.has(normalizedObjectKey(key));
}

function shouldDisplayApprovedKey(key: string): boolean {
  return !isInternalApprovedKey(key) && !isSensitiveByDefaultKey(key);
}

function getRecordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
      return record[key];
    }
  }
  const normalizedKeys = new Set(keys.map(normalizedObjectKey));
  for (const [key, value] of Object.entries(record)) {
    if (normalizedKeys.has(normalizedObjectKey(key)) && value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,]/g, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatCurrencyValue(value: unknown): string | null {
  const numberValue = toFiniteNumber(value);
  if (numberValue === null) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(numberValue);
}

function formatNumberValue(value: unknown): string | null {
  const numberValue = toFiniteNumber(value);
  if (numberValue === null) return null;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(numberValue);
}

function formatDateTimeValue(value: string): string | null {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function shouldHumanizeScalarString(key: string | undefined, value: string): boolean {
  if (!key) return false;
  const normalized = normalizedObjectKey(key);
  if (
    normalized.includes("symbol") ||
    normalized.includes("ticker") ||
    normalized.includes("email") ||
    normalized.includes("url")
  ) {
    return false;
  }
  if (value.includes("_")) return /^[a-z0-9_]+$/i.test(value);
  return (
    /^(investment_horizon|risk_profile|drawdown_response|volatility_preference)$/.test(
      normalized
    ) && /^[a-z0-9 -]+$/i.test(value)
  );
}

function keyLooksFinancialAmount(key: string): boolean {
  const normalized = normalizedObjectKey(key);
  return (
    normalized.includes("balance") ||
    normalized.includes("basis") ||
    normalized.includes("cash") ||
    normalized.includes("fee") ||
    normalized.includes("gain") ||
    normalized.includes("income") ||
    normalized.includes("loss") ||
    normalized.includes("market_value") ||
    normalized.includes("price") ||
    normalized.includes("total_value") ||
    normalized.includes("value")
  );
}

function formatScalarValue(value: unknown, key?: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    if (key && keyLooksFinancialAmount(key)) return formatCurrencyValue(value);
    return formatNumberValue(value);
  }
  if (typeof value === "string") {
    const formattedDate = formatDateTimeValue(value);
    if (formattedDate) return formattedDate;
    const text = truncate(value);
    if (text && shouldHumanizeScalarString(key, text)) {
      return sentenceCase(approvedHumanLabel(text));
    }
    return text;
  }
  return truncate(value);
}

function formatHoldingLine(value: unknown): string | null {
  if (!isRecord(value)) return formatApprovedValue(value);
  const symbol = truncate(getRecordValue(value, ["symbol", "ticker", "security_symbol"]), 40);
  const name = truncate(getRecordValue(value, ["name", "security_name", "instrument_name"]), 80);
  const label = symbol || name;
  if (!label) return null;

  const normalizedSymbol = String(symbol || "").trim().toUpperCase();
  const marketValue = formatCurrencyValue(
    getRecordValue(value, ["market_value", "value", "total_value"])
  );
  const quantity = formatNumberValue(getRecordValue(value, ["quantity", "shares", "units"]));
  const pricePerUnit = formatCurrencyValue(
    getRecordValue(value, ["price_per_unit", "price", "unit_price"])
  );
  const unrealizedGainLoss = formatCurrencyValue(
    getRecordValue(value, ["unrealized_gain_loss", "gain_loss"])
  );
  const assetType = truncate(getRecordValue(value, ["asset_type", "instrument_kind", "type"]), 80);

  if (normalizedSymbol === "CASH" && marketValue) {
    return `Cash: ${marketValue}`;
  }

  const details: string[] = [];
  if (quantity) details.push(`${quantity} shares`);
  if (marketValue) details.push(`${marketValue} value`);
  if (pricePerUnit) details.push(`${pricePerUnit} per share`);
  if (unrealizedGainLoss) details.push(`${unrealizedGainLoss} unrealized gain/loss`);
  if (assetType) details.push(assetType);
  if (!details.length) return label;
  return `${label}: ${details.join("; ")}`;
}

function approvedHumanLabel(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " ");
}

function formatEntityCollection(value: unknown): string | null {
  const items = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.values(value)
      : [];
  const lines = items
    .map((item) => {
      if (isRecord(item)) {
        return preferredObjectText(item) || formatApprovedValue(item);
      }
      return formatApprovedValue(item);
    })
    .filter((item): item is string => Boolean(item))
    .filter((item, index, all) => all.indexOf(item) === index);
  if (!lines.length) return null;
  return lines.join("\n");
}

function preferredObjectText(value: Record<string, unknown>): string | null {
  const active = value.active;
  if (isRecord(active)) {
    const activeText = preferredObjectText(active) || formatApprovedValue(active);
    if (activeText) return activeText;
  }
  const entityText = formatEntityCollection(value.entities);
  if (entityText) return entityText;

  const directKeys = ["summary", "text", "label", "description"];
  for (const key of directKeys) {
    const direct = value[key];
    if (typeof direct === "string" || typeof direct === "number" || typeof direct === "boolean") {
      const text = formatScalarValue(direct, key);
      if (text) return text;
    }
  }
  const visibleKeys = Object.keys(value).filter(shouldDisplayApprovedKey);
  if (visibleKeys.length === 1) {
    const direct = value.value;
    if (typeof direct === "string" || typeof direct === "number" || typeof direct === "boolean") {
      const text = formatScalarValue(direct, "value");
      if (text) return text;
    }
  }

  const readableSummary = value.readable_summary || value.readableSummary;
  if (isRecord(readableSummary)) {
    const text = truncate(readableSummary.text);
    if (text) return text;
  }

  const observations = value.observations;
  if (Array.isArray(observations)) {
    const text = truncate(observations.map((item) => formatApprovedValue(item)).filter(Boolean).join(", "));
    if (text) return text;
  }

  return null;
}

function formatApprovedValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return formatScalarValue(value);
  }
  if (Array.isArray(value)) {
    if (value.every((item) => !item || typeof item !== "object")) {
      return truncate(value.map((item) => formatApprovedValue(item)).filter(Boolean).join(", "));
    }
    const lines = value.map(formatHoldingLine).filter(Boolean);
    if (lines.length) {
      return `${value.length} item${value.length === 1 ? "" : "s"}:\n${lines.map((line) => `- ${line}`).join("\n")}`;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = preferredObjectText(record);
    if (preferred) return preferred;
    const parts = Object.entries(record)
      .filter(([key]) => shouldDisplayApprovedKey(key))
      .map(([key, item]) => {
        const formatted =
          typeof item === "string" || typeof item === "number" || typeof item === "boolean"
            ? formatScalarValue(item, key)
            : formatApprovedValue(item);
        return formatted ? `${approvedHumanLabel(key)}: ${formatted}` : null;
      })
      .filter(Boolean);
    return truncate(parts.join(parts.some((part) => String(part).includes("\n")) ? "\n" : "; "), 4000);
  }
  return null;
}

function formatPortfolioApprovedValue(value: unknown): string | null {
  const portfolio = Array.isArray(value) ? { holdings: value } : isRecord(value) ? value : null;
  if (!portfolio) return formatApprovedValue(value);

  const accountInfo = isRecord(portfolio.account_info)
    ? portfolio.account_info
    : isRecord(portfolio.accountInfo)
      ? portfolio.accountInfo
      : {};
  const accountSummary = isRecord(portfolio.account_summary)
    ? portfolio.account_summary
    : {};
  const holderName = truncate(getRecordValue(accountInfo, ["holder_name", "account_holder_name"]), 120);
  const beginningValue = formatCurrencyValue(getRecordValue(accountSummary, ["beginning_value"]));
  const totalValue =
    formatCurrencyValue(getRecordValue(portfolio, ["total_value", "market_value"])) ||
    formatCurrencyValue(getRecordValue(accountSummary, ["ending_value", "total_value"]));
  const cashBalance =
    formatCurrencyValue(getRecordValue(portfolio, ["cash_balance"])) ||
    formatCurrencyValue(getRecordValue(accountSummary, ["cash_balance"]));
  const changeInValue = formatCurrencyValue(getRecordValue(accountSummary, ["change_in_value"]));
  const netDepositsWithdrawals = formatCurrencyValue(
    getRecordValue(accountSummary, ["net_deposits_withdrawals"])
  );
  const investmentGainLoss = formatCurrencyValue(
    getRecordValue(accountSummary, ["investment_gain_loss", "gain_loss", "change_in_value"])
  );
  const totalFees = formatCurrencyValue(getRecordValue(accountSummary, ["total_fees", "fees"]));
  const totalIncomePeriod = formatCurrencyValue(getRecordValue(accountSummary, ["total_income_period"]));
  const totalIncomeYtd = formatCurrencyValue(getRecordValue(accountSummary, ["total_income_ytd"]));

  const summaryLines: string[] = [];
  if (holderName) summaryLines.push(`- Account name: ${holderName}`);
  if (beginningValue) summaryLines.push(`- Beginning value: ${beginningValue}`);
  if (totalValue) summaryLines.push(`- Total value: ${totalValue}`);
  if (cashBalance) summaryLines.push(`- Cash balance: ${cashBalance}`);
  if (changeInValue) summaryLines.push(`- Change in value: ${changeInValue}`);
  if (netDepositsWithdrawals) {
    summaryLines.push(`- Net deposits/withdrawals: ${netDepositsWithdrawals}`);
  }
  if (investmentGainLoss) summaryLines.push(`- Investment gain/loss: ${investmentGainLoss}`);
  if (totalFees) summaryLines.push(`- Fees: ${totalFees}`);
  if (totalIncomePeriod) summaryLines.push(`- Income this period: ${totalIncomePeriod}`);
  if (totalIncomeYtd) summaryLines.push(`- Income year to date: ${totalIncomeYtd}`);

  const holdings = Array.isArray(portfolio.holdings) ? portfolio.holdings : [];
  if (holdings.length) summaryLines.push(`- Holdings: ${holdings.length}`);
  const holdingLines = holdings.map(formatHoldingLine).filter(Boolean);
  const sections: string[] = [];
  if (summaryLines.length) sections.push(["Portfolio summary", ...summaryLines].join("\n"));
  if (holdingLines.length) {
    sections.push(["Holdings", ...holdingLines.map((line) => `- ${line}`)].join("\n"));
  }
  if (sections.length) return sections.join("\n\n");
  return formatApprovedValue(portfolio);
}

function formatRecordBullets(value: Record<string, unknown>): string[] {
  return Object.entries(value)
    .filter(([key]) => shouldDisplayApprovedKey(key))
    .map(([key, item]) => {
      const formatted =
        typeof item === "string" || typeof item === "number" || typeof item === "boolean"
          ? formatScalarValue(item, key)
          : formatApprovedValue(item);
      return formatted ? `- ${approvedHumanLabel(key)}: ${formatted}` : null;
    })
    .filter((item): item is string => Boolean(item));
}

function addRecordBullet(
  lines: string[],
  record: Record<string, unknown>,
  keys: string[],
  label: string,
  formatter: (value: unknown, key?: string) => string | null = formatScalarValue
): void {
  const value = getRecordValue(record, keys);
  const formatted = formatter(value, keys[0]);
  if (formatted) lines.push(`- ${label}: ${formatted}`);
}

function formatFinancialProfileApprovedValue(value: unknown): string | null {
  const profile = isRecord(value) ? value : null;
  if (!profile) return formatApprovedValue(value);
  const preferences = isRecord(profile.preferences)
    ? profile.preferences
    : isRecord(profile.profile_preferences)
      ? profile.profile_preferences
      : profile;
  const lines: string[] = [];
  addRecordBullet(lines, preferences, ["risk_profile", "riskProfile"], "Risk profile");
  addRecordBullet(lines, preferences, ["risk_score", "riskScore"], "Risk score");
  addRecordBullet(
    lines,
    preferences,
    ["investment_horizon", "investmentHorizon"],
    "Investment horizon"
  );
  addRecordBullet(
    lines,
    preferences,
    ["drawdown_response", "drawdownResponse"],
    "Drawdown response"
  );
  addRecordBullet(
    lines,
    preferences,
    ["volatility_preference", "volatilityPreference"],
    "Volatility preference"
  );
  const updatedAt =
    getRecordValue(preferences, ["updated_at", "updatedAt"]) ||
    getRecordValue(profile, ["updated_at", "updatedAt"]);
  const formattedUpdatedAt = formatScalarValue(updatedAt, "updated_at");
  if (formattedUpdatedAt) lines.push(`- Last updated: ${formattedUpdatedAt}`);

  if (lines.length) return ["Financial profile", ...lines].join("\n");
  const fallback = formatRecordBullets(profile);
  return fallback.length ? ["Financial profile", ...fallback].join("\n") : null;
}

function formatFinancialApprovedValue(value: unknown): string | null {
  const financial = isRecord(value) ? value : null;
  if (!financial) return formatApprovedValue(value);

  const sections: string[] = [];
  const profile = isRecord(financial.financial_profile)
    ? financial.financial_profile
    : isRecord(financial.financialProfile)
      ? financial.financialProfile
      : isRecord(financial.profile)
        ? financial.profile
        : null;
  if (profile) {
    const profileText = formatFinancialProfileApprovedValue(profile);
    if (profileText) sections.push(profileText);
  }

  const portfolioValue =
    financial.portfolio ||
    financial.investment_holdings ||
    financial.investments ||
    (Array.isArray(financial.holdings) ? financial : null);
  const portfolio = formatPortfolioApprovedValue(portfolioValue);
  if (portfolio) sections.push(portfolio);

  const documents = isRecord(financial.financial_documents)
    ? financial.financial_documents
    : isRecord(financial.documents)
      ? financial.documents
      : null;
  if (documents) {
    const documentLines = formatRecordBullets(documents);
    if (documentLines.length) sections.push(["Financial documents", ...documentLines].join("\n"));
  }

  if (sections.length) return sections.join("\n\n");
  return formatApprovedValue(financial);
}

function formatApprovedFieldValue(params: {
  field: string;
  value: unknown;
  scope?: string | null;
}): string | null {
  const normalizedField = normalizedObjectKey(params.field);
  if (normalizedField === "portfolio" || params.scope?.includes("financial.portfolio")) {
    return formatPortfolioApprovedValue(params.value);
  }
  if (
    normalizedField === "financial_profile" &&
    isRecord(params.value) &&
    !params.value.portfolio &&
    !params.value.financial_profile &&
    !params.value.financialProfile
  ) {
    return formatFinancialProfileApprovedValue(params.value);
  }
  if (
    normalizedField === "financial_profile" ||
    normalizedField === "financial_information" ||
    params.scope === "attr.financial.*"
  ) {
    return formatFinancialApprovedValue(params.value);
  }
  return formatApprovedValue(params.value);
}

function financialScopeField(scope: string | null | undefined): string | null {
  const normalizedScope = String(scope || "");
  const path = scopePath(scope);
  const primary = path?.split(".")[0] || "";
  if (normalizedScope.includes("financial.portfolio") || primary === "portfolio") {
    return "portfolio";
  }
  if (
    normalizedScope.includes("financial.documents") ||
    primary === "documents" ||
    primary === "financial_documents"
  ) {
    return "financial_documents";
  }
  if (
    normalizedScope.includes("financial.profile") ||
    primary === "profile" ||
    primary === "financial_profile"
  ) {
    return "financial_profile";
  }
  return null;
}

function scopeDomain(scope: string | null | undefined): string | null {
  const parts = String(scope || "").split(".");
  return parts.length >= 2 && parts[0] === "attr" && parts[1] ? parts[1] : null;
}

function scopePath(scope: string | null | undefined): string | null {
  const parts = String(scope || "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 2 || parts[0] !== "attr") return null;
  const pathParts = parts.slice(2);
  if (pathParts[pathParts.length - 1] === "*") pathParts.pop();
  return pathParts.length ? pathParts.join(".") : null;
}

function scopePrimaryField(scope: string | null | undefined): string | null {
  const path = scopePath(scope);
  if (path) return path.split(".")[0] || null;
  const domain = scopeDomain(scope);
  return domain && domain !== "identity" && domain !== "financial"
    ? `${domain}_information`
    : null;
}

function humanizeField(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " ");
}

function flattenApprovedValues(
  value: unknown,
  prefix = "",
  result: Record<string, string> = {}
): Record<string, string> {
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!shouldDisplayApprovedKey(key)) continue;
    const field = prefix ? `${prefix}_${key}` : key;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const formatted = formatApprovedFieldValue({ field, value: item });
      if (formatted) result[field] = formatted;
      else flattenApprovedValues(item, field, result);
      continue;
    }
    const formatted = formatApprovedFieldValue({ field, value: item });
    if (formatted) result[field] = formatted;
  }
  return result;
}

function findApprovedValue(
  value: unknown,
  aliases: string[],
  field: string,
  scope?: string | null
): string | null {
  const normalizedAliases = new Set(aliases.map(normalizeFieldKey));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!shouldDisplayApprovedKey(key)) continue;
      if (normalizedAliases.has(normalizeFieldKey(key))) {
        const formatted = formatApprovedFieldValue({ field, value: item, scope });
        if (formatted) return formatted;
      }
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!shouldDisplayApprovedKey(key)) continue;
      const nested = findApprovedValue(item, aliases, field, scope);
      if (nested) return nested;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findApprovedValue(item, aliases, field, scope);
      if (nested) return nested;
    }
  }
  return null;
}

function extractApprovedValues(params: {
  payload: Record<string, unknown>;
  requiredFields: string[];
  scope?: string | null;
}): { approvedValues: Record<string, string>; missingFields: string[] } {
  const aliases: Record<string, string[]> = {
    full_name: ["full_name", "fullName", "legal_name", "legalName", "name", "display_name"],
    date_of_birth: ["date_of_birth", "dateOfBirth", "dob", "birth_date", "birthDate"],
    address: ["address", "residential_address", "residentialAddress", "mailing_address"],
    phone_number: ["phone_number", "phoneNumber", "phone", "mobile", "telephone"],
    email: ["email", "email_address", "emailAddress"],
    tax_residency: ["tax_residency", "taxResidency", "tax_residence", "taxResidence"],
    nationality: ["nationality", "citizenship"],
    employment: ["employment", "occupation", "employer"],
    source_of_funds: ["source_of_funds", "sourceOfFunds", "source_of_wealth"],
    brokerage_profile: ["brokerage_profile", "brokerageProfile", "trading_experience"],
    identity_profile: ["identity", "profile", "identity_profile", "identityProfile"],
    financial_profile: [
      "financial_profile",
      "financialProfile",
      "financial_information",
      "financialInformation",
      "profile",
      "net_worth",
      "netWorth",
      "assets",
      "liabilities",
    ],
    portfolio: ["portfolio", "holdings", "investment_holdings", "investments", "positions"],
    financial_documents: ["financial_documents", "financialDocuments", "statements", "documents"],
    favorite_locations: [
      "favorite_locations",
      "favoriteLocations",
      "favourite_locations",
      "favouriteLocations",
      "favorite_places",
      "favourite_places",
      "locations",
      "places",
      "destinations",
    ],
    locations: ["locations", "places", "destinations", "favorite_locations"],
    seat_preferences: [
      "seat_preferences",
      "seatPreferences",
      "seat_preference",
      "seatPreference",
      "preferred_seat",
      "preferredSeat",
      "preferred_seats",
      "preferredSeats",
      "travel_preference_seat",
      "travelPreferenceSeat",
      "summary",
      "observations",
    ],
    preferences: [
      "preferences",
      "favorites",
      "favourites",
      "summary",
      "readable_summary",
      "readableSummary",
      "text",
      "observations",
      "favorite_locations",
      "favoriteLocations",
      "favourite_locations",
      "favouriteLocations",
      "favorite_places",
      "favourite_places",
      "locations",
      "places",
      "destinations",
      "travel_preferences",
      "travelPreferences",
    ],
  };
  const broadPreferenceAliases = [
    "seat_preferences",
    "seatPreferences",
    "seat_preference",
    "seatPreference",
    "travel_preferences",
    "travelPreferences",
    "entities",
  ];
  const domain = scopeDomain(params.scope);
  const sourceKey =
    domain === "financial" ? "financial" : domain === "identity" ? "identity" : domain;
  const source =
    sourceKey && params.payload[sourceKey] && typeof params.payload[sourceKey] === "object"
      ? (params.payload[sourceKey] as Record<string, unknown>)
      : params.payload;
  const approvedValues: Record<string, string> = {};
  const missingFields: string[] = [];
  if (domain && domain !== "identity" && domain !== "financial" && !scopePath(params.scope)) {
    const formatted = formatApprovedFieldValue({
      field: `${domain}_information`,
      value: source,
      scope: params.scope,
    });
    if (formatted) {
      approvedValues[`${domain}_information`] = formatted;
      return { approvedValues, missingFields };
    }
  }
  const fields = fieldsForScope(params.scope, params.requiredFields);
  if (!fields.length) {
    return { approvedValues: flattenApprovedValues(source), missingFields };
  }
  for (const field of fields) {
    let value = findApprovedValue(source, aliases[field] || [field], field, params.scope);
    if (!value && field === "preferences") {
      value = findApprovedValue(source, broadPreferenceAliases, field, params.scope);
    }
    if (value) approvedValues[field] = value;
    else missingFields.push(field);
  }
  if (!Object.keys(approvedValues).length && domain && domain !== "identity") {
    const fallbackField =
      domain === "financial" ? "financial_information" : `${domain}_information`;
    const fallback = formatApprovedFieldValue({
      field: fallbackField,
      value: source,
      scope: params.scope,
    });
    if (fallback) {
      approvedValues[fallbackField] = fallback;
      return { approvedValues, missingFields: [] };
    }
  }
  return { approvedValues, missingFields };
}

const FINANCIAL_FIELDS = new Set([
  "financial_information",
  "financial_profile",
  "portfolio",
  "financial_documents",
]);
const IDENTITY_FIELDS = new Set([
  "full_name",
  "date_of_birth",
  "address",
  "phone_number",
  "email",
  "tax_residency",
  "nationality",
  "employment",
  "source_of_funds",
  "brokerage_profile",
  "identity_profile",
]);

function fieldsForScope(scope: string | null | undefined, requiredFields: string[]): string[] {
  const normalizedScope = String(scope || "");
  const domain = scopeDomain(scope);
  const primaryField = scopePrimaryField(scope);
  const requested = requiredFields.length ? requiredFields : [];
  if (normalizedScope.startsWith("attr.financial")) {
    const scopedField = financialScopeField(scope);
    if (scopedField) return [scopedField];
    if (normalizedScope === "attr.financial.*" || normalizedScope === "attr.financial") {
      return ["financial_information"];
    }
    const financialRequested = requested.filter((field) => FINANCIAL_FIELDS.has(field));
    if (financialRequested.length) return financialRequested;
    return ["financial_information"];
  }
  if (domain && domain !== "identity") {
    const dynamicRequested = requested.filter(
      (field) => !FINANCIAL_FIELDS.has(field) && !IDENTITY_FIELDS.has(field)
    );
    if (primaryField && scopePath(scope)) {
      return [primaryField];
    }
    if (dynamicRequested.length) return dynamicRequested;
    return primaryField ? [primaryField] : [];
  }
  const identityRequested = requested.filter((field) => !FINANCIAL_FIELDS.has(field));
  return identityRequested.length ? identityRequested : ["identity_profile"];
}

function financialExportShape(value: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(value.financial)) return value.financial;
  if (
    value.portfolio ||
    value.holdings ||
    value.profile ||
    value.financial_profile ||
    value.financialProfile ||
    value.documents ||
    value.financial_documents
  ) {
    return value;
  }
  return null;
}

function projectBroadFinancialPayload(
  payload: Record<string, unknown>,
  scope: string | null | undefined,
  selectedScopes: string[]
): Record<string, unknown> {
  if (String(scope || "") !== "attr.financial.*") return payload;
  const coveredFields = new Set(
    selectedScopes
      .filter((selectedScope) => selectedScope !== scope)
      .map(financialScopeField)
      .filter((field): field is string => Boolean(field))
  );
  if (!coveredFields.size) return payload;

  const source = financialExportShape(payload);
  if (!source) return payload;
  const nextFinancial = { ...source };

  if (coveredFields.has("financial_profile")) {
    delete nextFinancial.profile;
    delete nextFinancial.financial_profile;
    delete nextFinancial.financialProfile;
  }
  if (coveredFields.has("portfolio")) {
    delete nextFinancial.portfolio;
    delete nextFinancial.holdings;
    delete nextFinancial.investment_holdings;
    delete nextFinancial.investments;
    delete nextFinancial.positions;
  }
  if (coveredFields.has("financial_documents")) {
    delete nextFinancial.documents;
    delete nextFinancial.financial_documents;
    delete nextFinancial.financialDocuments;
  }
  for (const key of Object.keys(nextFinancial)) {
    if (!shouldDisplayApprovedKey(key)) delete nextFinancial[key];
  }

  if (!Object.keys(nextFinancial).length) return {};
  return isRecord(payload.financial) ? { ...payload, financial: nextFinancial } : nextFinancial;
}

export function effectiveOneKycRequiredFields(params: {
  requiredFields?: string[] | null;
  scopes?: Array<string | null | undefined> | null;
  fallbackScope?: string | null;
}): string[] {
  const requiredFields = params.requiredFields || [];
  const scopes = (params.scopes || []).filter((scope): scope is string => Boolean(scope));
  const effectiveScopes = scopes.length ? scopes : params.fallbackScope ? [params.fallbackScope] : [];
  const fields: string[] = [];
  for (const scope of effectiveScopes) {
    for (const field of fieldsForScope(scope, requiredFields)) {
      if (!fields.includes(field)) fields.push(field);
    }
  }
  if (fields.length) return fields;
  if (requiredFields.length && effectiveScopes.some((scope) => scopeDomain(scope) !== "identity")) {
    return [];
  }
  return fieldsForScope(params.fallbackScope || "attr.identity.*", requiredFields);
}

function approvedFieldLabel(field: string, scope?: string | null): string {
  if (field === "preferences") {
    const domain = scopeDomain(scope);
    return domain && domain !== "identity" ? `${domain} preferences` : "preferences";
  }
  return humanizeField(field);
}

function scopeTitle(scope: string | null | undefined): string {
  const normalized = String(scope || "");
  if (normalized.includes("financial.portfolio")) return "Portfolio";
  if (normalized.includes("financial.profile")) return "Financial profile";
  if (normalized.includes("financial.documents")) return "Financial documents";
  const domain = scopeDomain(scope);
  const path = scopePath(scope);
  if (path) return sentenceCase(approvedHumanLabel(path));
  if (domain) return `${sentenceCase(approvedHumanLabel(domain))} information`;
  return "Approved information";
}

function uniqueApprovedKey(
  approvedValues: Record<string, string>,
  field: string,
  scope: string
): string {
  if (approvedValues[field] === undefined) return field;
  const domain = scopeDomain(scope);
  const path = scopePath(scope);
  const scoped = [domain, path, field].filter(Boolean).join("_");
  if (scoped && approvedValues[scoped] === undefined) return scoped;
  let index = 2;
  while (approvedValues[`${field}_${index}`] !== undefined) index += 1;
  return `${field}_${index}`;
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function metadataString(metadata: Record<string, unknown> | null, keys: string[]): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value !== "string") continue;
    const text = truncate(value, 120);
    if (text) return text;
  }
  return null;
}

function accountHolderLabel(workflow: OneKycWorkflow): string {
  const metadata = metadataRecord(workflow.metadata);
  const explicit = metadataString(metadata, [
    "account_holder_name",
    "account_holder_label",
    "matched_user_name",
    "matched_user_label",
    "profile_display_name",
    "display_name",
  ]);
  if (explicit) return explicit;

  const replyThread = metadataRecord(metadata?.reply_thread);
  const matchedEmails = Array.isArray(replyThread?.matched_user_emails)
    ? replyThread.matched_user_emails.map((email) => String(email).toLowerCase())
    : [];
  const senderEmail = String(workflow.sender_email || "").toLowerCase();
  const senderIsAccountHolder = Boolean(senderEmail && matchedEmails.includes(senderEmail));
  if (senderIsAccountHolder) {
    const senderLabel = truncate(workflow.sender_name || workflow.counterparty_label, 120);
    if (senderLabel && !senderLabel.includes("@")) return senderLabel;
  }

  return "the account holder";
}

function accountHolderSubject(label: string): string {
  if (label === "the account holder") return label;
  const first = label.split(/\s+/)[0]?.trim();
  return first || label;
}

function sentenceCase(value: string): string {
  const text = value.trim();
  if (!text) return text;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function cleanSentence(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return text;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizePreferencePhrase(value: string): string | null {
  const text = value
    .replace(/^actually[, ]*/i, "")
    .replace(/^prefers\s+/i, "")
    .replace(/^i\s+(now\s+)?prefer\s+/i, "")
    .replace(/^i\s+(usually\s+|generally\s+)?choose\s+/i, "")
    .replace(/\bwork(s)? better now\b/i, "")
    .replace(/\bare better now\b/i, "")
    .replace(/\bis better now\b/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!text) return null;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function naturalApprovedSentence(params: {
  field: string;
  value: string;
  scope?: string | null;
  accountHolder: string;
}): string {
  if (params.value.includes("\n")) return params.value;
  const label = approvedFieldLabel(params.field, params.scope);
  const holder = accountHolderSubject(params.accountHolder);
  const normalizedField = params.field.toLowerCase();
  const normalizedLabel = label.toLowerCase();
  if (normalizedField === "portfolio" || params.scope?.includes("financial.portfolio")) {
    return `${sentenceCase(holder)}'s portfolio ${cleanSentence(params.value)}`;
  }
  if (normalizedField.includes("preference") || normalizedLabel.includes("preference")) {
    const phrase = normalizePreferencePhrase(params.value);
    if (phrase) return `${sentenceCase(holder)} prefers ${phrase}.`;
  }
  const verb = params.field.endsWith("s") || params.value.includes(",") ? "are" : "is";
  return `${sentenceCase(holder)}'s ${label} ${verb} ${cleanSentence(params.value)}`;
}

function approvedEntryBlock(field: string, value: string, scope?: string | null): string {
  const label = approvedFieldLabel(field, scope);
  if (value.includes("\n")) {
    if (/^(Portfolio summary|Financial profile|Financial documents|Holdings)\n/.test(value)) {
      return value;
    }
    return `${sentenceCase(label)}\n${value}`;
  }
  return `- ${label}: ${value}`;
}

function draftSubBlocks(value: string): string[] {
  return value
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function draftBlockHeading(value: string): string {
  const lines = value.split("\n");
  return lines[0]?.trim() || "";
}

function isGenericSectionTitle(title: string): boolean {
  const key = normalizedObjectKey(title);
  return (
    key === "approved_information" ||
    key.endsWith("_information") ||
    key.endsWith("_details") ||
    key.endsWith("_data")
  );
}

function isRedundantEntryHeading(sectionTitle: string, heading: string): boolean {
  const sectionKey = normalizedObjectKey(sectionTitle);
  const headingKey = normalizedObjectKey(heading);
  return (
    headingKey === sectionKey ||
    headingKey === `${sectionKey}_summary` ||
    headingKey === `${sectionKey}_details`
  );
}

function hasMultipleHeadedSubBlocks(value: string): boolean {
  return (
    draftSubBlocks(value).filter((block) => {
      const heading = draftBlockHeading(block);
      return Boolean(
        heading &&
          !heading.startsWith("-") &&
          heading.length <= 80 &&
          !/[.!?]$/.test(heading)
      );
    }).length > 1
  );
}

function displayTitleForSection(
  sectionTitle: string,
  entryBlocks: string[]
): string {
  if (entryBlocks.length !== 1) return sectionTitle;
  const entryHeading = draftBlockHeading(entryBlocks[0] || "");
  if (!entryHeading || entryHeading.startsWith("-")) return sectionTitle;
  if (entryHeading.length > 80 || /[.!?]$/.test(entryHeading)) return sectionTitle;
  if (isRedundantEntryHeading(sectionTitle, entryHeading)) return entryHeading;
  if (isGenericSectionTitle(sectionTitle) && !hasMultipleHeadedSubBlocks(entryBlocks[0] || "")) {
    return entryHeading;
  }
  return sectionTitle;
}

function stripDuplicateSectionHeading(value: string, sectionTitle: string): string {
  const lines = value.split("\n");
  const first = draftBlockHeading(value);
  if (first && normalizedObjectKey(first) === normalizedObjectKey(sectionTitle) && lines.length > 1) {
    return lines.slice(1).join("\n").trim();
  }
  return value;
}

function draftStyleFromInstructions(instructions?: string): KycDraftStyle {
  const text = String(instructions || "").toLowerCase();
  const human = /\b(human|natural|plain english|readable|less programmatic|rewrite|polish|polished|email)\b/.test(text);
  const structured = /\b(format|formatted|structure|structured|headings|sections|readable|clean|beautiful)\b/.test(text);
  const table = /\b(table|tabular|columns|spreadsheet)\b/.test(text);
  return {
    compact: /\b(shorter|short|concise|brief|direct|tighten)\b/.test(text),
    formal: /\b(formal|professional|polished)\b/.test(text),
    bulletList: structured || table || /\b(bullet|bullets|list)\b/.test(text),
    structured,
    table,
    fullDetail: /\b(full detail|all details|complete|everything|full)\b/.test(text),
    human,
    cleanHeaders: /\b(double headers?|duplicate headers?|remove headers?|clean headers?|headings?)\b/.test(text),
  };
}

function buildApprovedReplyBody(params: {
  renderModel: KycDraftRenderModel;
}): string {
  const { accountHolder, missingFields, sections, style } = params.renderModel;
  const opening = style.formal
    ? `I am replying on behalf of ${accountHolder} with the approved information below.`
    : `I am replying on behalf of ${accountHolder}.`;
  const entries = sections.flatMap((section) => section.entries);
  const signature = "Best,\nhussh One";

  if (
    sections.length === 1 &&
    entries.length === 1 &&
    missingFields.length === 0 &&
    !style.bulletList &&
    !style.structured &&
    !style.table &&
    !style.fullDetail &&
    !style.human
  ) {
    const firstEntry = entries[0];
    if (!firstEntry) return `${opening}\n\n${signature}`;
    return `${opening}

${naturalApprovedSentence({
  field: firstEntry.field,
  value: firstEntry.value,
  scope: firstEntry.scope,
  accountHolder,
})}

${signature}`;
  }

  const sectionBlocks = sections
    .filter((section) => section.entries.length)
    .map((section) => {
      const rawEntryBlocks = section.entries
        .map((entry) =>
          style.human && !entry.value.includes("\n")
            ? naturalApprovedSentence({
                field: entry.field,
                value: entry.value,
                scope: entry.scope,
                accountHolder,
              })
            : approvedEntryBlock(entry.field, entry.value, entry.scope)
        )
        .filter(Boolean);
      const sectionTitle = displayTitleForSection(section.title, rawEntryBlocks);
      const entryBlocks = rawEntryBlocks
        .map((entryBlock) => stripDuplicateSectionHeading(entryBlock, sectionTitle))
        .filter(Boolean)
        .join("\n\n");
      return `${sectionTitle}\n\n${entryBlocks}`;
    })
    .join("\n\n");
  const missingLines = missingFields
    .map((field) => `- ${field.replaceAll("_", " ")}`)
    .join("\n");
  const missingCopy = missingLines
    ? `\nNot found in the approved data:\n${missingLines}\n`
    : "";

  return `${opening}

${sectionBlocks || "No requested values were present in the approved data."}
${missingCopy}
${signature}`.slice(0, MAX_DRAFT_BODY_LENGTH);
}

type DraftHoldingRow = {
  asset: string;
  quantity: string;
  value: string;
  price: string;
  gainLoss: string;
  type: string;
};

function parseDraftBullet(line: string): string {
  return line.replace(/^[-*]\s*/, "").trim();
}

function parseDraftHoldingRow(line: string): DraftHoldingRow | null {
  const text = parseDraftBullet(line);
  const [rawAsset = "", rawDetails = ""] = text.split(/:\s*/, 2);
  const asset = rawAsset.trim();
  if (!asset) return null;
  const details = rawDetails
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const row: DraftHoldingRow = {
    asset,
    quantity: "",
    value: "",
    price: "",
    gainLoss: "",
    type: "",
  };
  if (asset.toLowerCase() === "cash" && rawDetails.trim().startsWith("$")) {
    row.value = rawDetails.trim();
    return row;
  }
  for (const detail of details) {
    if (detail.endsWith(" shares")) {
      row.quantity = detail.replace(/\s+shares$/, "");
    } else if (detail.endsWith(" value")) {
      row.value = detail.replace(/\s+value$/, "");
    } else if (detail.endsWith(" per share")) {
      row.price = detail.replace(/\s+per share$/, "");
    } else if (detail.endsWith(" unrealized gain/loss")) {
      row.gainLoss = detail.replace(/\s+unrealized gain\/loss$/, "");
    } else if (!row.type) {
      row.type = detail;
    }
  }
  return row;
}

function htmlParagraph(block: string): string {
  return `<p style="margin:0;color:${EMAIL_THEME.text};font-size:15px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(block)}</p>`;
}

function htmlKeyValueSection(heading: string, bulletLines: string[]): string {
  const items = bulletLines
    .map((line) => {
      const text = parseDraftBullet(line);
      const [rawLabel = "Detail", ...valueParts] = text.split(":");
      const label = rawLabel.trim() || "Detail";
      const value = valueParts.join(":").trim() || "-";
      return `<td style="width:50%;padding:6px;vertical-align:top;word-break:break-word;"><div style="border:1px solid ${EMAIL_THEME.border};border-radius:12px;background:${EMAIL_THEME.panel};padding:12px;"><div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_THEME.muted};font-weight:700;">${escapeHtml(label)}</div><div style="margin-top:5px;font-size:15px;line-height:1.4;color:${EMAIL_THEME.heading};font-weight:650;word-break:break-word;">${escapeHtml(value)}</div></div></td>`;
    })
    .reduce<string[]>((rows, cell, index) => {
      if (index % 2 === 0) rows.push(`<tr>${cell}`);
      else rows[rows.length - 1] = `${rows[rows.length - 1]}${cell}</tr>`;
      return rows;
    }, [])
    .map((row) => (row.endsWith("</tr>") ? row : `${row}<td style="width:50%;padding:6px;"></td></tr>`))
    .join("");
  return `<section style="margin:0;"><h2 style="margin:0 0 10px;color:${EMAIL_THEME.heading};font-size:17px;line-height:1.25;">${escapeHtml(heading)}</h2><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:100%;border-collapse:collapse;table-layout:fixed;"><tbody>${items}</tbody></table></section>`;
}

function htmlHoldingsTable(lines: string[]): string {
  const rows = lines
    .map(parseDraftHoldingRow)
    .filter((row): row is DraftHoldingRow => Boolean(row));
  if (!rows.length) return htmlKeyValueSection("Holdings", lines);
  const bodyRows = rows
    .map(
      (row) => `<tr>
        <td style="padding:8px 10px;border-top:1px solid ${EMAIL_THEME.border};font-weight:700;color:${EMAIL_THEME.heading};white-space:nowrap;">${escapeHtml(row.asset)}</td>
        <td style="padding:8px 10px;border-top:1px solid ${EMAIL_THEME.border};color:${EMAIL_THEME.text};white-space:nowrap;">${escapeHtml(row.quantity || "-")}</td>
        <td style="padding:8px 10px;border-top:1px solid ${EMAIL_THEME.border};color:${EMAIL_THEME.text};white-space:nowrap;">${escapeHtml(row.value || "-")}</td>
        <td style="padding:8px 10px;border-top:1px solid ${EMAIL_THEME.border};color:${EMAIL_THEME.text};white-space:nowrap;">${escapeHtml(row.price || "-")}</td>
        <td style="padding:8px 10px;border-top:1px solid ${EMAIL_THEME.border};color:${EMAIL_THEME.text};white-space:nowrap;">${escapeHtml(row.gainLoss || "-")}</td>
        <td style="padding:8px 10px;border-top:1px solid ${EMAIL_THEME.border};color:${EMAIL_THEME.text};white-space:nowrap;">${escapeHtml(row.type || "-")}</td>
      </tr>`
    )
    .join("");
  return `<section style="margin:0;"><h2 style="margin:0 0 10px;color:${EMAIL_THEME.heading};font-size:17px;line-height:1.25;">Holdings</h2><div style="width:100%;max-width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;border:1px solid ${EMAIL_THEME.border};border-radius:14px;background:${EMAIL_THEME.panel};"><table cellpadding="0" cellspacing="0" style="width:720px;min-width:720px;max-width:none;border-collapse:collapse;font-size:13px;table-layout:auto;"><thead><tr style="background:${EMAIL_THEME.chip};"><th align="left" style="padding:8px 10px;color:${EMAIL_THEME.muted};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;">Asset</th><th align="left" style="padding:8px 10px;color:${EMAIL_THEME.muted};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;">Quantity</th><th align="left" style="padding:8px 10px;color:${EMAIL_THEME.muted};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;">Value</th><th align="left" style="padding:8px 10px;color:${EMAIL_THEME.muted};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;">Price</th><th align="left" style="padding:8px 10px;color:${EMAIL_THEME.muted};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;">Gain/loss</th><th align="left" style="padding:8px 10px;color:${EMAIL_THEME.muted};font-size:10px;letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;">Type</th></tr></thead><tbody>${bodyRows}</tbody></table></div></section>`;
}

export function buildApprovedReplyHtml(body: string): string {
  const blocks = body
    .trim()
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const content = blocks
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const heading = lines[0] || "";
      const rest = lines.slice(1);
      const allBullets = lines.every((line) => /^[-*]\s+/.test(line));
      const restBullets = rest.length > 0 && rest.every((line) => /^[-*]\s+/.test(line));
      if (heading.toLowerCase() === "holdings" && restBullets) {
        return htmlHoldingsTable(rest);
      }
      if (restBullets) return htmlKeyValueSection(heading, rest);
      if (allBullets) {
        const items = lines
          .map((line) => `<li style="margin:0 0 8px;color:${EMAIL_THEME.text};line-height:1.5;">${escapeHtml(parseDraftBullet(line))}</li>`)
          .join("");
        return `<ul style="margin:0;padding-left:20px;">${items}</ul>`;
      }
      if (block === "Best,\nhussh One") {
        return `<p style="margin:0;padding-top:14px;border-top:1px solid ${EMAIL_THEME.border};color:${EMAIL_THEME.heading};font-weight:650;line-height:1.5;">Best,<br/>hussh One</p>`;
      }
      if (lines.length === 1 && !/[.!?]$/.test(heading) && heading.length <= 80) {
        return `<h2 style="margin:0;color:${EMAIL_THEME.heading};font-size:18px;line-height:1.25;">${escapeHtml(heading)}</h2>`;
      }
      return htmlParagraph(block);
    })
    .join('<div style="height:18px;line-height:18px;">&nbsp;</div>');

  return `<div style="margin:0;padding:16px;background:${EMAIL_THEME.background};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;"><div style="width:100%;max-width:820px;margin:0 auto;border:1px solid ${EMAIL_THEME.border};border-radius:18px;background:${EMAIL_THEME.card};overflow:hidden;"><div style="padding:16px 20px;border-bottom:1px solid ${EMAIL_THEME.border};background:${EMAIL_THEME.panel};"><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td style="width:42px;vertical-align:middle;"><div style="width:34px;height:34px;border-radius:12px;border:1px solid ${EMAIL_THEME.accentBorder};background:${EMAIL_THEME.accent};color:${EMAIL_THEME.background};font-size:19px;line-height:34px;text-align:center;font-weight:800;">🤫</div></td><td style="vertical-align:middle;"><div style="font-size:14px;line-height:1.2;color:${EMAIL_THEME.heading};font-weight:800;">hussh One</div><div style="margin-top:2px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${EMAIL_THEME.accent};font-weight:750;">approved reply</div></td></tr></table></div><div style="padding:20px;">${content}</div></div></div>`;
}

function replySubject(subject: string | null | undefined): string {
  const value = String(subject || "KYC request").trim();
  return value.toLowerCase().startsWith("re:") ? value.slice(0, 500) : `Re: ${value}`.slice(0, 500);
}

function kycX25519UnsupportedError(): Error {
  return new Error(
    "One Email KYC requires WebCrypto X25519 support. Use iOS 17 or later for direct device testing."
  );
}

async function generateConnectorRecord(): Promise<KycClientConnectorPrivateRecord> {
  const algorithm = { name: "X25519" } as unknown as AlgorithmIdentifier;
  let keyPair: CryptoKeyPair;
  try {
    keyPair = (await crypto.subtle.generateKey(algorithm, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
  } catch {
    throw kycX25519UnsupportedError();
  }
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const publicKey = bytesToBase64(publicKeyBytes);
  const privateKey = bytesToBase64(privateKeyBytes);
  const fingerprint = await sha256Hex(publicKey);
  return {
    connector_key_id: `one-kyc-${fingerprint.slice(0, 20)}`,
    connector_public_key: publicKey,
    connector_private_key: privateKey,
    connector_private_key_format: "pkcs8",
    connector_wrapping_alg: KYC_CONNECTOR_WRAPPING_ALG,
    public_key_fingerprint: fingerprint,
    created_at: new Date().toISOString(),
  };
}

function parseStoredConnector(value: unknown): KycClientConnectorPrivateRecord | null {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const active = record?.active && typeof record.active === "object"
    ? (record.active as Record<string, unknown>)
    : null;
  if (!active) return null;
  const connector = {
    connector_key_id: String(active.connector_key_id || ""),
    connector_public_key: String(active.connector_public_key || ""),
    connector_private_key: String(active.connector_private_key || ""),
    connector_private_key_format: String(active.connector_private_key_format || ""),
    connector_wrapping_alg: String(active.connector_wrapping_alg || ""),
    public_key_fingerprint: String(active.public_key_fingerprint || ""),
    created_at: String(active.created_at || ""),
  };
  if (
    connector.connector_key_id &&
    connector.connector_public_key &&
    connector.connector_private_key &&
    connector.connector_private_key_format === "pkcs8" &&
    connector.connector_wrapping_alg === KYC_CONNECTOR_WRAPPING_ALG
  ) {
    return connector as KycClientConnectorPrivateRecord;
  }
  return null;
}

export class OneKycClientZkService {
  static async readStoredConnector(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<KycClientConnectorPrivateRecord | null> {
    const snapshot = await PkmDomainResourceService.getStaleFirst({
      userId: params.userId,
      domain: KYC_CONNECTOR_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      backgroundRefresh: false,
    }).catch(() => null);
    return parseStoredConnector(snapshot?.data);
  }

  static async storeConnector(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
    connector: KycClientConnectorPrivateRecord;
  }): Promise<PkmWriteCoordinatorResult> {
    return PkmWriteCoordinator.saveMergedDomain({
      userId: params.userId,
      domain: KYC_CONNECTOR_PKM_DOMAIN,
      vaultKey: params.vaultKey,
      vaultOwnerToken: params.vaultOwnerToken,
      build: () => ({
        domainData: {
          active: params.connector,
          schema_version: 1,
          updated_at: new Date().toISOString(),
        },
        summary: {
          connector_key_id: params.connector.connector_key_id,
          connector_wrapping_alg: params.connector.connector_wrapping_alg,
          public_key_fingerprint: params.connector.public_key_fingerprint,
          updated_at: new Date().toISOString(),
        },
      }),
    });
  }

  static async ensureConnector(params: {
    userId: string;
    vaultKey: string;
    vaultOwnerToken: string;
  }): Promise<KycClientConnectorPrivateRecord> {
    const [stored, backend] = await Promise.all([
      this.readStoredConnector(params),
      OneKycService.getClientConnector({
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
      }).catch(() => null),
    ]);
    const backendKeyId = backend?.connector?.connector_key_id || null;
    if (stored && (!backendKeyId || backendKeyId === stored.connector_key_id)) {
      await OneKycService.registerClientConnector({
        userId: params.userId,
        vaultOwnerToken: params.vaultOwnerToken,
        connector: stored,
      });
      return stored;
    }
    const next = await generateConnectorRecord();
    const save = await this.storeConnector({ ...params, connector: next });
    if (!save.success) {
      throw new Error(save.message || "Unable to save KYC connector in your vault.");
    }
    await OneKycService.registerClientConnector({
      userId: params.userId,
      vaultOwnerToken: params.vaultOwnerToken,
      connector: next,
    });
    return next;
  }

  static async decryptScopedExport(params: {
    exportPackage: KycScopedExportPackage;
    connector: KycClientConnectorPrivateRecord;
  }): Promise<Record<string, unknown>> {
    const wrapped = params.exportPackage.wrapped_key_bundle;
    const wrappingAlg = wrapped.wrapping_alg || KYC_CONNECTOR_WRAPPING_ALG;
    if (wrappingAlg !== KYC_CONNECTOR_WRAPPING_ALG) {
      throw new Error("Unsupported KYC export wrapping algorithm.");
    }
    if (wrapped.connector_key_id && wrapped.connector_key_id !== params.connector.connector_key_id) {
      throw new Error("KYC export was wrapped to a different client connector.");
    }

    const x25519 = { name: "X25519" } as unknown as AlgorithmIdentifier;
    let sharedSecret: ArrayBuffer;
    try {
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        toArrayBuffer(base64ToBytesCompat(params.connector.connector_private_key)),
        x25519,
        false,
        ["deriveBits"]
      );
      const senderPublicKey = await crypto.subtle.importKey(
        "raw",
        toArrayBuffer(base64ToBytesCompat(wrapped.sender_public_key)),
        x25519,
        false,
        []
      );
      sharedSecret = await crypto.subtle.deriveBits(
        { name: "X25519", public: senderPublicKey } as unknown as AlgorithmIdentifier,
        privateKey,
        256
      );
    } catch {
      throw kycX25519UnsupportedError();
    }
    const wrappingKeyBytes = await sha256Bytes(sharedSecret);
    const wrappingKey = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(wrappingKeyBytes),
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const exportKeyBytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytesCompat(wrapped.wrapped_key_iv)) },
      wrappingKey,
      toArrayBuffer(
        concatBytes(
          base64ToBytesCompat(wrapped.wrapped_export_key),
          base64ToBytesCompat(wrapped.wrapped_key_tag)
        )
      )
    );
    const exportKey = await crypto.subtle.importKey(
      "raw",
      exportKeyBytes,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64ToBytesCompat(params.exportPackage.iv)) },
      exportKey,
      toArrayBuffer(
        concatBytes(
          base64ToBytesCompat(params.exportPackage.encrypted_data),
          base64ToBytesCompat(params.exportPackage.tag)
        )
      )
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("KYC export payload is invalid.");
    }
    return parsed as Record<string, unknown>;
  }

  static async buildDraft(params: {
    workflow: OneKycWorkflow;
    exportPayload?: Record<string, unknown>;
    exportPayloads?: KycDraftExportPayload[];
    instructions?: string;
  }): Promise<KycDraftBuildResult> {
    const payloads =
      params.exportPayloads && params.exportPayloads.length
        ? params.exportPayloads
        : params.exportPayload
          ? [{ scope: params.workflow.requested_scope, payload: params.exportPayload }]
          : [];
    const approvedValues: Record<string, string> = {};
    const missingFields: string[] = [];
    const scopeSummaries: KycDraftBuildResult["scopeSummaries"] = [];
    const sections: KycDraftRenderSection[] = [];
    const selectedScopes = payloads
      .map((item) => item.scope || params.workflow.requested_scope || "attr.identity.*")
      .filter((scope): scope is string => Boolean(scope));
    for (const item of payloads) {
      const scope = item.scope || params.workflow.requested_scope || "attr.identity.*";
      const projectedPayload = projectBroadFinancialPayload(item.payload, scope, selectedScopes);
      if (String(scope) === "attr.financial.*" && !Object.keys(projectedPayload).length) {
        continue;
      }
      const extracted = extractApprovedValues({
        payload: projectedPayload,
        requiredFields: params.workflow.required_fields,
        scope,
      });
      const sectionEntries: KycDraftRenderEntry[] = [];
      for (const [field, value] of Object.entries(extracted.approvedValues)) {
        const approvedKey = uniqueApprovedKey(approvedValues, field, scope);
        approvedValues[approvedKey] = value;
        sectionEntries.push({
          field,
          label: approvedFieldLabel(field, scope),
          value,
          scope,
        });
      }
      for (const field of extracted.missingFields) {
        if (!missingFields.includes(field)) missingFields.push(field);
      }
      sections.push({
        scope,
        title: scopeTitle(scope),
        entries: sectionEntries,
        missingFields: extracted.missingFields,
      });
      scopeSummaries.push({
        scope,
        approvedFields: Object.keys(extracted.approvedValues),
        missingFields: extracted.missingFields,
      });
    }
    const style = draftStyleFromInstructions(params.instructions);
    const renderModel: KycDraftRenderModel = {
      accountHolder: accountHolderLabel(params.workflow),
      style,
      sections,
      missingFields,
    };
    const body = buildApprovedReplyBody({
      renderModel,
    });
    const htmlBody = buildApprovedReplyHtml(body);
    return {
      subject: replySubject(params.workflow.subject),
      body,
      htmlBody,
      approvedValues,
      missingFields,
      renderModel,
      scopeSummaries,
      draftHash: await sha256Hex(body),
    };
  }
}

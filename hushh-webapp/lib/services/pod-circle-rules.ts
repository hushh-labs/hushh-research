import { ApiService } from "@/lib/services/api-service";

export type CircleAutoApproveRule = {
  ruleId: string;
  circleId: string;
  label: string;
  scopePatterns: string[];
  nlPolicyFilter: string;
  delegationSubkeyRef: string;
  enabled: boolean;
  dailyCap: number;
  requireConfidence: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CircleAutoApproveReceipt = {
  decision: "auto_approve" | "stage_for_owner_review";
  reason: string;
  circle_id?: string;
  scope?: string;
  matched_rule_id?: string | null;
  confidence?: number;
  master_vault_key_touched?: boolean;
  recorded_at_ms?: number;
};

export type CircleAutoApproveListResponse = {
  rules: CircleAutoApproveRule[];
  recentReceipts: CircleAutoApproveReceipt[];
  sessionOnlyLockdown: boolean;
  masterVaultKeyLeavesDevice: false;
};

export type UpsertCircleAutoApproveRuleInput = {
  ruleId?: string;
  circleId: string;
  label: string;
  scopePatterns: string[];
  nlPolicyFilter?: string;
  delegationSubkeyRef?: string;
  enabled?: boolean;
  dailyCap?: number;
  requireConfidence?: number;
};

export type CircleAutoApprovePreviewInput = {
  circleId: string;
  requestedScope: string;
  candidateSummary: string;
  candidateTags?: string[];
  requesterInCircle?: boolean;
};

export type CircleAutoApprovePreviewResult = {
  decision: "auto_approve" | "stage_for_owner_review";
  reason: string;
  matchedRuleId: string | null;
  confidence: number;
  delegationSubkeyRef: string | null;
  masterVaultKeyTouched: boolean;
};

export const FORBIDDEN_SOVEREIGN_SCOPE_PREFIXES = [
  "vault.secrets",
  "vault.master",
  "identity.ssn",
  "identity.passport",
  "identity.tax",
  "wallet.pan",
  "wallet.cvv",
  "finance.account_credentials",
  "finance.holdings",
  "finance.net_worth",
  "finance.brokerage",
  "contacts",
] as const;

const FORBIDDEN_WILDCARD_ROOTS = new Set(
  FORBIDDEN_SOVEREIGN_SCOPE_PREFIXES.map((prefix) => prefix.split(".")[0] ?? prefix),
);

const SCOPE_PATTERN_RE = /^[a-z0-9][a-z0-9_.-]{1,95}(\.\*)?$/;
const RULE_ID_RE = /^rule_[a-z0-9][a-z0-9_-]{7,63}$/;

export function isForbiddenSovereignScope(raw: string): boolean {
  const clean = raw.trim().toLowerCase();
  if (!clean || clean === "*" || clean.startsWith("*") || clean.includes("..")) {
    return true;
  }
  const isWildcard = clean.endsWith(".*");
  const base = isWildcard ? clean.slice(0, -2) : clean;
  if (!base || base.includes("*")) return true;
  if (isWildcard && FORBIDDEN_WILDCARD_ROOTS.has(base)) return true;

  for (const forbidden of FORBIDDEN_SOVEREIGN_SCOPE_PREFIXES) {
    if (base === forbidden || base.startsWith(`${forbidden}.`)) {
      return true;
    }
    if (isWildcard && forbidden.startsWith(`${base}.`)) {
      return true;
    }
  }
  return false;
}

export function validateScopePatternInput(raw: string): string | null {
  const clean = raw.trim().toLowerCase();
  if (!clean) return "Enter at least one scope pattern.";
  if (isForbiddenSovereignScope(clean)) {
    return `"${clean}" is protected Sovereign Vault or BYOC-only data and cannot auto-approve offline.`;
  }
  if (!SCOPE_PATTERN_RE.test(clean) || clean.endsWith(".") || clean.startsWith(".")) {
    return `"${clean}" must use lowercase dot-separated segments (optional trailing .*).`;
  }
  return null;
}

export function buildDelegationSubkeyRef(circleId: string, scopePatterns: string[]): string {
  const circleSlug = circleId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "") || "circle";
  const firstScope = (scopePatterns[0] ?? "domain")
    .trim()
    .toLowerCase()
    .replace(/\.\*$/, "")
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 40);
  return `subkey_${circleSlug}_${firstScope || "domain"}_v1`;
}

export function canManagePodCircleRules(): boolean {
  return typeof ApiService.ownerPodRequest === "function";
}

function parseRule(raw: unknown): CircleAutoApproveRule | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const ruleId = String(obj.ruleId ?? obj.rule_id ?? "").trim();
  const circleId = String(obj.circleId ?? obj.circle_id ?? "").trim();
  const label = String(obj.label ?? "").trim();
  const patternsRaw = obj.scopePatterns ?? obj.scope_patterns;
  if (!ruleId || !circleId || !label || !Array.isArray(patternsRaw)) return null;
  return {
    ruleId,
    circleId,
    label,
    scopePatterns: patternsRaw.map((p) => String(p)),
    nlPolicyFilter: String(obj.nlPolicyFilter ?? obj.nl_policy_filter ?? ""),
    delegationSubkeyRef: String(obj.delegationSubkeyRef ?? obj.delegation_subkey_ref ?? ""),
    enabled: Boolean(obj.enabled ?? true),
    dailyCap: Number(obj.dailyCap ?? obj.daily_cap ?? 10),
    requireConfidence: Number(obj.requireConfidence ?? obj.require_confidence ?? 0.85),
    createdAtMs: Number(obj.createdAtMs ?? obj.created_at_ms ?? 0),
    updatedAtMs: Number(obj.updatedAtMs ?? obj.updated_at_ms ?? 0),
  };
}

export async function listPodCircleRules(options?: {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}): Promise<CircleAutoApproveListResponse | null> {
  if (!canManagePodCircleRules()) return null;
  const response = await ApiService.ownerPodRequest(
    "circle-rules",
    { method: "GET", cache: "no-store", signal: options?.signal },
    false,
    undefined,
    undefined,
    options?.isCurrent,
  );
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return null;
  const rules = Array.isArray(body.rules)
    ? body.rules.map(parseRule).filter((item): item is CircleAutoApproveRule => item !== null)
    : [];
  const recentReceipts = Array.isArray(body.recentReceipts)
    ? (body.recentReceipts as CircleAutoApproveReceipt[])
    : [];
  return {
    rules,
    recentReceipts,
    sessionOnlyLockdown: Boolean(body.sessionOnlyLockdown),
    masterVaultKeyLeavesDevice: false,
  };
}

export async function upsertPodCircleRule(
  input: UpsertCircleAutoApproveRuleInput,
  options?: {
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  },
): Promise<CircleAutoApproveRule> {
  if (!canManagePodCircleRules()) {
    throw new Error("POD_CIRCLE_RULES_UNAVAILABLE");
  }
  for (const pattern of input.scopePatterns) {
    const err = validateScopePatternInput(pattern);
    if (err) throw new Error(err);
  }
  const delegationSubkeyRef =
    input.delegationSubkeyRef?.trim() ||
    buildDelegationSubkeyRef(input.circleId, input.scopePatterns);
  const response = await ApiService.ownerPodRequest(
    "circle-rules",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        delegationSubkeyRef,
      }),
      signal: options?.signal,
    },
    false,
    undefined,
    undefined,
    options?.isCurrent,
  );
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const message =
      (body && typeof body.message === "string" && body.message) ||
      `POD_CIRCLE_RULE_SAVE_FAILED:${response.status}`;
    throw new Error(message);
  }
  const parsed = parseRule(body?.rule);
  if (!parsed) throw new Error("POD_CIRCLE_RULE_INVALID_RESPONSE");
  return parsed;
}

export async function togglePodCircleRule(
  ruleId: string,
  enabled: boolean,
  options?: {
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  },
): Promise<CircleAutoApproveRule> {
  if (!canManagePodCircleRules()) {
    throw new Error("POD_CIRCLE_RULES_UNAVAILABLE");
  }
  if (!RULE_ID_RE.test(ruleId)) {
    throw new Error("INVALID_RULE_ID");
  }
  const response = await ApiService.ownerPodRequest(
    `circle-rules/${ruleId}/toggle`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
      signal: options?.signal,
    },
    false,
    undefined,
    undefined,
    options?.isCurrent,
  );
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(`POD_CIRCLE_RULE_TOGGLE_FAILED:${response.status}`);
  }
  const parsed = parseRule(body?.rule);
  if (!parsed) throw new Error("POD_CIRCLE_RULE_INVALID_RESPONSE");
  return parsed;
}

export async function deletePodCircleRule(
  ruleId: string,
  options?: {
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  },
): Promise<void> {
  if (!canManagePodCircleRules()) {
    throw new Error("POD_CIRCLE_RULES_UNAVAILABLE");
  }
  if (!RULE_ID_RE.test(ruleId)) {
    throw new Error("INVALID_RULE_ID");
  }
  const response = await ApiService.ownerPodRequest(
    `circle-rules/${ruleId}`,
    {
      method: "DELETE",
      signal: options?.signal,
    },
    false,
    undefined,
    undefined,
    options?.isCurrent,
  );
  if (!response.ok) {
    throw new Error(`POD_CIRCLE_RULE_DELETE_FAILED:${response.status}`);
  }
}

export async function previewPodCircleRule(
  input: CircleAutoApprovePreviewInput,
  options?: {
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  },
): Promise<CircleAutoApprovePreviewResult> {
  if (!canManagePodCircleRules()) {
    throw new Error("POD_CIRCLE_RULES_UNAVAILABLE");
  }
  const response = await ApiService.ownerPodRequest(
    "circle-rules/preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: options?.signal,
    },
    false,
    undefined,
    undefined,
    options?.isCurrent,
  );
  if (!response.ok) {
    throw new Error(`POD_CIRCLE_RULE_PREVIEW_FAILED:${response.status}`);
  }
  const body = (await response.json()) as CircleAutoApprovePreviewResult;
  return body;
}

import { Capacitor } from "@capacitor/core";
import { ApiError, apiErrorCode, apiJson } from "./api-client";
import { parseAzureAuthorizationStart } from "./azure-byoc-contract";

export type CloudCleanupPurpose = "account" | "remove_cloud";

export type CloudCleanupView = {
  operationId: string;
  planDigest: string | null;
  resources: Array<{
    id: string;
    scope: "whole_group" | "all_contents" | "resource_only";
  }>;
  removed: number;
  total: number;
  canFinalize: boolean;
  approvalRequired: boolean;
  needsAttention: boolean;
  inProgress: boolean;
  progressKnown?: boolean;
  attentionCode: string | null;
  provider?: "gcp" | "azure";
  confirmation?: string;
  keepAccount?: boolean;
  canCancel?: boolean;
  executionStarted?: boolean;
};

type CleanupRequest =
  | { action: "status" | "inspect" | "execute" | "finalize" | "cancel"; operationId?: string; planDigest?: string }
  | {
      action: "approve";
      planDigest: string;
      groupConfirmation: string;
      allContentsAccepted: true;
      retentionAccepted: true;
      operationId?: string;
    };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CLOUD_CLEANUP_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

export function accountCleanupProvider(error: unknown): "azure" | "gcp" | null {
  if (
    !(error instanceof ApiError) ||
    apiErrorCode(error) !==
      "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING"
  )
    return null;
  try {
    const provider = record(record(error.payload).detail).cleanupProvider;
    return provider === "azure" || provider === "gcp" ? provider : null;
  } catch {
    return null;
  }
}

function cleanupProgress(data: Record<string, unknown>, canFinalize: boolean) {
  const observed = data.authorizationOutcome == null ? null : record(data.authorizationOutcome);
  if ((data.inProgress !== undefined && typeof data.inProgress !== "boolean") ||
      (data.progressKnown !== undefined && typeof data.progressKnown !== "boolean"))
    throw new Error("CLOUD_CLEANUP_RESPONSE_INVALID");
  return {
    progressKnown: data.progressKnown !== false,
    needsAttention: observed?.status === "attention_required" ||
      data.workerOutcome === "failed" || data.workerOutcome === "cancelled",
    inProgress: !canFinalize && (data.inProgress === true || observed?.status === "running"),
    attentionCode: typeof observed?.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(observed.code)
      ? observed.code : null,
  };
}

async function request(
  token: string,
  cleanup: CleanupRequest,
  signal?: AbortSignal,
  purpose: CloudCleanupPurpose = "account",
): Promise<unknown> {
  if (!token || Capacitor.isNativePlatform())
    throw new Error(
      "Continue cloud cleanup on the Hussh website with your vault unlocked.",
    );
  return apiJson(purpose === "remove_cloud" ? "/api/one/personal-agent/removal" : "/api/account/delete", {
    method: purpose === "remove_cloud" ? "POST" : "DELETE", cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(purpose === "remove_cloud" ? cleanup : { target: "both", cleanup }),
    signal,
  });
}

export function parseCloudCleanupView(value: unknown): CloudCleanupView {
  const data = record(value);
  const {
    operationId,
    planDigest,
    resources,
    removed,
    total,
    canFinalize,
    approvalRequired,
  } = data;
  if ((data.provider != null && data.provider !== "gcp" && data.provider !== "azure") ||
      (data.confirmation != null && (typeof data.confirmation !== "string" || data.confirmation.length > 1024)) ||
      (data.keepAccount != null && typeof data.keepAccount !== "boolean") ||
      (data.canCancel != null && typeof data.canCancel !== "boolean") ||
      (data.executionStarted != null && typeof data.executionStarted !== "boolean")) throw new Error("CLOUD_CLEANUP_RESPONSE_INVALID");
  if (
    typeof operationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(operationId) ||
    (planDigest !== null &&
      (typeof planDigest !== "string" || !/^[0-9a-f]{64}$/.test(planDigest))) ||
    !Array.isArray(resources) ||
    resources.length > 128 ||
    !Number.isInteger(removed) ||
    !Number.isInteger(total) ||
    (removed as number) < 0 ||
    (total as number) < (removed as number) ||
    (total as number) > 128 ||
    typeof canFinalize !== "boolean" ||
    typeof approvalRequired !== "boolean"
  )
    throw new Error("CLOUD_CLEANUP_RESPONSE_INVALID");
  const parsed = resources.map((item) => {
    const resource = record(item);
    if (
      typeof resource.id !== "string" ||
      resource.id.length > 1024 ||
      (data.provider !== "gcp" && !resource.id.startsWith("/subscriptions/")) ||
      (data.provider === "gcp" && (!resource.id.length || /[\u0000-\u001f]/.test(resource.id))) ||
      !["whole_group", "all_contents", "resource_only"].includes(
        String(resource.scope),
      )
    )
      throw new Error("CLOUD_CLEANUP_RESPONSE_INVALID");
    return {
      id: resource.id,
      scope: resource.scope as CloudCleanupView["resources"][number]["scope"],
    };
  });
  return {
    operationId,
    planDigest: planDigest as string | null,
    resources: parsed,
    removed: removed as number,
    total: total as number,
    canFinalize,
    approvalRequired,
    ...cleanupProgress(data, canFinalize),
    canCancel: data.canCancel === true && data.executionStarted !== true && !canFinalize,
    executionStarted: data.executionStarted === true,
    ...(data.provider ? { provider: data.provider as "gcp" | "azure" } : {}),
    ...(typeof data.confirmation === "string" ? { confirmation: data.confirmation } : {}),
    ...(typeof data.keepAccount === "boolean" ? { keepAccount: data.keepAccount } : {}),
  };
}

/** Withdrawal is distinct from closing a view and never undoes approved work. */
export async function cancelCloudRemoval(token: string, view: CloudCleanupView): Promise<void> {
  if (view.canCancel !== true || view.executionStarted || view.canFinalize) throw new Error("CLOUD_REMOVAL_CANNOT_CANCEL");
  const result = record(await request(token, { action: "cancel", operationId: view.operationId }, undefined, "remove_cloud"));
  if (result.status !== "cloud_removal_cancelled" || result.operationId !== view.operationId || result.accountRetained !== true)
    throw new Error("CLOUD_CLEANUP_RESPONSE_INVALID");
}

export async function readCloudCleanup(
  token: string,
  signal?: AbortSignal,
  purpose: CloudCleanupPurpose = "account",
): Promise<CloudCleanupView> {
  return parseCloudCleanupView(await request(token, { action: "status" }, signal, purpose));
}

export async function beginCloudCleanup(
  token: string,
  action: "inspect" | "execute",
  purpose: CloudCleanupPurpose = "account",
  view?: CloudCleanupView | null,
) {
  const data = record(await request(token, { action, ...(purpose === "remove_cloud" && view ? { operationId: view.operationId, planDigest: view.planDigest ?? undefined } : {}) }, undefined, purpose));
  if (purpose === "remove_cloud" && data.status !== "authorization_required")
    return { kind: "view" as const, view: parseCloudCleanupView(data) };
  if (
    data.status !== "authorization_required" ||
    typeof data.operationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(data.operationId)
  )
    throw new Error("CLOUD_CLEANUP_RESPONSE_INVALID");
  return {
    kind: "authorize" as const,
    ...parseAzureAuthorizationStart(data),
    operationId: data.operationId,
  };
}

export async function approveCloudCleanup(
  token: string,
  view: CloudCleanupView,
  groupConfirmation: string,
  purpose: CloudCleanupPurpose = "account",
) {
  if (!view.planDigest) throw new Error("Review cloud cleanup first.");
  return parseCloudCleanupView(
    await request(token, {
      action: "approve",
      planDigest: view.planDigest,
      groupConfirmation,
      allContentsAccepted: true,
      retentionAccepted: true,
      ...(purpose === "remove_cloud" ? { operationId: view.operationId } : {}),
    }, undefined, purpose),
  );
}

export async function finishCloudRemoval(token: string, view: CloudCleanupView): Promise<void> {
  if (!view.canFinalize || !view.planDigest || view.keepAccount !== true) throw new Error("CLOUD_REMOVAL_INCOMPLETE");
  const data = record(await request(token, { action: "finalize", operationId: view.operationId, planDigest: view.planDigest }, undefined, "remove_cloud"));
  if (data.status !== "cloud_removed" || data.operationId !== view.operationId || data.accountRetained !== true || data.hostingMode !== "unplaced") throw new Error("CLOUD_REMOVAL_INCOMPLETE");
}

export function cloudCleanupErrorMessage(error: unknown): string {
  return cloudCleanupAttentionMessage(apiErrorCode(error));
}

export function cloudCleanupAttentionMessage(code: string | null): string {
  switch (code) {
    case "POD_ERASURE_COMPATIBILITY_REQUIRED":
      return "Update your agent in Software updates before cloud cleanup.";
    case "AZURE_CLEANUP_NOT_AVAILABLE":
    case "CLOUD_REMOVAL_NOT_AVAILABLE":
      return "Cloud removal is not available on this version yet. Your account and resources are retained.";
    case "CLOUD_REMOVAL_APPROVAL_CHANGED":
      return "Cleanup approval expired or changed. Refresh status and review again.";
    case "CLOUD_REMOVAL_PLACEMENT_CHANGED":
      return "Your hosting changed. Check Hosting before continuing removal.";
    case "AZURE_CLEANUP_UNRELATED_RESOURCES":
      return "Other resources share this cloud group. Review them in Azure before continuing.";
    case "AZURE_RESOURCE_OWNER_CHANGED":
    case "AZURE_CLEANUP_RESOURCE_CHANGED":
    case "AZURE_CLEANUP_INVENTORY_CHANGED":
    case "AZURE_CLEANUP_PLAN_CHANGED":
      return "Your cloud resources changed. Check Hosting before continuing removal.";
    case "AZURE_CLEANUP_OUTCOME_UNCERTAIN":
    case "AZURE_CLEANUP_ABSENCE_UNCONFIRMED":
      return "Azure has not confirmed removal. Refresh status to check the same request.";
    case "AZURE_CLEANUP_AUTHORIZATION_CHANGED":
    case "INTERRUPTED":
    case "RETRY_REQUIRED":
      return "Cleanup paused. Continue with Microsoft to resume the reviewed request.";
    default:
      return "Cloud cleanup could not be confirmed. Refresh status; your account is retained.";
  }
}

export function cloudCleanupNotStarted(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 &&
    ["AZURE_CLEANUP_RESERVATION_UNAVAILABLE", "CLOUD_REMOVAL_NOT_STARTED"].includes(apiErrorCode(error) ?? "");
}

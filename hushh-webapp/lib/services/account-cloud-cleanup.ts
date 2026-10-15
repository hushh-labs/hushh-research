import { Capacitor } from "@capacitor/core";
import { ApiError, apiErrorCode, apiJson } from "./api-client";
import { parseAzureAuthorizationStart } from "./azure-byoc-contract";

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
};

type CleanupRequest =
  | { action: "status" | "inspect" | "execute" }
  | {
      action: "approve";
      planDigest: string;
      groupConfirmation: string;
      allContentsAccepted: true;
      retentionAccepted: true;
    };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CLOUD_CLEANUP_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

export function azureAccountCleanupRequired(error: unknown): boolean {
  if (
    !(error instanceof ApiError) ||
    apiErrorCode(error) !==
      "ACCOUNT_DELETION_EXTERNAL_RESOURCES_REQUIRE_DEPROVISIONING"
  )
    return false;
  try {
    return record(record(error.payload).detail).cleanupProvider === "azure";
  } catch {
    return false;
  }
}

async function request(
  token: string,
  cleanup: CleanupRequest,
): Promise<unknown> {
  if (!token || Capacitor.isNativePlatform())
    throw new Error(
      "Continue cloud cleanup on the Hussh website with your vault unlocked.",
    );
  return apiJson("/api/account/delete", {
    method: "DELETE", cache: "no-store",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ target: "both", cleanup }),
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
      !resource.id.startsWith("/subscriptions/") ||
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
  const observed =
    data.authorizationOutcome == null
      ? null
      : record(data.authorizationOutcome);
  return {
    operationId,
    planDigest: planDigest as string | null,
    resources: parsed,
    removed: removed as number,
    total: total as number,
    canFinalize,
    approvalRequired,
    needsAttention:
      observed?.status === "attention_required" ||
      data.workerOutcome === "failed" ||
      data.workerOutcome === "cancelled",
  };
}

export async function readCloudCleanup(
  token: string,
): Promise<CloudCleanupView> {
  return parseCloudCleanupView(await request(token, { action: "status" }));
}

export async function beginCloudCleanup(
  token: string,
  action: "inspect" | "execute",
) {
  const data = record(await request(token, { action }));
  if (
    data.status !== "authorization_required" ||
    typeof data.operationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(data.operationId)
  )
    throw new Error("CLOUD_CLEANUP_RESPONSE_INVALID");
  return {
    ...parseAzureAuthorizationStart(data),
    operationId: data.operationId,
  };
}

export async function approveCloudCleanup(
  token: string,
  view: CloudCleanupView,
  groupConfirmation: string,
) {
  if (!view.planDigest) throw new Error("Review cloud cleanup first.");
  return parseCloudCleanupView(
    await request(token, {
      action: "approve",
      planDigest: view.planDigest,
      groupConfirmation,
      allContentsAccepted: true,
      retentionAccepted: true,
    }),
  );
}

export function cloudCleanupErrorMessage(error: unknown): string {
  return apiErrorCode(error) === "POD_ERASURE_COMPATIBILITY_REQUIRED"
    ? "Update your agent in Software updates before cloud cleanup."
    : "Cloud cleanup needs review or a retry. Your account is retained.";
}

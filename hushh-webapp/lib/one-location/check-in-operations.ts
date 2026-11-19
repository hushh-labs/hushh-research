import { jsonAuthHeaders as headers } from "./request-headers";
import { apiJson } from "@/lib/services/api-client";

export type CheckInOperation = {
  id: string; clientOperationId: string; state: string; durationHours: number;
  sourceCircleId: string | null; confirmedAt: string; createdAt: string;
  intendedCount: number; confirmedCount: number; pendingCount: number;
  targets: Array<{ userId: string; label: string; grantId: string | null; confirmedAt: string | null; status: string }>;
};

export async function beginPrivateCheckIn(token: string, plan: {clientOperationId:string;recipientIds:string[];durationHours:number;confirmedAt:string;sourceCircleId:string|null}): Promise<CheckInOperation> {
  const result = await apiJson<{operation:CheckInOperation}>("/api/one/location/check-ins", {method:"POST",headers:headers(token),body:JSON.stringify(plan)});
  return result.operation;
}
export async function readPrivateCheckIn(token: string, id: string): Promise<CheckInOperation> {
  const result = await apiJson<{operation:CheckInOperation}>(`/api/one/location/check-ins/${encodeURIComponent(id)}`,{method:"GET",headers:headers(token),cache:"no-store"});
  return result.operation;
}
export async function settlePrivateCheckIn(token: string, id: string): Promise<CheckInOperation> {
  const result = await apiJson<{operation:CheckInOperation}>(`/api/one/location/check-ins/${encodeURIComponent(id)}/settle`,{method:"POST",headers:headers(token)});
  return result.operation;
}

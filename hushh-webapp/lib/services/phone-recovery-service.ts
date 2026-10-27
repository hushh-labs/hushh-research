import type { User } from "firebase/auth";
import { apiJson } from "./api-client";
import { withDeadline } from "@/lib/utils/with-deadline";
import { phoneRecoveryId } from "@/lib/auth/phone-recovery-route";

export type PhoneRecoveryAction = "recover" | "delete" | "revoke";
export type PhoneRecoveryContinuation =
  | { continuation_id: string; state: "awaiting_previous_sign_in" | "expired" | "stale" }
  | { continuation_id: string; state: "ready"; action: PhoneRecoveryAction; expires_at: string; phone_hint: string };
export type DeviceRevocationPreparation = {
  operation_id: string; expires_at: string; phone_hint: string;
  transport: "sms" | "configured_test"; test_verification_id?: string; proof_wait_ms: number;
};
export type DeviceRevocationProof = { operation_id: string; confirmed: true } &
  ({ phone_id_token: string; test_code?: never } | { test_code: string; phone_id_token?: never });
export type DeviceRevocationStatus = {
  operation_id: string; state: "prepared" | "pending" | "completed" | "action_required" | "expired" | "stale" | "not_started";
  success?: boolean; device_id?: string; podBindingVersion?: number;
};

async function request<T>(user: User, current: () => boolean, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!current()) throw new Error("Your account changed. Sign in again.");
  const token = await withDeadline(user.getIdToken(), Date.now() + 8_000);
  if (!current()) throw new Error("Your account changed. Sign in again.");
  return apiJson<T>(path, { method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), isEffectCurrent: current });
}

const ROOT = "/api/account/phone/recovery/continuations";
export const PhoneRecoveryService = {
  async create(user: User, action: PhoneRecoveryAction, phone: string, current: () => boolean) {
    const result = await request<{ continuation_id: string; state: string; expires_at: string }>(user, current, ROOT, { action, phone_number: phone });
    if (!phoneRecoveryId(result?.continuation_id) || result.state !== "awaiting_previous_sign_in") throw new Error("Account recovery is unavailable. Try again.");
    return result;
  },
  async read(user: User, id: string, current: () => boolean, signal?: AbortSignal): Promise<PhoneRecoveryContinuation> {
    if (!phoneRecoveryId(id)) throw new Error("This recovery link is unavailable.");
    const result = await request<PhoneRecoveryContinuation>(user, current, `${ROOT}/${id}`, undefined, signal);
    if (result?.continuation_id !== id || !["awaiting_previous_sign_in", "ready", "expired", "stale"].includes(result.state)) throw new Error("Account recovery is unavailable. Try again.");
    if (result.state === "ready" && (!["recover", "delete", "revoke"].includes(result.action) || !Number.isFinite(Date.parse(result.expires_at)) || typeof result.phone_hint !== "string")) throw new Error("Account recovery is unavailable. Try again.");
    return result.state === "ready" ? result : { continuation_id: id, state: result.state };
  },
  async prepareRevocation(user: User, device: string, current: () => boolean, continuationId?: string) {
    const value = await request<DeviceRevocationPreparation>(user, current, `/api/account/trusted-devices/${encodeURIComponent(device)}/revoke/prepare`, continuationId ? { continuation_id: continuationId } : {});
    if (!phoneRecoveryId(value?.operation_id) || typeof value.phone_hint !== "string" ||
      !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= Date.now() ||
      !["sms", "configured_test"].includes(value.transport) ||
      (!Number.isInteger(value.proof_wait_ms) || value.proof_wait_ms < 0 || value.proof_wait_ms > 1000)) throw new Error("Device verification is unavailable.");
    return value;
  },
  cancelRevocation(user: User, operation: string, current: () => boolean) {
    return request<DeviceRevocationStatus>(user, current, `/api/account/trusted-devices/revocations/${encodeURIComponent(operation)}/cancel`, {});
  },
  async revocationStatus(user: User, operation: string, current: () => boolean) {
    const value = await request<DeviceRevocationStatus>(user, current, `/api/account/trusted-devices/revocations/${encodeURIComponent(operation)}`);
    if (value?.operation_id !== operation || !["prepared", "pending", "completed", "action_required", "expired", "stale", "not_started"].includes(value.state)) throw new Error("Device status is unavailable.");
    if (value.state === "completed" && (value.success !== true || typeof value.device_id !== "string" ||
      !Number.isInteger(value.podBindingVersion) || value.podBindingVersion! < 0)) throw new Error("Device status is unavailable.");
    return value;
  },
};

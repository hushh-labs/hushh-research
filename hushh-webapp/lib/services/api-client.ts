/**
 * ApiClient — single fetch wrapper for all service-layer HTTP calls.
 *
 * Rules:
 * - Pages/components should call services, not `fetch()` directly.
 * - Services should use this wrapper so error handling/logging is consistent.
 * - Uses ApiService.apiFetch() so routing stays platform-aware (Web vs Native).
 */

import { ApiService } from "@/lib/services/api-service";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function extractApiErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  for (const value of [record.error, record.message]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  const detail = record.detail;
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const detailRecord = detail as Record<string, unknown>;
    for (const value of [detailRecord.message, detailRecord.error, detailRecord.code]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return fallback;
}

export async function apiJson<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await ApiService.apiFetch(path, options);

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  const payload = isJson ? await res.json().catch(() => undefined) : undefined;

  if (!res.ok) {
    const msg = extractApiErrorMessage(payload, `Request failed: ${res.status}`);
    throw new ApiError(msg, res.status, payload);
  }

  return payload as T;
}

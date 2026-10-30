import type { ApiService } from "./api-service";

export async function requestPhoneTransfer<T>(fetcher: typeof ApiService.apiFetch, path: string, idToken: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetcher(`/api/account/phone/transfer/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${idToken}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const { ApiError } = await import("./api-client");
      throw new ApiError(payload?.detail?.message ?? "Phone transfer is temporarily unavailable. Please retry.", response.status, payload);
    }
    return payload as T;
  }


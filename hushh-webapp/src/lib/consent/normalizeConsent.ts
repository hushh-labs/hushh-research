export interface RawConsentResponse {
  active?: boolean;
  granted?: boolean;
  status?: string | null;
  permissions?: string[];
  scopes?: string[];
}

export interface NormalizedConsentState {
  isGranted: boolean;
  permissions: string[];
}

export function normalizeConsentResponse(
  response: RawConsentResponse | null | undefined
): NormalizedConsentState {
  const permissions = [
    ...(Array.isArray(response?.permissions) ? response.permissions : []),
    ...(Array.isArray(response?.scopes) ? response.scopes : []),
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  const status = String(response?.status || "").trim().toLowerCase();

  return {
    isGranted: Boolean(
      response?.active ||
        response?.granted ||
        status === "approved" ||
        status === "active" ||
        status === "granted"
    ),
    permissions: Array.from(new Set(permissions)),
  };
}

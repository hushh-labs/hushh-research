export interface RawConsentResponse {
  active?: boolean;
  granted?: boolean;
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
    ...(response?.permissions ?? []),
    ...(response?.scopes ?? []),
  ];

  return {
    isGranted: Boolean(response?.active || response?.granted),
    permissions: Array.from(new Set(permissions)),
  };
}
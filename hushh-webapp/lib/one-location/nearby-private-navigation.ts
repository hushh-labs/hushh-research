import { ROUTES } from "@/lib/navigation/routes";

export const NEARBY_PRIVATE_RETURN_TOKEN_PARAM = "returnToken";
export const NEARBY_PRIVATE_RESUME_PARAM = "resume";

const STORAGE_KEY = "one-location:nearby-private-return:v1";
const TOKEN_TTL_MS = 10 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9-]{16,80}$/;

type StoredReturnToken = {
  token: string;
  expiresAt: number;
};

function createOpaqueToken(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 22)}`;
}

function readStoredToken(): StoredReturnToken | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(
      window.sessionStorage.getItem(STORAGE_KEY) || "null",
    ) as StoredReturnToken | null;
    if (
      !parsed ||
      !TOKEN_PATTERN.test(parsed.token) ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function beginNearbyPrivateReturn(): string {
  const token = createOpaqueToken();
  if (typeof window !== "undefined") {
    const stored: StoredReturnToken = {
      token,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }
  return token;
}

export function isNearbyPrivateReturnToken(
  token: string | null,
): token is string {
  return Boolean(token && TOKEN_PATTERN.test(token));
}

export function buildNearbyPrivateCheckInHref(token: string): string {
  const params = new URLSearchParams({
    action: "private-check-in",
    source: "nearby",
    [NEARBY_PRIVATE_RETURN_TOKEN_PARAM]: token,
  });
  return `${ROUTES.ONE_LOCATION}?${params.toString()}`;
}

export function buildNearbyCheckInResumeHref(token: string): string {
  const params = new URLSearchParams({
    action: "check-in",
    [NEARBY_PRIVATE_RESUME_PARAM]: token,
  });
  return `${ROUTES.ONE_LOCATION_MAP}?${params.toString()}`;
}

export function consumeNearbyPrivateReturn(token: string | null): boolean {
  if (!isNearbyPrivateReturnToken(token)) return false;
  const stored = readStoredToken();
  if (!stored) return false;
  if (stored.expiresAt < Date.now()) {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return false;
  }
  if (stored.token !== token) return false;
  window.sessionStorage.removeItem(STORAGE_KEY);
  return true;
}

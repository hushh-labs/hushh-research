"use client";

import { ApiService } from "@/lib/services/api-service";
import { CacheService, CACHE_KEYS, CACHE_TTL } from "@/lib/services/cache-service";

export type LiveScopeDescriptor = {
  name: string;
  description: string;
  dynamic?: boolean;
  requires_discovery?: boolean;
};

export type LiveToolDescriptor = {
  name: string;
  description: string;
  group?: string;
  compatibility_status?: string;
};

export type LiveDocsResponse = {
  scopes?: LiveScopeDescriptor[];
  tools?: LiveToolDescriptor[];
  notes?: string[];
};

export type DeveloperPortalToken = {
  id: number;
  app_id: string;
  token_prefix: string;
  label?: string | null;
  created_at: number;
  revoked_at?: number | null;
  last_used_at?: number | null;
};

export type DeveloperPortalApp = {
  app_id: string;
  agent_id: string;
  display_name: string;
  contact_email: string;
  support_url?: string | null;
  policy_url?: string | null;
  website_url?: string | null;
  brand_image_url?: string | null;
  status: string;
  allowed_tool_groups: string[];
  created_at: number;
  updated_at: number;
};

export type DeveloperPortalAccess = {
  access_enabled: boolean;
  user_id: string;
  owner_email?: string | null;
  owner_display_name?: string | null;
  owner_provider_ids: string[];
  app?: DeveloperPortalApp | null;
  active_token?: DeveloperPortalToken | null;
  raw_token?: string | null;
  developer_token_env_var: string;
  notes: string[];
};

export type DeveloperPortalProfileUpdate = {
  display_name?: string;
  website_url?: string;
  brand_image_url?: string;
  support_url?: string;
  policy_url?: string;
};

export class DeveloperPortalRequestError extends Error {
  status: number;
  code?: string;

  constructor(message: string, options: { status: number; code?: string } ) {
    super(message);
    this.name = "DeveloperPortalRequestError";
    this.status = options.status;
    this.code = options.code;
  }
}

type PortalRequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  idToken?: string | null;
};

type CachedDeveloperAccessOptions = {
  userId?: string;
  force?: boolean;
  ttlMs?: number;
};

const developerAccessInflight = new Map<string, Promise<DeveloperPortalAccess>>();

function resolveDeveloperAccessCacheKey(userId?: string | null): string | null {
  return userId ? CACHE_KEYS.DEVELOPER_ACCESS(userId) : null;
}

function cacheDeveloperAccess(
  userId: string | undefined,
  payload: DeveloperPortalAccess,
  ttlMs: number = CACHE_TTL.SESSION
): DeveloperPortalAccess {
  if (userId) {
    CacheService.getInstance().set(CACHE_KEYS.DEVELOPER_ACCESS(userId), payload, ttlMs);
  }
  return payload;
}

function invalidateDeveloperAccess(userId?: string): void {
  if (!userId) return;
  CacheService.getInstance().invalidate(CACHE_KEYS.DEVELOPER_ACCESS(userId));
  developerAccessInflight.delete(CACHE_KEYS.DEVELOPER_ACCESS(userId));
}

async function requestPortal<T>(path: string, options: PortalRequestOptions = {}): Promise<T> {
  const response = await ApiService.apiFetch(path, {
    method: options.method || "GET",
    cache: "no-store",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.idToken ? { Authorization: `Bearer ${options.idToken}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response
    .json()
    .catch(async () => ({ detail: await response.text().catch(() => "") }));

  if (!response.ok) {
    const errorCode =
      typeof payload?.detail?.error_code === "string"
        ? payload.detail.error_code
        : typeof payload?.error_code === "string"
          ? payload.error_code
          : undefined;
    const detail =
      typeof payload?.detail === "string"
        ? payload.detail
        : payload?.detail?.message || payload?.message || "Request failed";
    throw new DeveloperPortalRequestError(detail, {
      status: response.status,
      code: errorCode,
    });
  }

  return payload as T;
}

export async function getLiveDeveloperDocs(): Promise<LiveDocsResponse> {
  const [scopeResult, toolResult] = await Promise.allSettled([
    requestPortal<{ scopes: LiveScopeDescriptor[]; notes?: string[] }>("/api/developer/v1/list-scopes"),
    requestPortal<{ tools: LiveToolDescriptor[]; notes?: string[] }>("/api/developer/v1/tool-catalog"),
  ]);

  const scopes =
    scopeResult.status === "fulfilled" ? scopeResult.value.scopes : undefined;
  const scopeNotes =
    scopeResult.status === "fulfilled" ? scopeResult.value.notes || [] : [];
  const tools =
    toolResult.status === "fulfilled" ? toolResult.value.tools : undefined;
  const toolNotes =
    toolResult.status === "fulfilled" ? toolResult.value.notes || [] : [];

  if (!scopes && !tools) {
    throw new Error("Live developer contract is unavailable right now.");
  }

  return {
    scopes,
    tools,
    notes: [...scopeNotes, ...toolNotes],
  };
}

export function getDeveloperAccess(
  idToken: string,
  options?: CachedDeveloperAccessOptions
) {
  const cacheKey = resolveDeveloperAccessCacheKey(options?.userId);
  if (cacheKey && !options?.force) {
    const cached = CacheService.getInstance().get<DeveloperPortalAccess>(cacheKey);
    if (cached) {
      return Promise.resolve(cached);
    }
    const inflight = developerAccessInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }
  }

  const request = requestPortal<DeveloperPortalAccess>("/api/developer/access", {
    idToken,
  }).then((payload) =>
    cacheDeveloperAccess(options?.userId, payload, options?.ttlMs ?? CACHE_TTL.SESSION)
  );

  if (!cacheKey) {
    return request;
  }

  developerAccessInflight.set(cacheKey, request);
  return request.finally(() => {
    if (developerAccessInflight.get(cacheKey) === request) {
      developerAccessInflight.delete(cacheKey);
    }
  });
}

export function enableDeveloperAccess(
  idToken: string,
  options?: { userId?: string }
) {
  return requestPortal<DeveloperPortalAccess>("/api/developer/access/enable", {
    method: "POST",
    idToken,
  }).then((payload) => cacheDeveloperAccess(options?.userId, payload));
}

export function updateDeveloperAccessProfile(
  idToken: string,
  body: DeveloperPortalProfileUpdate,
  options?: { userId?: string }
) {
  return requestPortal<DeveloperPortalAccess>("/api/developer/access/profile", {
    method: "PATCH",
    body,
    idToken,
  }).then((payload) => cacheDeveloperAccess(options?.userId, payload));
}

export function rotateDeveloperAccessToken(
  idToken: string,
  options?: { userId?: string }
) {
  invalidateDeveloperAccess(options?.userId);
  return requestPortal<DeveloperPortalAccess>("/api/developer/access/rotate-key", {
    method: "POST",
    idToken,
  }).then((payload) => cacheDeveloperAccess(options?.userId, payload));
}

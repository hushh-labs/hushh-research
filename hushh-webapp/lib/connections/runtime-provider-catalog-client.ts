"use client";

/**
 * The provider list comes from the server (`GET /api/one/runtime/providers`),
 * so a provider added later never breaks an older app: an id or method this
 * build cannot configure renders as "available in a newer version", never as
 * a selectable choice. The static catalog is the offline fallback, and it stays
 * conservative (OpenAI coming soon) so only the server can turn a provider on.
 */
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import { ApiService } from "@/lib/services/api-service";
import { CACHE_TTL, CacheService } from "@/lib/services/cache-service";
import {
  RUNTIME_PROVIDER_CATALOG,
  type RuntimeProviderCatalogEntry,
} from "@/lib/connections/runtime-provider-catalog";

export const RUNTIME_PROVIDER_CATALOG_CACHE_KEY = "runtime_provider_catalog_v1";
const MAX_PROVIDERS = 32;

/** Provider and method pairs this build can actually configure. */
const CONFIGURABLE_HERE: Readonly<Record<string, readonly string[]>> = {
  gemini: ["own_key"],
  openai: ["own_key"],
};

export type ResolvedRuntimeProvider = {
  id: string;
  name: string;
  state: "configurable" | "coming_soon" | "newer_version";
  defaultModel: string | null;
  /** The bundled mark for a provider this build knows; null renders a neutral glyph. */
  mark: RuntimeProviderCatalogEntry | null;
};

function knownEntry(id: string): RuntimeProviderCatalogEntry | null {
  return RUNTIME_PROVIDER_CATALOG.find((entry) => entry.id === id) ?? null;
}

function resolveEntry(raw: unknown): ResolvedRuntimeProvider | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "";
  if (!/^[a-z0-9_]{1,64}$/.test(id)) return null;
  const mark = knownEntry(id);
  const name = typeof value.name === "string" && value.name.trim() && value.name.length <= 80
    ? value.name.trim()
    : mark?.name ?? id;
  const methods = Array.isArray(value.methods) ? value.methods.filter((m): m is string => typeof m === "string") : [];
  const supported = (CONFIGURABLE_HERE[id] ?? []).some((method) => methods.includes(method));
  const state = value.availability === "coming_soon"
    ? "coming_soon"
    : value.availability === "available" && supported ? "configurable" : "newer_version";
  const defaultModel = typeof value.defaultModel === "string" && value.defaultModel.trim()
    ? value.defaultModel.trim().slice(0, 200)
    : null;
  return { id, name, state, defaultModel, mark };
}

/** Parse a C5 payload; null when it is not a usable catalog. */
export function resolveRuntimeProviderCatalog(payload: unknown): ResolvedRuntimeProvider[] | null {
  const providers = payload && typeof payload === "object" ? (payload as { providers?: unknown }).providers : null;
  if (!Array.isArray(providers)) return null;
  const seen = new Set<string>();
  const resolved: ResolvedRuntimeProvider[] = [];
  for (const raw of providers.slice(0, MAX_PROVIDERS)) {
    const entry = resolveEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    resolved.push(entry);
  }
  return resolved;
}

export function staticRuntimeProviderCatalog(): ResolvedRuntimeProvider[] {
  return RUNTIME_PROVIDER_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    state: entry.availability === "available" ? "configurable" : "coming_soon",
    defaultModel: null,
    mark: entry,
  }));
}

/** Cache-first load; a failed read falls back to the static list without caching it. */
export async function loadRuntimeProviderCatalog(): Promise<ResolvedRuntimeProvider[]> {
  try {
    const token = await ApiService.getFirebaseIdToken();
    const response = await ApiService.apiFetch("/api/one/runtime/providers", {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const resolved = response.ok ? resolveRuntimeProviderCatalog(await response.json()) : null;
    if (!resolved) return staticRuntimeProviderCatalog();
    CacheService.getInstance().set(RUNTIME_PROVIDER_CATALOG_CACHE_KEY, resolved, CACHE_TTL.MEDIUM);
    return resolved;
  } catch {
    return staticRuntimeProviderCatalog();
  }
}

export function useRuntimeProviderCatalog(): ResolvedRuntimeProvider[] {
  const resource = useStaleResource<ResolvedRuntimeProvider[]>({
    cacheKey: RUNTIME_PROVIDER_CATALOG_CACHE_KEY,
    resourceLabel: "runtime-provider-catalog",
    load: loadRuntimeProviderCatalog,
  });
  return resource.data ?? staticRuntimeProviderCatalog();
}

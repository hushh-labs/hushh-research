import { resolveAppEnvironment, type AppEnvironment } from "@/lib/app-env";

export const LOCAL_CRM_ENABLE_FLAG = "NEXT_PUBLIC_HUSHH_LOCAL_CRM_ENABLED";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function normalizeHost(value?: string | null): string {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("[")) return raw.slice(1, raw.indexOf("]"));
  return raw.replace(/:\d+$/, "");
}

export function isLocalCrmProductAvailable({
  hostname,
  environment = resolveAppEnvironment(),
  explicitEnabled = process.env.NEXT_PUBLIC_HUSHH_LOCAL_CRM_ENABLED,
}: {
  hostname?: string | null;
  environment?: AppEnvironment;
  explicitEnabled?: string | boolean | null;
} = {}): boolean {
  const enabled =
    typeof explicitEnabled === "boolean"
      ? explicitEnabled
      : TRUE_VALUES.has(String(explicitEnabled || "").trim().toLowerCase());
  return environment === "development" && enabled && LOOPBACK_HOSTS.has(normalizeHost(hostname));
}

export function isLocalCrmBuildEnabled(): boolean {
  const enabled = String(process.env.NEXT_PUBLIC_HUSHH_LOCAL_CRM_ENABLED || "")
    .trim()
    .toLowerCase();
  return resolveAppEnvironment() === "development" && TRUE_VALUES.has(enabled);
}

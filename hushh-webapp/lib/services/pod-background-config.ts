import { ApiService } from "@/lib/services/api-service";
import type { GoogleConnector } from "@/lib/one/connector-credential-seal";

export type BackgroundConnectorKey = GoogleConnector | "mcp";

export type PodBackgroundConfig = {
  sessionOnlyLockdown: boolean;
  backgroundPrepEnabled: boolean;
  connectors: Record<BackgroundConnectorKey, boolean>;
  dailyWakeCap: number;
};

export const DEFAULT_POD_BACKGROUND_CONFIG: PodBackgroundConfig = {
  sessionOnlyLockdown: false,
  backgroundPrepEnabled: true,
  connectors: {
    gmail: true,
    calendar: true,
    drive: true,
    contacts: true,
    mcp: true,
  },
  dailyWakeCap: 24,
};

const CONNECTOR_FIELD_MAP: Record<BackgroundConnectorKey, string> = {
  gmail: "background_prep_gmail",
  calendar: "background_prep_calendar",
  drive: "background_prep_drive",
  contacts: "background_prep_contacts",
  mcp: "background_prep_mcp",
};

export function parsePodBackgroundConfig(raw: unknown): PodBackgroundConfig {
  const source =
    raw && typeof raw === "object" && "config" in raw && raw.config && typeof raw.config === "object"
      ? (raw.config as Record<string, unknown>)
      : raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : {};

  const boolOr = (key: string, fallback: boolean): boolean =>
    typeof source[key] === "boolean" ? (source[key] as boolean) : fallback;

  const capRaw = source.background_daily_wake_cap;
  const dailyWakeCap =
    typeof capRaw === "number" && Number.isInteger(capRaw) && capRaw >= 1 && capRaw <= 96
      ? capRaw
      : DEFAULT_POD_BACKGROUND_CONFIG.dailyWakeCap;

  return {
    sessionOnlyLockdown: boolOr("session_only_lockdown", false),
    backgroundPrepEnabled: boolOr("background_prep_enabled", true),
    connectors: {
      gmail: boolOr("background_prep_gmail", true),
      calendar: boolOr("background_prep_calendar", true),
      drive: boolOr("background_prep_drive", true),
      contacts: boolOr("background_prep_contacts", true),
      mcp: boolOr("background_prep_mcp", true),
    },
    dailyWakeCap,
  };
}

export function canManagePodBackgroundConfig(): boolean {
  return typeof ApiService.ownerPodRequest === "function";
}

export async function readPodBackgroundConfig(options?: {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}): Promise<PodBackgroundConfig | null> {
  if (!canManagePodBackgroundConfig()) return null;
  const response = await ApiService.ownerPodRequest(
    "status",
    { method: "GET", cache: "no-store", signal: options?.signal },
    false,
    undefined,
    undefined,
    options?.isCurrent,
  );
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!body) return null;
  return parsePodBackgroundConfig(body);
}

export async function updatePodBackgroundConfig(
  changes: Record<string, boolean | number>,
  options?: {
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  },
): Promise<PodBackgroundConfig> {
  if (!canManagePodBackgroundConfig()) {
    throw new Error("POD_CONFIG_UNAVAILABLE");
  }
  const response = await ApiService.ownerPodRequest(
    "config",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes }),
      signal: options?.signal,
    },
    false,
    undefined,
    undefined,
    options?.isCurrent,
  );
  if (!response.ok) {
    throw new Error(`POD_CONFIG_WRITE_FAILED:${response.status}`);
  }
  const body = await response.json().catch(() => null);
  return parsePodBackgroundConfig(body);
}

export async function setConnectorBackgroundPrep(
  connector: BackgroundConnectorKey,
  enabled: boolean,
  options?: { isCurrent?: () => boolean },
): Promise<PodBackgroundConfig> {
  const field = CONNECTOR_FIELD_MAP[connector];
  return updatePodBackgroundConfig({ [field]: enabled }, options);
}

export async function setPodSessionOnlyLockdown(
  lockedDown: boolean,
  options?: { isCurrent?: () => boolean },
): Promise<PodBackgroundConfig> {
  return updatePodBackgroundConfig({ session_only_lockdown: lockedDown }, options);
}

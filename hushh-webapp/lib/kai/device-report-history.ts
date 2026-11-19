import type { AnalysisHistoryEntry } from "@/lib/services/kai-history-service";
import { SecureDurableResourceService } from "@/lib/services/secure-durable-resource-service";
export const DEVICE_HISTORY_KEY = "finance-analysis-history-v1";

export type HistoryOwner = { userId: string; vaultKey: string; vaultOwnerToken?: string };
export type DeviceHistory = Record<string, AnalysisHistoryEntry>;

export async function updateDeviceHistory(
  { userId, vaultKey }: HistoryOwner,
  isCurrent: () => boolean,
  update: (history: DeviceHistory) => boolean,
): Promise<boolean> {
  const expected = await SecureDurableResourceService.version(userId, DEVICE_HISTORY_KEY);
  const stored = await SecureDurableResourceService.read<DeviceHistory>(userId, DEVICE_HISTORY_KEY, vaultKey, isCurrent);
  const history = stored?.value ?? {};
  if (!isCurrent()) throw new Error("Analysis history access changed.");
  if (!update(history)) return false;
  await SecureDurableResourceService.write({
    userId, vaultKey, resourceKey: DEVICE_HISTORY_KEY, expected, value: history, isCurrent,
  });
  return true;
}


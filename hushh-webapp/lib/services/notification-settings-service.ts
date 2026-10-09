import { HushhLocation } from "@/lib/capacitor";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";

export const NotificationSettingsService = {
  async open(): Promise<boolean> {
    try {
      return (await HushhLocation.openAppSettings()).opened;
    } catch {
      return false;
    }
  },
  onReturn(callback: () => void): () => void {
    let previous = appInteractionCoordinator.getLifecycleSnapshot().state;
    return appInteractionCoordinator.subscribeLifecycle(() => {
      const next = appInteractionCoordinator.getLifecycleSnapshot().state;
      if (next === "active" && previous !== "active") callback();
      previous = next;
    });
  },
};

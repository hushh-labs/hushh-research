import { HushhLocation } from "@/lib/capacitor";
/** Native settings is reached only from an explicit permission recovery action. */
export const NotificationSettingsService = { open: () => HushhLocation.openAppSettings() };

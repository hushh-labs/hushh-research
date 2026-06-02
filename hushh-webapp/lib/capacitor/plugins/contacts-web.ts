import type {
  HushhContactsPermissionState,
  HushhContactsPlugin,
} from "@/lib/capacitor";

export class HushhContactsWeb implements HushhContactsPlugin {
  async getPermissionState(): Promise<HushhContactsPermissionState> {
    return { state: "unavailable" };
  }

  async readContacts(): Promise<{
    contacts: [];
    sourcePlatform: "web";
  }> {
    throw new Error("Contacts are only available in the native mobile app.");
  }
}

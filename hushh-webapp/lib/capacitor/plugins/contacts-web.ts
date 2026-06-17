import type {
  HushhContactRecord,
  HushhContactsPermissionState,
  HushhContactsPlugin,
} from "@/lib/capacitor";

const WEB_CONTACT_FIXTURE_KEY = "hushh:dev:contacts";

function isLocalContactFixtureAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && typeof window !== "undefined";
}

function readFixtureContacts(limit?: number): HushhContactRecord[] | null {
  if (!isLocalContactFixtureAllowed()) return null;
  const raw = window.localStorage.getItem(WEB_CONTACT_FIXTURE_KEY);
  if (!raw) return null;

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${WEB_CONTACT_FIXTURE_KEY} must be a JSON array.`);
  }

  const contacts = parsed
    .map((item, index): HushhContactRecord | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const phoneNumbers = Array.isArray(record.phoneNumbers)
        ? record.phoneNumbers.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
      const emailAddresses = Array.isArray(record.emailAddresses)
        ? record.emailAddresses.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
      if (phoneNumbers.length === 0 && emailAddresses.length === 0) return null;
      return {
        id: record.id == null ? `web-fixture-${index}` : String(record.id),
        displayName: record.displayName == null ? null : String(record.displayName),
        phoneNumbers,
        emailAddresses,
      };
    })
    .filter((contact): contact is HushhContactRecord => Boolean(contact));

  return typeof limit === "number" ? contacts.slice(0, limit) : contacts;
}

export class HushhContactsWeb implements HushhContactsPlugin {
  async getPermissionState(): Promise<HushhContactsPermissionState> {
    try {
      if (readFixtureContacts()?.length) return { state: "granted" };
    } catch {
      return { state: "unavailable" };
    }
    return { state: "unavailable" };
  }

  async readContacts(options?: { limit?: number }): Promise<{
    contacts: HushhContactRecord[];
    sourcePlatform: "web";
  }> {
    const fixtureContacts = readFixtureContacts(options?.limit);
    if (fixtureContacts) {
      return {
        contacts: fixtureContacts,
        sourcePlatform: "web",
      };
    }
    throw new Error("Contacts are only available in the native mobile app.");
  }
}

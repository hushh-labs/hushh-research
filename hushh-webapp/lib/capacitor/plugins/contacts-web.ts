import type {
  HushhContactsPermissionState,
  HushhContactsPlugin,
  HushhContactsReadResult,
} from "@/lib/capacitor";

/**
 * Browser fallback for contact reads.
 *
 * Desktop browsers have no contact book, but Chrome on Android exposes the
 * Contact Picker API, which is a user-driven subset rather than a full read.
 * That maps exactly onto `limited`, so the PWA surface can match contacts
 * instead of dead-ending on "install the app".
 */

type ContactPickerProperty = "name" | "tel" | "email";

type ContactPickerResult = {
  name?: string[];
  tel?: string[];
  email?: string[];
};

type ContactPickerManager = {
  select: (
    properties: ContactPickerProperty[],
    options?: { multiple?: boolean },
  ) => Promise<ContactPickerResult[]>;
  getProperties?: () => Promise<ContactPickerProperty[]>;
};

function contactPicker(): ContactPickerManager | null {
  if (typeof navigator === "undefined") return null;
  const picker = (navigator as Navigator & { contacts?: ContactPickerManager })
    .contacts;
  return picker && typeof picker.select === "function" ? picker : null;
}

function localeRegion(): string | null {
  if (typeof navigator === "undefined") return null;
  try {
    return new Intl.Locale(navigator.language).maximize().region ?? null;
  } catch {
    return null;
  }
}

export class HushhContactsWeb implements HushhContactsPlugin {
  async getPermissionState(): Promise<HushhContactsPermissionState> {
    // The Contact Picker grants per-invocation, so there is no persistent state
    // to report — only whether a prompt is reachable at all.
    return { state: contactPicker() ? "prompt" : "unavailable" };
  }

  async requestPermission(): Promise<HushhContactsPermissionState> {
    return this.getPermissionState();
  }

  async openAppSettings(): Promise<{ opened: boolean }> {
    return { opened: false };
  }

  async readContacts(options?: {
    limit?: number;
  }): Promise<HushhContactsReadResult> {
    const picker = contactPicker();
    if (!picker) {
      throw new Error("Contacts are only available in the native mobile app.");
    }

    let selected: ContactPickerResult[];
    try {
      selected = await picker.select(["name", "tel"], { multiple: true });
    } catch (error) {
      // The picker rejects when it is called outside a user gesture, and also
      // when the user dismisses it. Neither is an error worth surfacing as a
      // failure, but an empty selection is indistinguishable, so report empty.
      if (error instanceof Error && error.name === "AbortError") {
        return {
          contacts: [],
          sourcePlatform: "web",
          defaultRegion: localeRegion(),
          limited: true,
          truncated: false,
          totalAvailable: 0,
        };
      }
      throw new Error("Contacts are only available in the native mobile app.");
    }

    const limit = Math.max(1, Math.min(options?.limit ?? 500, 2000));
    const contacts = selected
      .map((entry, index) => ({
        id: `web-contact:${index}`,
        displayName: entry.name?.find((name) => name.trim()) ?? null,
        phoneNumbers: (entry.tel ?? []).filter((tel) => tel.trim()),
      }))
      .filter((contact) => contact.phoneNumbers.length > 0);

    return {
      contacts: contacts.slice(0, limit),
      sourcePlatform: "web",
      defaultRegion: localeRegion(),
      // The picker only ever returns what the user hand-picked.
      limited: true,
      truncated: contacts.length > limit,
      totalAvailable: contacts.length,
    };
  }
}

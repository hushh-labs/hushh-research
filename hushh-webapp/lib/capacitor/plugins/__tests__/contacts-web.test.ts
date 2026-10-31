import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { HushhContactsWeb } from "../contacts-web";

/**
 * The web half of contact sync, which had no test at all.
 *
 * This is the only path that runs in a browser: `navigator.contacts.select`
 * ships enabled by default in Chrome on Android and nowhere else, so every
 * decision here — what counts as "unavailable", what a dismissed sheet means,
 * why the result is always `limited` — is what desktop and iOS Safari users
 * experience as the feature being absent rather than broken.
 */

type Selected = { name?: string[]; tel?: string[] };

/**
 * These tests write to `navigator.contacts` and `globalThis.ContactsManager`,
 * which are process-global in a jsdom worker. Vitest reuses a worker across
 * files, and at least one other suite asserts the OPPOSITE — that the contacts
 * onboarding step disappears when no picker exists. So the shape here has to be
 * exactly restored, not merely deleted: capturing the original descriptors and
 * putting them back is the difference between a suite that passes on its own
 * and one that passes in every order.
 */
const ORIGINAL_CONTACTS = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "contacts",
);
const ORIGINAL_MANAGER = Object.getOwnPropertyDescriptor(
  globalThis,
  "ContactsManager",
);

function installPicker(select: (...args: unknown[]) => Promise<Selected[]>) {
  Object.defineProperty(globalThis.navigator, "contacts", {
    value: { select },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "ContactsManager", {
    value: function () {},
    configurable: true,
    writable: true,
  });
}

function restoreGlobals() {
  Reflect.deleteProperty(globalThis.navigator as object, "contacts");
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "ContactsManager");
  if (ORIGINAL_CONTACTS) {
    Object.defineProperty(globalThis.navigator, "contacts", ORIGINAL_CONTACTS);
  }
  if (ORIGINAL_MANAGER) {
    Object.defineProperty(globalThis, "ContactsManager", ORIGINAL_MANAGER);
  }
}

/** Only for the "no picker in this browser" cases. */
function removePicker() {
  Reflect.deleteProperty(globalThis.navigator as object, "contacts");
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "ContactsManager");
}

describe("contacts-web", () => {
  beforeEach(() => removePicker());
  afterEach(() => restoreGlobals());

  afterAll(() => restoreGlobals());

  describe("when the browser has no Contact Picker", () => {
    it("reports unavailable rather than denied", async () => {
      // The distinction is load-bearing. `assertContactsReadable` turns
      // `denied` into "turn it on in Settings" with an Open Settings button,
      // and `unavailable` into "use the app" with none — and on desktop there
      // is no setting to turn on, so a denial would send the person hunting
      // for a switch that does not exist.
      const state = await new HushhContactsWeb().getPermissionState();
      expect(state.state).toBe("unavailable");
    });

    it("refuses to read", async () => {
      await expect(new HushhContactsWeb().readContacts()).rejects.toThrow(
        /native mobile app/i,
      );
    });
  });

  describe("when the picker is present", () => {
    it("reports prompt, because the grant is per invocation", async () => {
      installPicker(async () => []);
      const state = await new HushhContactsWeb().getPermissionState();
      // There is no persistent permission to read back: the browser asks every
      // time and returns only what was hand-picked.
      expect(state.state).toBe("prompt");
    });

    it("always reports limited, whatever came back", async () => {
      // This flag is what makes the honest copy possible downstream — "none of
      // the contacts YOU SHARED are on One yet" rather than a claim about the
      // whole address book, which this path never sees.
      installPicker(async () => [{ name: ["Asha"], tel: ["+919876543210"] }]);
      const result = await new HushhContactsWeb().readContacts();
      expect(result.limited).toBe(true);
      expect(result.sourcePlatform).toBe("web");
    });

    it("treats a dismissed sheet as an empty pick, not a failure", async () => {
      // The picker rejects with AbortError when the person closes it. Throwing
      // there would show an error for choosing not to choose.
      installPicker(async () => {
        const abort = new Error("dismissed");
        abort.name = "AbortError";
        throw abort;
      });

      const result = await new HushhContactsWeb().readContacts();
      expect(result.contacts).toEqual([]);
      expect(result.totalAvailable).toBe(0);
      expect(result.limited).toBe(true);
    });

    it("does not blame the platform for a refusal the page caused", async () => {
      // A gesture-less call, an insecure context and a cross-origin iframe all
      // reject with something that is not AbortError. Every one of them used
      // to be reported as "Contacts are only available in the native mobile
      // app" — advice that cannot help somebody whose browser does support
      // contacts.
      installPicker(async () => {
        throw new Error("must be handling a user gesture");
      });

      await expect(new HushhContactsWeb().readContacts()).rejects.toThrow(
        /contact picker/i,
      );
      await expect(new HushhContactsWeb().readContacts()).rejects.not.toThrow(
        /native mobile app/i,
      );
    });

    it("drops entries with no phone number and honours the limit", async () => {
      // A contact with no number cannot produce a digest, so carrying it would
      // only inflate the count the UI reports back to the person.
      installPicker(async () => [
        { name: ["Has Number"], tel: ["+919876543210"] },
        { name: ["No Number"], tel: [] },
        { name: ["Blank"], tel: ["   "] },
        { name: ["Second"], tel: ["+919876543211"] },
      ]);

      const all = await new HushhContactsWeb().readContacts();
      expect(all.contacts).toHaveLength(2);

      const capped = await new HushhContactsWeb().readContacts({ limit: 1 });
      expect(capped.contacts).toHaveLength(1);
      expect(capped.truncated).toBe(true);
    });

    it.each([10_000, 10_001])(
      "reads up to 10,000 selected contacts from a %i-contact pick",
      async (selectedCount) => {
        installPicker(async () => Array.from({ length: selectedCount }, (_, index) => ({
          name: [`Contact ${index + 1}`],
          tel: [`+1212${String(index).padStart(7, "0")}`],
        })));

        const result = await new HushhContactsWeb().readContacts({ limit: 20_000 });

        expect(result.contacts).toHaveLength(10_000);
        expect(result.contacts.at(-1)?.displayName).toBe("Contact 10000");
        expect(result.totalAvailable).toBe(selectedCount);
        expect(result.truncated).toBe(selectedCount > 10_000);
        expect(result.limited).toBe(true);
      },
    );
  });

  describe("openAppSettings", () => {
    it("reports that it did nothing, so no dead button is offered", async () => {
      // A browser has no app settings page to open. `describeContactSyncOutcome`
      // reads this to decide between an "Open Settings" action and a "Check
      // more" one; a button that silently does nothing spends trust for free.
      installPicker(async () => []);
      const opened = await new HushhContactsWeb().openAppSettings();
      expect(opened.opened).toBe(false);
    });
  });
});

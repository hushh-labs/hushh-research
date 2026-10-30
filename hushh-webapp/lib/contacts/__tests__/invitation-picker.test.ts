import { afterEach, describe, expect, it, vi } from "vitest";
import { HushhContactsWeb } from "@/lib/capacitor/plugins/contacts-web";

const original = Object.getOwnPropertyDescriptor(navigator, "contacts");
afterEach(() => {
  vi.unstubAllEnvs();
  if (original) Object.defineProperty(navigator, "contacts", original);
  else Reflect.deleteProperty(navigator, "contacts");
});

describe("invitation contact picker", () => {
  it("probes email before the tap and selects synchronously with original phone provenance", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONTACT_INVITATIONS_ENABLED", "true");
    const getProperties = vi.fn().mockResolvedValue(["name", "tel", "email"]);
    const select = vi
      .fn()
      .mockResolvedValue([
        { name: ["Private"], tel: [""], email: ["private@example.com"] },
      ]);
    Object.defineProperty(navigator, "contacts", {
      configurable: true,
      value: { getProperties, select },
    });
    const plugin = new HushhContactsWeb();
    await plugin.getPermissionState();
    getProperties.mockClear();
    const reading = plugin.readContacts();
    expect(select).toHaveBeenCalledWith(["name", "tel", "email"], {
      multiple: true,
    });
    expect(getProperties).not.toHaveBeenCalled();
    expect((await reading).contacts[0]).toMatchObject({
      phoneNumbers: [],
      hasPhoneEntries: true,
      emailAddresses: ["private@example.com"],
    });
  });

  it("retains the original phone-only picker contract with the feature disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONTACT_INVITATIONS_ENABLED", "false");
    const getProperties = vi.fn().mockResolvedValue(["name", "tel", "email"]);
    const select = vi
      .fn()
      .mockResolvedValue([
        { tel: ["+14155550101"], email: ["private@example.com"] },
      ]);
    Object.defineProperty(navigator, "contacts", {
      configurable: true,
      value: { getProperties, select },
    });
    const plugin = new HushhContactsWeb();
    await plugin.getPermissionState();
    const result = await plugin.readContacts();
    expect(getProperties).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledWith(["name", "tel"], { multiple: true });
    expect(result.contacts[0]).not.toHaveProperty("emailAddresses");
  });
});

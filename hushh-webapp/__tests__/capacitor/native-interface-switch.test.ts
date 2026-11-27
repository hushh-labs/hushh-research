import { afterEach, expect, it, vi } from "vitest";
import { applySavedNativeInterface } from "@/lib/capacitor/apply-native-interface";
import { customNativePresentationEnabled } from "@/lib/capacitor/native-presentation-policy";
import { interfacePresentationSnapshot } from "@/lib/capacitor/native-interface-revision";

const host = vi.hoisted(() => ({
  applyInterfacePreference: vi.fn(),
  getCapabilities: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("@/lib/capacitor/native-drawers", () => ({
  nativeDrawers: () => host,
  nativeDrawerAcknowledged: <T>(operation: Promise<T>) => operation,
  nativeWorkspaceRetirementBarrier: host.retire,
}));

function installBootstrap(live: boolean) {
  vi.stubGlobal("__HUSHH_NATIVE_DRAWER_BOOTSTRAP__", {
    contractVersion: 1, documentId: "current", nativeInterfacePreference: true,
    enabled: false, coherentShell: false, liveInterfaceSwitch: live,
  });
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("keeps the complete standard interface on an older host", async () => {
  installBootstrap(false);
  expect(await applySavedNativeInterface(true)).toBe(false);
  expect(host.applyInterfacePreference).not.toHaveBeenCalled();
});

it("promotes only the current document after withdrawal and reconciles an uncertain response", async () => {
  installBootstrap(true);
  host.retire.mockResolvedValue(true);
  host.applyInterfacePreference.mockImplementation(async ({ documentId, enabled }) => {
    expect(interfacePresentationSnapshot()).toBe(-1);
    expect(host.retire).toHaveBeenCalled();
    return { documentId, enabled };
  });
  expect(await applySavedNativeInterface(true)).toBe(true);
  expect(customNativePresentationEnabled()).toBe(true);

  host.applyInterfacePreference.mockRejectedValueOnce(new Error("lost response"));
  host.getCapabilities.mockResolvedValueOnce({ interfaceDocumentId: "previous", interfaceEnabled: false });
  await expect(applySavedNativeInterface(false)).rejects.toThrow("lost response");
  expect(customNativePresentationEnabled()).toBe(true);

  host.applyInterfacePreference.mockRejectedValueOnce(new Error("lost response"));
  host.getCapabilities.mockResolvedValueOnce({ interfaceDocumentId: "current", interfaceEnabled: false });
  expect(await applySavedNativeInterface(false)).toBe(true);
  expect(customNativePresentationEnabled()).toBe(false);
  expect(interfacePresentationSnapshot()).toBeGreaterThan(0);
});

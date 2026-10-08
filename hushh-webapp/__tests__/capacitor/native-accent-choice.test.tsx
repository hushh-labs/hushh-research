import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { NativeAccentChoice } from "@/components/app-ui/native-accent-choice";
import type { ChromeProjection } from "@/lib/capacitor/native-chrome";

const bridge = vi.hoisted(() => ({ platform: "ios", documentId: "synthetic-document", prepare: vi.fn(), activate: vi.fn(),
  retire: vi.fn(), update: vi.fn(), getCapabilities: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => bridge.platform !== "web", getPlatform: () => bridge.platform },
  registerPlugin: () => ({ ...bridge, addListener: async () => ({ remove: async () => undefined }) }),
}));
vi.mock("@/lib/capacitor/session-privacy", () => ({ nativeDocumentId: () => bridge.documentId,
  subscribeNativeSessionPrivacy: async () => ({ remove: async () => undefined }) }));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({ useVoiceSurfaceMetadata: () => null, getVoiceSurfaceMetadata: () => null }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

describe("native color preference", () => {
  beforeEach(() => {
    bridge.platform = "ios";
    bridge.documentId = crypto.randomUUID();
    document.documentElement.style.setProperty("--app-accent", "#007aff");
    document.documentElement.style.setProperty("--muted-foreground", "#8e8e93");
    bridge.getCapabilities.mockReset().mockResolvedValue({ contractVersion: 2, families: [], independentControls: true });
    bridge.prepare.mockReset().mockImplementation(async (value: ChromeProjection) => ({ ...value, phase: "prepared" }));
    bridge.activate.mockReset().mockImplementation(async value => ({ ...value, phase: "active" }));
    bridge.retire.mockReset().mockImplementation(async value => ({ ...value, phase: "retired" }));
    bridge.update.mockReset().mockImplementation(async value => value);
  });
  afterEach(async () => { cleanup(); await act(async () => { await Promise.resolve(); }); vi.restoreAllMocks(); });

  it.each(["web", "android", "unsupported-ios"])("keeps the selected color inside its established fallback on %s", async platform => {
    bridge.platform = platform === "unsupported-ios" ? "ios" : platform;
    const view = render(<NativeAccentChoice value="gold" owner="synthetic-owner" context="preferences" eligible />);
    const trigger = view.getByRole("combobox", { name: "App accent color" });
    await waitFor(() => expect(trigger).toBeVisible());
    expect(trigger).toHaveTextContent("Molten Gold");
    expect(bridge.prepare).not.toHaveBeenCalled();
  });

  it("admits the native control only with current owner and bounded visible geometry", async () => {
    bridge.getCapabilities.mockResolvedValue({ contractVersion: 2, families: ["accent"], independentControls: true, inPlaceUpdates: true });
    let x = 2;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x, y: 60, width: 172, height: 44, top: 60, left: x, right: x + 172, bottom: 104, toJSON: () => ({}),
    }));
    const view = render(<NativeAccentChoice value="gold" owner={null} context="preferences" eligible />);
    await act(async () => { await Promise.resolve(); });
    expect(bridge.prepare).not.toHaveBeenCalled();
    x = -1;
    view.rerender(<NativeAccentChoice value="gold" owner="synthetic-owner" context="preferences" eligible />);
    await act(async () => { await Promise.resolve(); });
    expect(bridge.prepare).not.toHaveBeenCalled();
    x = 2;
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledOnce());
    expect(bridge.prepare.mock.calls[0]![0]).toMatchObject({ kind: "accent", value: "gold", frame: { width: 172, height: 44 } });
  });
});

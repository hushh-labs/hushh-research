import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import {
  dismissTopmostOverlay,
  pushAndroidBackHandler,
  resolveAndroidBack,
  useAndroidBack,
} from "@/lib/navigation/android-back";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

const native = vi.hoisted(() => ({ back: null as null | ((event: { canGoBack: boolean }) => void), minimize: vi.fn(), remove: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }));
vi.mock("@capacitor/app", () => ({ App: {
  addListener: async (_name: string, back: typeof native.back) => { native.back = back; return { remove: native.remove }; },
  minimizeApp: native.minimize,
} }));
vi.mock("@/lib/utils/browser-navigation", () => ({ requestInternalAppNavigation: vi.fn() }));

function mountDialog(id: string, state = "open", role = "dialog") {
  const el = document.createElement("div");
  el.setAttribute("role", role);
  el.setAttribute("data-state", state);
  el.id = id;
  document.body.appendChild(el);
  return el;
}

describe("android back", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
    vi.clearAllMocks();
  });

  it("the real native listener climbs a cold Settings circle and minimises only at a root", async () => {
    window.history.replaceState(null, "", "/one/location?action=circle-detail&source=settings&circleId=sample");
    native.back = null;
    const hook = renderHook(() => useAndroidBack());
    await waitFor(() => expect(native.back).not.toBeNull());
    act(() => native.back!({ canGoBack: false }));
    expect(requestInternalAppNavigation).toHaveBeenCalledWith(expect.objectContaining({ href: "/one/location?action=settings", replace: true, transitionMode: "contextual" }));
    expect(native.minimize).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/one");
    act(() => native.back!({ canGoBack: true }));
    expect(native.minimize).toHaveBeenCalledOnce();
    hook.unmount();
    expect(native.remove).toHaveBeenCalledOnce();
  });

  it("closes the topmost open sheet through Escape and goes nowhere else", () => {
    mountDialog("below");
    const top = mountDialog("top");
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") seen.push((event.target as HTMLElement).id);
    });
    const navigateParent = vi.fn().mockReturnValue(true);
    const minimize = vi.fn();

    expect(resolveAndroidBack(true, { navigateParent, minimize })).toBe("overlay");
    expect(seen).toEqual([top.id]);
    expect(navigateParent).not.toHaveBeenCalled();
  });

  it("ignores closed dialogs and counts alert dialogs", () => {
    mountDialog("closed", "closed");
    expect(dismissTopmostOverlay()).toBe(false);
    mountDialog("alert", "open", "alertdialog");
    expect(dismissTopmostOverlay()).toBe(true);
  });

  it("lets the most recent screen own Back when nothing is open", () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = pushAndroidBackHandler(first);
    const releaseSecond = pushAndroidBackHandler(second);
    const navigateParent = vi.fn().mockReturnValue(true);

    expect(resolveAndroidBack(true, { navigateParent, minimize: vi.fn() })).toBe("screen");
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(navigateParent).not.toHaveBeenCalled();

    releaseSecond();
    releaseFirst();
  });

  it("uses the authored parent regardless of browser history, and minimises only at root", () => {
    const navigateParent = vi.fn().mockReturnValue(true);
    const minimize = vi.fn();
    expect(resolveAndroidBack(true, { navigateParent, minimize })).toBe("parent");
    navigateParent.mockReturnValue(false);
    expect(resolveAndroidBack(true, { navigateParent, minimize })).toBe("minimize");
    expect(navigateParent).toHaveBeenCalledTimes(2);
    expect(minimize).toHaveBeenCalledOnce();
  });
});

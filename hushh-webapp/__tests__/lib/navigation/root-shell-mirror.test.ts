// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ROOT_MIRRORED_SHELL_VARS, createRootShellMirror } from "@/lib/navigation/root-shell-mirror";

/**
 * A tab switch between routes with the same shell geometry must not touch
 * <html> at all; a geometry change writes only the keys that changed; and
 * whatever was on <html> before the shell mounted comes back on unmount.
 */
describe("root shell mirror", () => {
  const dataset = { appShellOffsetMode: "standard", appShellRouteLayout: "standard", appTopShellProfile: "one" };
  const geometry = (tabs: string) => (key: string) =>
    key === "--top-tabs-total" ? tabs : key === "--bottom-chrome-hide-distance" ? "72px" : "";

  it("writes nothing on a navigation that keeps the geometry", () => {
    const root = document.createElement("html");
    const setProperty = vi.spyOn(root.style, "setProperty");
    const removeProperty = vi.spyOn(root.style, "removeProperty");
    const mirror = createRootShellMirror(root);

    expect(mirror.apply(geometry("0px"), dataset)).toBe(2 + 3);
    setProperty.mockClear();
    expect(mirror.apply(geometry("0px"), dataset)).toBe(0);
    expect(setProperty).not.toHaveBeenCalled();
    expect(removeProperty).not.toHaveBeenCalled();
  });

  it("writes only the keys whose value changed", () => {
    const root = document.createElement("html");
    const mirror = createRootShellMirror(root);
    mirror.apply(geometry("0px"), dataset);
    const setProperty = vi.spyOn(root.style, "setProperty");
    expect(mirror.apply(geometry("44px"), { ...dataset, appTopShellProfile: "kai" })).toBe(2);
    expect(setProperty).toHaveBeenCalledTimes(1);
    expect(setProperty).toHaveBeenCalledWith("--top-tabs-total", "44px");
    expect(root.dataset.appTopShellProfile).toBe("kai");
  });

  it("restores the pre-mount values on unmount and clears the flags", () => {
    const root = document.createElement("html");
    root.style.setProperty("--top-tabs-total", "12px");
    const mirror = createRootShellMirror(root);
    mirror.apply(geometry("44px"), dataset);
    mirror.restore();
    expect(root.style.getPropertyValue("--top-tabs-total")).toBe("12px");
    expect(root.style.getPropertyValue("--bottom-chrome-hide-distance")).toBe("");
    expect(root.dataset.appShellOffsetMode).toBeUndefined();
    // The list is the shell's whole dependency chain; a key removed here
    // would leave a route without its offset.
    expect(ROOT_MIRRORED_SHELL_VARS).toContain("--top-shell-reserved-height");
    expect(ROOT_MIRRORED_SHELL_VARS).toContain("--bottom-chrome-hide-distance");
  });
});

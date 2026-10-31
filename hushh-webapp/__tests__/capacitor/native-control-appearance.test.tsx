import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { isCurrentNativeControlAppearance, useNativeControlAppearance } from "@/lib/capacitor/native-control-appearance";

vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

it("projects committed on-accent ink and rejects an unresolved foreground", async () => {
  const root = document.documentElement;
  const previousStyle = root.getAttribute("style");
  const previousClass = root.className;
  const previousAccent = root.getAttribute("data-accent");
  try {
    root.classList.remove("dark");
    root.style.setProperty("--app-accent", "#007aff");
    root.style.setProperty("--app-accent-fg", "#ffffff");
    const view = renderHook(() => useNativeControlAppearance("on-accent"));
    await waitFor(() => expect(view.result.current).toMatchObject({
      appearance: "light", accentHex: "#007aff", foregroundHex: "#ffffff",
    }));
    act(() => {
      root.style.setProperty("--app-accent", "#d4a574");
      root.style.setProperty("--app-accent-fg", "#1d1d1f");
      root.classList.add("dark");
    });
    await waitFor(() => expect(view.result.current).toMatchObject({
      appearance: "dark", accentHex: "#d4a574", foregroundHex: "#1d1d1f",
    }));
    const committed = view.result.current!;
    root.style.removeProperty("--app-accent-fg");
    expect(isCurrentNativeControlAppearance(committed, "on-accent")).toBe(false);
    act(() => root.setAttribute("data-accent", "gold"));
    await waitFor(() => expect(view.result.current).toBeNull());
    view.unmount();
  } finally {
    if (previousStyle === null) root.removeAttribute("style"); else root.setAttribute("style", previousStyle);
    root.className = previousClass;
    if (previousAccent === null) root.removeAttribute("data-accent"); else root.setAttribute("data-accent", previousAccent);
  }
});

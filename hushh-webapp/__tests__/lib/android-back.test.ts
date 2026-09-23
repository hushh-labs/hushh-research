import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dismissTopmostOverlay,
  pushAndroidBackHandler,
  resolveAndroidBack,
} from "@/lib/navigation/android-back";

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
  });

  it("closes the topmost open sheet through Escape and goes nowhere else", () => {
    mountDialog("below");
    const top = mountDialog("top");
    const seen: string[] = [];
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") seen.push((event.target as HTMLElement).id);
    });
    const goBack = vi.fn();
    const minimize = vi.fn();

    expect(resolveAndroidBack(true, { goBack, minimize })).toBe("overlay");
    expect(seen).toEqual([top.id]);
    expect(goBack).not.toHaveBeenCalled();
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
    const goBack = vi.fn();

    expect(resolveAndroidBack(true, { goBack, minimize: vi.fn() })).toBe("screen");
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(goBack).not.toHaveBeenCalled();

    releaseSecond();
    releaseFirst();
  });

  it("goes back in history, and minimises rather than quitting at the root", () => {
    const goBack = vi.fn();
    const minimize = vi.fn();
    expect(resolveAndroidBack(true, { goBack, minimize })).toBe("history");
    expect(resolveAndroidBack(false, { goBack, minimize })).toBe("minimize");
    expect(goBack).toHaveBeenCalledOnce();
    expect(minimize).toHaveBeenCalledOnce();
  });
});

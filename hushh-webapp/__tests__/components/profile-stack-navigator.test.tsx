import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileStackNavigator } from "@/components/profile/profile-stack-navigator";

function mountScrollRoot(attribute: string) {
  const root = document.createElement("div");
  root.setAttribute(attribute, "true");
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    root.scrollTop = options.top ?? 0;
  });
  Object.defineProperty(root, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  document.body.append(root);
  return { root, scrollTo };
}

describe("ProfileStackNavigator", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document
      .querySelectorAll(
        '[data-profile-pane-scroll-root="true"], [data-app-scroll-root="true"]',
      )
      .forEach((root) => root.remove());
  });

  it("cannot prune a reopened panel from an older pop or activate a superseded entry frame", () => {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++sequence, callback); return sequence; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const entry = { key: "security", title: "Security", content: <div>Method controls</div> };
    const view = render(<ProfileStackNavigator rootContent={<div>Root</div>} entries={[entry]} />);
    view.rerender(<ProfileStackNavigator rootContent={<div>Root</div>} entries={[]} />);
    view.rerender(<ProfileStackNavigator rootContent={<div>Root</div>} entries={[entry]} />);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByText("Method controls").closest("[data-profile-stack-screen]")).toHaveAttribute("data-profile-stack-active", "true");
    const detail = { key: "detail", title: "Method", content: <div>Details</div> };
    view.rerender(<ProfileStackNavigator rootContent={<div>Root</div>} entries={[entry, detail]} />);
    view.rerender(<ProfileStackNavigator rootContent={<div>Root</div>} entries={[entry]} />);
    act(() => { [...frames.values()].forEach((callback) => callback(0)); frames.clear(); });
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByText("Details")).toBeNull();
    expect(screen.getByText("Method controls").closest("[data-profile-stack-screen]")).toHaveAttribute("data-profile-stack-active", "true");
    view.rerender(<ProfileStackNavigator rootContent={<div>Root</div>} entries={[entry, detail]} />);
    const staleActivation = [...frames.values()][0];
    expect(staleActivation).toBeDefined();
    const deeper = { key: "deeper", title: "More", content: <div>More controls</div> };
    view.rerender(<ProfileStackNavigator rootContent={<div>Root</div>} entries={[entry, detail, deeper]} />);
    const newestFrame = [...frames.keys()].at(-1)!;
    expect(frames.has(newestFrame)).toBe(true);
    // A callback already dispatched by the host can survive cancellation.
    // It must not clear the newer pending handle before unmount cleans it up.
    act(() => staleActivation(0));
    view.unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(newestFrame);
    expect(frames.has(newestFrame)).toBe(false);
  });

  it("keeps shared stack screens live when their content updates", () => {
    const { rerender } = render(
      <ProfileStackNavigator
        rootContent={<div>Root</div>}
        entries={[
          {
            key: "panel:my-data",
            title: "Personal Knowledge Model",
            content: <div>Checking your saved domains</div>,
          },
        ]}
      />,
    );

    expect(screen.getByText("Checking your saved domains")).toBeTruthy();

    rerender(
      <ProfileStackNavigator
        rootContent={<div>Root</div>}
        entries={[
          {
            key: "panel:my-data",
            title: "Personal Knowledge Model",
            content: <div>Financial domain ready</div>,
          },
        ]}
      />,
    );

    expect(screen.queryByText("Checking your saved domains")).toBeNull();
    expect(screen.getByText("Financial domain ready")).toBeTruthy();
  });
  it("preserves root rendering stability with empty stack entries", () => {
    render(
      <ProfileStackNavigator
        rootContent={<div>Root workspace</div>}
        entries={[]}
      />,
    );

    expect(screen.getByText("Root workspace")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
  });

  it("resets the route scroll root even while a closing Profile pane remains mounted", async () => {
    const appRoot = mountScrollRoot("data-app-scroll-root");
    const paneRoot = mountScrollRoot("data-profile-pane-scroll-root");
    const { rerender } = render(
      <ProfileStackNavigator rootContent={<div>Root</div>} entries={[]} />,
    );

    appRoot.scrollTo.mockClear();
    paneRoot.scrollTo.mockClear();
    appRoot.root.scrollTop = 96;
    paneRoot.root.scrollTop = 48;

    rerender(
      <ProfileStackNavigator
        rootContent={<div>Root</div>}
        entries={[
          {
            key: "panel:security",
            title: "Security & privacy",
            content: <div>Security content</div>,
          },
        ]}
      />,
    );

    await waitFor(() => expect(appRoot.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "auto",
    }));
    expect(paneRoot.scrollTo).not.toHaveBeenCalled();
  });

  it("uses the pane scroll root for in-pane Profile navigation", async () => {
    const appRoot = mountScrollRoot("data-app-scroll-root");
    const paneRoot = mountScrollRoot("data-profile-pane-scroll-root");
    const { rerender } = render(
      <ProfileStackNavigator
        rootContent={<div>Root</div>}
        entries={[]}
        resetScroll={false}
      />,
    );

    appRoot.scrollTo.mockClear();
    paneRoot.scrollTo.mockClear();
    paneRoot.root.scrollTop = 48;

    rerender(
      <ProfileStackNavigator
        rootContent={<div>Root</div>}
        resetScroll={false}
        entries={[
          {
            key: "panel:security",
            title: "Security & privacy",
            content: <div>Security content</div>,
          },
        ]}
      />,
    );

    await waitFor(() => expect(paneRoot.scrollTo).toHaveBeenCalledWith({
      top: 0,
      behavior: "auto",
    }));
    expect(appRoot.scrollTo).not.toHaveBeenCalled();
  });

  it("owns native detail scrolling without touching a retained web pane or Chat", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++sequence, callback); return sequence; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    const appRoot = mountScrollRoot("data-app-scroll-root");
    const stalePane = mountScrollRoot("data-profile-pane-scroll-root");
    const nativeRoot = mountScrollRoot("data-native-feature-scroll-root");
    const activeEntry = vi.fn();
    const view = render(<ProfileStackNavigator rootContent={<div>Root</div>} entries={[]} resetScroll={false} onActiveEntryChange={activeEntry} />,
      { container: nativeRoot.root });
    activeEntry.mockClear();
    nativeRoot.scrollTo.mockClear();
    nativeRoot.root.scrollTop = 72;
    view.rerender(<ProfileStackNavigator rootContent={<div>Root</div>} resetScroll={false} onActiveEntryChange={activeEntry}
      entries={[{ key: "preferences", title: "Preferences", content: <div>Public controls</div> }]} />);
    // The outgoing pane owns scroll until the entry frame. Mounting the new
    // screen must not reset it or save a corrupted zero return position.
    expect(nativeRoot.root.scrollTop).toBe(72);
    expect(nativeRoot.scrollTo).not.toHaveBeenCalled();
    expect(activeEntry).not.toHaveBeenCalled();
    act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); });
    expect(activeEntry).toHaveBeenLastCalledWith({ key: "preferences", title: "Preferences" });
    expect(nativeRoot.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    nativeRoot.root.scrollTop = 24;
    nativeRoot.scrollTo.mockClear();
    view.rerender(<ProfileStackNavigator rootContent={<div>Root</div>} resetScroll={false} entries={[]} onActiveEntryChange={activeEntry} />);
    expect(activeEntry).toHaveBeenLastCalledWith(null);
    expect(nativeRoot.root.scrollTop).toBe(72);
    expect(appRoot.scrollTo).not.toHaveBeenCalled();
    expect(stalePane.scrollTo).not.toHaveBeenCalled();
    nativeRoot.root.remove();
  });
});

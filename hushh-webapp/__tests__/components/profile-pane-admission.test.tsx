import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfilePane } from "@/components/app-ui/profile-pane";
import { previewProfilePane } from "@/lib/navigation/profile-pane";

const vault = vi.hoisted(() => ({ isVaultUnlocked: false }));
const url = vi.hoisted(() => ({
  query: "profile_pane=1&profile_panel=preferences",
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(url.query),
}));
const profilePage = vi.hoisted(() => ({ renders: 0 }));
vi.mock("@/components/profile/profile-workspace-page", () => ({
  ProfilePage: ({ paneLocation }: { paneLocation?: { panel: string | null } }) => {
    profilePage.renders += 1;
    return (
      <div data-testid="pane-body" data-panel={paneLocation?.panel ?? "root"}>
        Preferences content
      </div>
    );
  },
}));

// Animation frames run only when a test paints one, so a test can tell what
// the pane committed for the frame that starts its slide.
let pendingFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
beforeEach(() => {
  vault.isVaultUnlocked = false;
  url.query = "profile_pane=1&profile_panel=preferences";
  pendingFrames = new Map();
  profilePage.renders = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextFrameId++;
    pendingFrames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    pendingFrames.delete(id);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function paintFrame() {
  const callbacks = [...pendingFrames.values()];
  pendingFrames.clear();
  act(() => {
    for (const callback of callbacks) callback(performance.now());
  });
}

function paintFirstFrames() {
  paintFrame();
  paintFrame();
}

function pull(type: string, target: Element, x: number, y: number, time: number) {
  const point = { identifier: 1, clientX: x, clientY: y };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : [point] },
    changedTouches: { value: [point] },
    timeStamp: { value: time },
  });
  fireEvent(target, event);
}

it("keeps the drag preview inert and does not mount protected Profile content before admission", () => {
  vi.useFakeTimers();
  vault.isVaultUnlocked = true;
  const change = vi.fn();
  const view = render(<ProfilePane open={false} owner="owner-a" onOpenChange={change} />);
  const preview = view.container.querySelector<HTMLElement>("[data-profile-preview]")!;
  Object.defineProperty(preview, "offsetWidth", { value: 390 });
  act(() => previewProfilePane({ phase: "drag", distance: 80 }));
  expect(preview.hidden).toBe(false);
  expect(preview.style.transform).toBe("translate3d(310px,0,0)");
  expect(preview).toHaveAttribute("inert");
  expect(preview).toHaveAttribute("aria-hidden", "true");
  expect(profilePage.renders).toBe(0);
  expect(change).not.toHaveBeenCalled();
  act(() => previewProfilePane({ phase: "commit", distance: 80 }));
  act(() => vi.advanceTimersByTime(500));
  expect(preview.hidden).toBe(true); // An unadmitted request cannot strand a shell.
  act(() => previewProfilePane({ phase: "drag", distance: 90 }));
  view.rerender(<ProfilePane open={false} owner="owner-b" onOpenChange={change} />);
  expect(preview.hidden).toBe(true);
  expect(profilePage.renders).toBe(0);
});

it("tracks an owned Profile close without moving the page and commits exactly once", () => {
  vi.useFakeTimers();
  vault.isVaultUnlocked = true;
  const close = vi.fn();
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((node) => {
    const style = computedStyle(node);
    return new Proxy(style, { get: (target, key) => key === "animationName" && node.getAttribute("data-slot") === "sheet-content"
      ? node.getAttribute("data-state") === "closed" ? "profile-pull-exit" : "sheet-surface-enter"
      : Reflect.get(target, key, target) });
  });
  let reopen = () => {};
  function ControlledPane() {
    const [open, setOpen] = useState(true);
    useLayoutEffect(() => { reopen = () => setOpen(true); }, []);
    return <ProfilePane open={open} onOpenChange={(next) => { close(next); setOpen(next); }} />;
  }
  const view = render(<ControlledPane />);
  const panel = screen.getByTestId("profile-pane");
  Object.defineProperty(panel, "offsetWidth", { value: 390 });
  const title = screen.getByRole("heading");
  const scrim = document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]')!;
  pull("touchstart", title, 100, 150, 0);
  pull("touchmove", title, 150, 152, 120);
  expect(panel.style.transform).toBe("translate3d(50px, 0, 0)");
  expect(panel.style.transition).toBe("none");
  expect(Number(scrim.style.opacity)).toBeCloseTo(1 - 50 / 390);
  expect(document.body.style.transform).toBe("");
  expect(close).not.toHaveBeenCalled();
  pull("touchend", title, 205, 153, 240);
  pull("touchend", title, 205, 153, 240);
  expect(close).toHaveBeenCalledExactlyOnceWith(false);
  expect(panel.dataset.profilePull).toBe("exit");
  expect(panel).toHaveAttribute("data-state", "closed");
  expect(panel.style.getPropertyValue("--profile-pull-x")).toBe("50px");
  act(() => reopen());
  expect(panel).toHaveAttribute("data-state", "open");
  expect(panel.style.transform).toBe("translate3d(0px, 0, 0)");
  act(() => vi.advanceTimersByTime(200));
  expect(panel).not.toHaveAttribute("data-profile-pull");
  expect(panel.style.transform).toBe("");
  view.unmount();
  expect(panel.style.transform).toBe("");
});

it("freezes a re-grab at its current rendered position before the next movement", () => {
  vi.useFakeTimers();
  vault.isVaultUnlocked = true;
  const close = vi.fn();
  const view = render(<ProfilePane open onOpenChange={close} />);
  const panel = screen.getByTestId("profile-pane");
  Object.defineProperty(panel, "offsetWidth", { value: 390 });
  const title = screen.getByRole("heading");
  pull("touchstart", title, 100, 150, 0);
  pull("touchmove", title, 125, 151, 120);
  pull("touchend", title, 125, 151, 240);
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((node) => {
    const style = computedStyle(node);
    return node === panel ? new Proxy(style, { get: (target, key) => key === "transform"
      ? "matrix(1, 0, 0, 1, 12, 0)" : Reflect.get(target, key, target) }) : style;
  });
  pull("touchstart", title, 100, 150, 250);
  expect(panel.style.transform).toBe("translate3d(12px, 0, 0)");
  expect(panel.style.transition).toBe("none");
  act(() => vi.advanceTimersByTime(500));
  expect(panel.style.transform).toBe("translate3d(12px, 0, 0)");
  pull("touchcancel", title, 100, 150, 260);
  expect(close).not.toHaveBeenCalled();
  view.unmount();
});

it("keeps Profile scroll, fields, horizontal rails and nested dialogs outside the close gesture", () => {
  vault.isVaultUnlocked = true;
  const close = vi.fn();
  const view = render(<ProfilePane open onOpenChange={close} />);
  const panel = screen.getByTestId("profile-pane");
  Object.defineProperty(panel, "offsetWidth", { value: 390 });
  const title = screen.getByRole("heading");
  const swipe = (target: Element, vertical = false) => {
    pull("touchstart", target, 100, 150, 0);
    pull("touchmove", target, vertical ? 105 : 210, vertical ? 270 : 152, 120);
    pull("touchend", target, 220, vertical ? 290 : 152, 240);
  };
  swipe(title, true);
  swipe(screen.getByRole("button", { name: "Close Profile" }));
  const field = document.createElement("input");
  panel.append(field);
  swipe(field);
  const rail = document.createElement("div");
  rail.style.overflowX = "auto";
  Object.defineProperties(rail, { scrollWidth: { value: 600 }, clientWidth: { value: 200 } });
  panel.append(rail);
  swipe(rail);
  const dialog = document.createElement("div");
  dialog.dataset.slot = "alert-dialog-content";
  dialog.dataset.state = "open";
  document.body.append(dialog);
  swipe(title);
  dialog.remove();
  expect(close).not.toHaveBeenCalled();
  expect(panel.style.transform).toBe("");
  pull("touchstart", title, 100, 150, 0);
  pull("touchmove", title, 125, 151, 120);
  pull("touchend", title, 125, 151, 240);
  expect(panel.style.transform).toBe("translate3d(0px, 0, 0)");
  expect(close).not.toHaveBeenCalled();
  view.unmount();
});

it("defers a URL-requested pane until unlock and removes it immediately on relock", () => {
  const onOpenChange = vi.fn();
  const view = render(<ProfilePane open onOpenChange={onOpenChange} />);
  expect(screen.queryByTestId("profile-pane")).toBeNull();
  vault.isVaultUnlocked = true;
  // The real vault context causes memoized ProfilePane to update when its
  // value changes. This test uses a plain mocked hook, so change a prop to
  // model that context-driven render without removing the production memo.
  view.rerender(
    <ProfilePane
      open
      onOpenChange={(nextOpen) => onOpenChange(nextOpen)}
    />,
  );
  paintFirstFrames();
  expect(screen.getByText("Preferences content")).toBeTruthy();
  vault.isVaultUnlocked = false;
  view.rerender(<ProfilePane open onOpenChange={onOpenChange} />);
  expect(screen.queryByTestId("profile-pane")).toBeNull();
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("anchors the custom close button and keeps the nested back control separate", () => {
  vault.isVaultUnlocked = true;
  const onOpenChange = vi.fn();

  render(<ProfilePane open onOpenChange={onOpenChange} />);

  const close = screen.getByRole("button", { name: "Close Profile" });
  const slot = close.closest<HTMLElement>('[data-native-chrome-slot="profile-close"]')!;
  expect(slot.style.right).toBe(
    "max(1rem, env(safe-area-inset-right, 0px))",
  );
  expect(slot.style.left).toBe("");
  expect(screen.getByRole("button", { name: "Back in Profile" })).toBeTruthy();

  fireEvent.click(close);
  expect(onOpenChange).toHaveBeenCalledWith(false);

  vault.isVaultUnlocked = false;
});

it("focuses the Profile heading rather than pinning Close and returns only to the current owner's opener", async () => {
  vault.isVaultUnlocked = true;
  url.query = "profile_pane=1";
  let replaceOwner = () => {};
  function FocusPane() {
    const [open, setOpen] = useState(false);
    const [owner, setOwner] = useState("owner-a");
    const returnFocus = useRef<{ owner: string; target: HTMLElement } | null>(null);
    useLayoutEffect(() => { replaceOwner = () => setOwner("owner-b"); }, []);
    return <>
      <button onClick={(event) => {
        returnFocus.current = { owner, target: event.currentTarget }; setOpen(true);
      }}>Open authored Profile</button>
      <ProfilePane open={open} owner={owner} onOpenChange={setOpen} returnFocusRef={returnFocus} />
    </>;
  }
  render(<FocusPane />);
  const opener = screen.getByRole("button", { name: "Open authored Profile" });
  fireEvent.click(opener);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Profile" })).toHaveFocus());
  expect(screen.getByRole("button", { name: "Close Profile" })).not.toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Close Profile" }));
  await waitFor(() => expect(opener).toHaveFocus());
  fireEvent.click(opener);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Profile" })).toHaveFocus());
  act(() => replaceOwner());
  fireEvent.click(screen.getByRole("button", { name: "Close Profile" }));
  await waitFor(() => expect(screen.queryByTestId("profile-pane")).toBeNull());
  expect(opener).not.toHaveFocus(); // A stale owner's close cannot steal focus.
});

it("holds the open location while the pane closes, so the exit is one motion", () => {
  // Closing drops the pane query, which also resets the URL location to the
  // root. The sheet keeps its content mounted for the exit slide; if that
  // content followed the URL, the header retitled to "Profile" and the inner
  // stack slid back while the sheet slid out.
  vault.isVaultUnlocked = true;
  url.query = "profile_pane=1&profile_panel=preferences";
  const onOpenChange = vi.fn();
  const view = render(<ProfilePane open onOpenChange={onOpenChange} />);
  paintFirstFrames();
  expect(screen.getByText("Appearance & preferences")).toBeTruthy();

  url.query = "";
  view.rerender(
    <ProfilePane open onOpenChange={(nextOpen) => onOpenChange(nextOpen)} />,
  );
  expect(screen.getByText("Appearance & preferences")).toBeTruthy();
  expect(screen.queryByText("Profile", { selector: "h2" })).toBeNull();
  expect(screen.getByTestId("pane-body").dataset.panel).toBe("preferences");

  // Reopening follows the URL again.
  url.query = "profile_pane=1";
  view.rerender(<ProfilePane open onOpenChange={onOpenChange} />);
  expect(screen.getByTestId("pane-body").dataset.panel).toBe("root");

  vault.isVaultUnlocked = false;
  url.query = "profile_pane=1&profile_panel=preferences";
});

it("starts the slide with the header and shell, and builds the Profile page after its first frame", () => {
  // Mounting the whole Profile page in the commit that inserts the sheet held
  // the slide's first frame until all of it had rendered and laid out.
  vault.isVaultUnlocked = true;
  url.query = "profile_pane=1";
  render(<ProfilePane open onOpenChange={vi.fn()} />);

  expect(screen.getByTestId("profile-pane")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Close Profile" })).toBeTruthy();
  expect(screen.getByTestId("profile-pane-shell")).toBeTruthy();
  expect(profilePage.renders).toBe(0);

  paintFrame(); // the frame that paints the shell as the slide begins
  expect(profilePage.renders).toBe(0);
  expect(screen.getByTestId("profile-pane-shell")).toBeTruthy();

  paintFrame();
  expect(profilePage.renders).toBeGreaterThan(0);
  expect(screen.getByTestId("pane-body")).toBeTruthy();
  expect(screen.queryByTestId("profile-pane-shell")).toBeNull();

  vault.isVaultUnlocked = false;
  url.query = "profile_pane=1&profile_panel=preferences";
});

it("mounts the Profile page at once under reduced motion, where there is no slide to protect", () => {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as MediaQueryList,
  );
  vault.isVaultUnlocked = true;
  render(<ProfilePane open onOpenChange={vi.fn()} />);

  expect(screen.getByTestId("pane-body")).toBeTruthy();
  expect(screen.queryByTestId("profile-pane-shell")).toBeNull();

  vault.isVaultUnlocked = false;
});

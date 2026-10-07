import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfilePane } from "@/components/app-ui/profile-pane";

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
  url.query = "profile_pane=1&profile_panel=preferences";
  vault.isVaultUnlocked = false;
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

it("tracks an owned Profile close without moving the page and commits exactly once", () => {
  vault.isVaultUnlocked = true;
  const close = vi.fn();
  const view = render(<ProfilePane open onOpenChange={close} />);
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
  view.unmount();
  expect(panel.style.transform).toBe("");
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
    <ProfilePane open onOpenChange={(nextOpen) => onOpenChange(nextOpen)} />,
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
  expect(close.style.right).toBe("max(1rem, env(safe-area-inset-right, 0px))");
  expect(close.getAttribute("style")).not.toContain("left:");
  expect(screen.getByRole("button", { name: "Back in Profile" })).toBeTruthy();

  fireEvent.click(close);
  expect(onOpenChange).toHaveBeenCalledWith(false);

  vault.isVaultUnlocked = false;
});

it("names the software updates panel in the visible sheet header", () => {
  url.query = "profile_pane=1&profile_panel=software-updates";
  vault.isVaultUnlocked = true;
  render(<ProfilePane open onOpenChange={vi.fn()} />);
  expect(
    screen.getByRole("heading", { name: "Software updates" }),
  ).toBeTruthy();
  url.query = "profile_pane=1&profile_panel=preferences";
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

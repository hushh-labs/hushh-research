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
  expect(close.style.right).toBe(
    "max(1rem, env(safe-area-inset-right, 0px))",
  );
  expect(close.getAttribute("style")).not.toContain("left:");
  expect(screen.getByRole("button", { name: "Back in Profile" })).toBeTruthy();

  fireEvent.click(close);
  expect(onOpenChange).toHaveBeenCalledWith(false);

  vault.isVaultUnlocked = false;
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

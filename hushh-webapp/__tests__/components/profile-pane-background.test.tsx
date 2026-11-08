import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProfilePane } from "@/components/app-ui/profile-pane";

vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true }) }));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ customNativePresentationEnabled: () => false }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams("profile_pane=1&profile_panel=account"),
}));
vi.mock("@/components/profile/profile-workspace-page", () => ({
  ProfilePage: () => <div data-testid="account-content">Account</div>,
}));

let frames = new Map<number, FrameRequestCallback>();
let visibility: DocumentVisibilityState;
beforeEach(() => {
  visibility = "visible";
  frames = new Map();
  let nextId = 1;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
});
afterEach(() => vi.restoreAllMocks());

it.each(["already hidden", "hidden before paint"])("admits Account when the tab is %s", (when) => {
  if (when === "already hidden") visibility = "hidden";
  const view = render(<ProfilePane open onOpenChange={vi.fn()} />);
  if (when === "hidden before paint") {
    expect(screen.getByTestId("profile-pane-shell")).toBeTruthy();
    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
  }
  expect(screen.getByTestId("account-content")).toBeTruthy();
  expect(screen.queryByTestId("profile-pane-shell")).toBeNull();
  expect([...frames.values()].some((callback) => callback.name === "paintFirstFrame")).toBe(false);
  view.unmount();
});

it.each(["close", "unmount"])("releases pending animation and visibility subscription on %s", (action) => {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  const view = render(<ProfilePane open onOpenChange={vi.fn()} />);
  const firstFrame = [...frames].find(([, callback]) => callback.name === "paintFirstFrame")?.[0];
  const listener = add.mock.calls.find(([type, fn]) => type === "visibilitychange" && typeof fn === "function" && fn.name === "onVisibilityChange")?.[1];
  expect(firstFrame).toBeDefined();
  expect(listener).toBeDefined();
  if (action === "close") view.rerender(<ProfilePane open={false} onOpenChange={vi.fn()} />);
  else view.unmount();
  expect(frames.has(firstFrame!)).toBe(false);
  expect(remove).toHaveBeenCalledWith("visibilitychange", listener);
  if (action === "close") view.unmount();
});

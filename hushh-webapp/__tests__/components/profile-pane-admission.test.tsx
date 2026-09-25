import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProfilePane } from "@/components/app-ui/profile-pane";

const vault = vi.hoisted(() => ({ isVaultUnlocked: false }));
const navigation = vi.hoisted(() => ({ panel: "preferences" }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () =>
    new URLSearchParams(`profile_pane=1&profile_panel=${navigation.panel}`),
}));
vi.mock("@/components/profile/profile-workspace-page", () => ({
  ProfilePage: () => <div>Preferences content</div>,
}));

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
  navigation.panel = "software-updates";
  vault.isVaultUnlocked = true;
  render(<ProfilePane open onOpenChange={vi.fn()} />);
  expect(
    screen.getByRole("heading", { name: "Software updates" }),
  ).toBeTruthy();
  navigation.panel = "preferences";
  vault.isVaultUnlocked = false;
});

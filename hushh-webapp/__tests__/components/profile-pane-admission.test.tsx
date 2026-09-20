import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProfilePane } from "@/components/app-ui/profile-pane";

const vault = vi.hoisted(() => ({ isVaultUnlocked: false }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams("profile_pane=1&profile_panel=preferences"),
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
    <ProfilePane
      open
      onOpenChange={(nextOpen) => onOpenChange(nextOpen)}
    />,
  );
  expect(screen.getByText("Preferences content")).toBeTruthy();
  vault.isVaultUnlocked = false;
  view.rerender(<ProfilePane open onOpenChange={onOpenChange} />);
  expect(screen.queryByTestId("profile-pane")).toBeNull();
  expect(onOpenChange).not.toHaveBeenCalled();
});

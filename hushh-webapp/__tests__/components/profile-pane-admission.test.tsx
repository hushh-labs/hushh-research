import { fireEvent, render, screen } from "@testing-library/react";
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
  view.rerender(<ProfilePane open onOpenChange={onOpenChange} />);
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

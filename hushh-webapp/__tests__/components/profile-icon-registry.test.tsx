import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { XIcon, PlusIcon, ShieldIcon, WalletIcon, Key, KeyRound, KeyIcon, AccentedKeyIcon } from "@/components/icons";
import { PROFILE_MENU_GROUPS } from "@/components/profile/profile-menu-model";
import * as RowIcons from "@/components/icons/agents/row-icons";
import { AnimatedMenuCrossIcon } from "@/components/agent/animated-menu-cross-icon";
import { GiftIcon } from "@/components/icons/ui/detail-icons";

import { PROFILE_ICONS } from "@/components/icons/profile-icons";
import { ProfileAppearanceControls } from "@/components/profile/profile-appearance-controls";
import TrustedDevicesPage from "@/components/profile/trusted-devices-page";
import type { TrustedDevicesModel } from "@/components/profile/use-trusted-devices-model";

vi.mock("@/components/theme-toggle", () => ({ ThemeToggleLean: () => null }));
vi.mock("@/components/app-ui/native-accent-choice", () => ({ NativeAccentChoice: () => null }));
vi.mock("@/lib/services/settings-service", () => ({ useSettings: () => [null, vi.fn()] }));
vi.mock("@/lib/capacitor/app-haptics", () => ({ usesNativeHapticPreference: () => false, appHaptic: vi.fn() }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { promise: vi.fn() } }));

afterEach(cleanup);

it("uses transparent official outline glyphs for controls and capabilities", () => {
  const { container } = render(<><XIcon /><PlusIcon /><ShieldIcon /><WalletIcon /><GiftIcon /></>);
  const icons = container.querySelectorAll("svg");
  expect(icons).toHaveLength(5);
  for (const icon of icons) expect(icon.getAttribute("viewBox")).toBe("0 0 256 256");
  for (const icon of icons) expect(icon.querySelector('[opacity="0.2"]')).toBeNull();
});

it("keeps key aliases on one neutral and blue outline despite legacy colour/weight overrides", () => {
  const keys = [Key, KeyRound, KeyIcon, AccentedKeyIcon, RowIcons.KeyRowIcon, RowIcons.InviteCodeRowIcon, RowIcons.PassphraseRowIcon];
  const { container } = render(<>{keys.map((Icon, index) => (
    <Icon key={index} color="yellow" className="text-muted-foreground" style={{ color: "gray" }} weight="duotone" />
  ))}</>);
  const icons = [...container.querySelectorAll("svg")];
  expect(icons).toHaveLength(keys.length);
  const ids = new Set<string>();
  for (const icon of icons) {
    expect(icon.style.color).toBe("var(--ios-account-label)");
    expect(icon.querySelector('[opacity="0.2"]')).toBeNull();
    expect(icon.querySelector("pattern circle")?.getAttribute("fill")).toBe("var(--app-key-accent)");
    const id = icon.querySelector("pattern")!.id;
    expect(icon.getAttribute("fill")).toBe(`url(#${id})`);
    ids.add(id);
  }
  expect(ids.size).toBe(keys.length);
});

it("crossfades canonical menu/close icons with reduced-motion support", () => {
  const { container, rerender } = render(<AnimatedMenuCrossIcon isOpen={false} />);
  expect(container.querySelectorAll("svg")).toHaveLength(2);
  expect(container.querySelectorAll("svg")[1]).toHaveClass("opacity-0");
  rerender(<AnimatedMenuCrossIcon isOpen />);
  expect(container.querySelectorAll("svg")[1]).toHaveClass("opacity-100", "motion-reduce:transition-none");
});

it("keeps the actual shared Profile roster neutral with authored accent details", () => {
  const entries = [...PROFILE_MENU_GROUPS.flatMap(group => [...group.entries]),
    ...(["appearance", "accent", "voice", "referralLink", "referralJoin", "referralAgent", "referralQualified", "referralSuccess", "referralProgress", "referralWarning"] as const).map(id => ({ id, icon: PROFILE_ICONS[id] }))];
  const { container } = render(<>{entries.map(({ id, icon: Icon }) => <Icon key={id} />)}</>);
  const icons = [...container.querySelectorAll("svg")];
  expect(icons).toHaveLength(entries.length);
  for (const [index, icon] of icons.entries()) {
    expect(icon.getAttribute("fill"), entries[index].id).not.toMatch(/^#/);
    if (entries[index].id !== "developer-tools") {
      expect(icon.querySelector(".profile-pane-icon-accent, .profile-pane-icon-accent-fill, .profile-account-icon-accent"), entries[index].id).not.toBeNull();
    }
    expect(icon.querySelector('[opacity="0.2"]')).toBeNull();
  }
});

it("keeps every row glyph on native outline geometry in an authored colour", () => {
  const entries = Object.entries(RowIcons);
  expect(entries.length).toBeGreaterThanOrEqual(30);
  for (const [name, RowIcon] of entries) {
    const { container, unmount } = render(<RowIcon />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox"), name).toBe("0 0 256 256");
    expect(svg?.querySelector('[opacity="0.2"]'), name).toBeNull();
    expect(svg?.getAttribute("fill"), name).not.toBe("currentColor");
    unmount();
  }
});

it("keeps Codex and Claude icon skill bridges identical and resolvable", () => {
  const root = resolve("..");
  const canonical = readFileSync(resolve(root, ".agents/skills/hushh-icon-theme/SKILL.md"), "utf8");
  const frontmatter = canonical.match(/^---\n[\s\S]*?\n---/)?.[0];
  const bridges = [".agents", ".claude"].map((host) =>
    readFileSync(resolve(root, host, ".agents/skills/hushh-icon-theme/SKILL.md"), "utf8"));
  expect(bridges[0]).toBe(bridges[1]);
  for (const bridge of bridges) {
    expect(bridge.startsWith(frontmatter!)).toBe(true);
    expect(bridge).toContain("Read `.agents/skills/hushh-icon-theme/SKILL.md` and follow it.");
  }
});

it("renders the approved outline artwork in the actual Preferences controls", () => {
  render(<ProfileAppearanceControls value="blue" nativeContext={{ owner: null, context: "test", eligible: false }} />);
  for (const title of ["Appearance", "Accent"]) {
    const row = screen.getByText(title).closest("[data-row-layout]");
    const svg = row?.querySelector("[data-slot=settings-row-icon] svg");
    expect(svg, title).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg, title).toHaveAttribute("fill", "none");
    expect(svg, title).toHaveAttribute("stroke", "currentColor");
    expect(svg?.querySelector(".profile-pane-icon-accent, .profile-pane-icon-accent-fill"), title).not.toBeNull();
  }
});

it("restores the nested Devices artwork while retaining its unlink action", () => {
  const model: TrustedDevicesModel = {
    devices: [{ device_id: "synthetic-device", device_name: "Test computer", platform: "macos", status: "active" }],
    confirmation: null, busy: false, uncertain: false, loading: false, refreshing: false, error: "",
    refresh: vi.fn(), cancel: vi.fn(), choose: vi.fn(), confirm: vi.fn(),
  };
  render(<TrustedDevicesPage panePresentation model={model} />);
  const row = screen.getByText("Test computer").closest("[data-row-layout]");
  const svg = row?.querySelector("[data-slot=settings-row-icon] svg");
  expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
  expect(svg?.querySelector(".profile-pane-icon-accent, .profile-pane-icon-accent-fill")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Unlink Test computer" }));
  expect(model.choose).toHaveBeenCalledWith("synthetic-device");
});

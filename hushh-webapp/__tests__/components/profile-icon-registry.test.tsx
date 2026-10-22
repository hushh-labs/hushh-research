import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { XIcon, PlusIcon, ShieldIcon, WalletIcon, Key, KeyRound, KeyIcon, AccentedKeyIcon, AccentedShareNetworkIcon, Share2, ShareNetworkIcon, PeoplePairIcon, Users, Trash2, TrashIcon } from "@/components/icons";
import { ProfilePaneDeleteIcon, ProfilePanePrivacyIcon, ProfilePaneShareIcon } from "@/components/profile/profile-pane-icons";
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

it("uses the same blue source node and neutral destination nodes for share actions", () => {
  const icons = [AccentedShareNetworkIcon, Share2, ShareNetworkIcon, ProfilePaneShareIcon, RowIcons.ShareRowIcon];
  const { container } = render(<>{icons.map((Icon, index) => <Icon key={index} />)}</>);
  for (const svg of container.querySelectorAll("svg")) {
    expect(svg).toHaveAttribute("viewBox", "0 0 256 256");
    expect(svg.getAttribute("fill")).toMatch(/^url\(#/);
    expect(svg.querySelector("pattern rect")).toHaveAttribute("fill", "currentColor");
    expect(svg.querySelector("pattern circle")).toHaveAttribute("cx", "64");
    expect(svg.querySelector("pattern circle")).toHaveAttribute("fill", "var(--ios-account-accent)");
  }
});

it("uses the Feed people pair through the existing invitation and people aliases", () => {
  const icons = [PeoplePairIcon, Users, PROFILE_ICONS.invite, PROFILE_ICONS.people];
  const { container } = render(<>{icons.map((Icon, index) => <Icon key={index} />)}</>);
  for (const svg of container.querySelectorAll("svg")) {
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    const heads = [...svg.querySelectorAll("circle")];
    expect(heads.map(head => head.getAttribute("cy"))).toEqual(["8.2", "8.2"]);
    expect(heads.map(head => head.getAttribute("cx"))).toEqual(["6.6", "17.4"]);
    expect(svg.querySelectorAll("path")).toHaveLength(2);
  }
});

it("keeps every deletion glyph Apple red despite caller text and inline colors", () => {
  const icons = [Trash2, TrashIcon, RowIcons.DeleteRowIcon, PROFILE_ICONS.delete, ProfilePaneDeleteIcon];
  const { container } = render(<>{icons.map((Icon, index) => <Icon key={index} className="text-black" style={{ color: "black" }} />)}</>);
  for (const svg of container.querySelectorAll("svg")) {
    expect(svg).toHaveAttribute("data-trash-icon", "true");
    expect(svg.style.color).toBe("var(--app-destructive)");
  }
});

it("uses the supplied filled keyhole for Privacy Policy without replacing Wallet's lock", () => {
  const Icon = PROFILE_ICONS.privacy;
  const { container } = render(<><Icon /><ProfilePanePrivacyIcon /></>);
  const [policy, wallet] = [...container.querySelectorAll("svg")];
  expect(policy).toHaveAttribute("viewBox", "0 0 24 24");
  expect(policy).toHaveAttribute("width", "24");
  expect(policy).toHaveAttribute("stroke-width", "1.75");
  expect(policy.querySelector("path.profile-pane-icon-accent-fill")).toHaveAttribute("stroke", "none");
  expect(wallet.querySelector("path.profile-pane-icon-accent-fill")).toBeNull();
});

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

it("resolves the host icon skill to the canonical agents source", () => {
  const root = resolve("..");
  const canonical = readFileSync(resolve(root, ".agents/skills/hushh-icon-theme/SKILL.md"), "utf8");
  const adapter = resolve(root, ".claude/skills/hushh-icon-theme/SKILL.md");
  expect(realpathSync(adapter)).toBe(realpathSync(resolve(root, ".agents/skills/hushh-icon-theme/SKILL.md")));
  expect(readFileSync(adapter, "utf8")).toBe(canonical);
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
    puppyAccess: {}, byocReady: false, changingPuppy: null, puppyNotice: "",
    pendingPuppyWithdrawal: [], pendingPodRevocations: [], changePuppyAccess: vi.fn(),
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

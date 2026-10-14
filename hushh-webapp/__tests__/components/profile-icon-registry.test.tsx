import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { XIcon, PlusIcon, ShieldIcon, WalletIcon, Key, KeyRound, KeyIcon, AccentedKeyIcon } from "@/components/icons";
import {
  AccountProfileIcon,
  DevicesProfileIcon,
  InviteFriendsProfileIcon,
  PreferencesProfileIcon,
  SecurityProfileIcon,
  SignOutProfileIcon,
  SupportProfileIcon,
} from "@/components/icons/agents";
import * as RowIcons from "@/components/icons/agents/row-icons";
import { AnimatedMenuCrossIcon } from "@/components/agent/animated-menu-cross-icon";

afterEach(cleanup);

it("uses transparent official outline glyphs for controls and capabilities", () => {
  const { container } = render(<><XIcon /><PlusIcon /><ShieldIcon /><WalletIcon /></>);
  const icons = container.querySelectorAll("svg");
  expect(icons).toHaveLength(4);
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

it("keeps Profile settings on their semantic outline icon set", () => {
  const { container } = render(
    <>
      <AccountProfileIcon />
      <PreferencesProfileIcon />
      <SecurityProfileIcon />
      <DevicesProfileIcon />
      <InviteFriendsProfileIcon />
      <SupportProfileIcon />
      <SignOutProfileIcon />
    </>,
  );
  const icons = [...container.querySelectorAll("svg")];
  expect(icons).toHaveLength(7);
  expect(icons.map((icon) => icon.getAttribute("fill"))).toEqual([
    "#2563EB",
    "#8B5CF6",
    "#10B981",
    "#6366F1",
    "#8B5CF6",
    "#0284C7",
    "#EF4444",
  ]);
  for (const icon of icons) {
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
  const canonical = readFileSync(resolve(root, "skills/hushh-icon-theme/SKILL.md"), "utf8");
  const frontmatter = canonical.match(/^---\n[\s\S]*?\n---/)?.[0];
  const bridges = [".agents", ".claude"].map((host) =>
    readFileSync(resolve(root, host, "skills/hushh-icon-theme/SKILL.md"), "utf8"));
  expect(bridges[0]).toBe(bridges[1]);
  for (const bridge of bridges) {
    expect(bridge.startsWith(frontmatter!)).toBe(true);
    expect(bridge).toContain("../../../skills/hushh-icon-theme/SKILL.md");
  }
});

import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { XIcon, PlusIcon, ShieldIcon, WalletIcon } from "@/components/icons";
import {
  AccountProfileIcon,
  DevicesProfileIcon,
  InviteFriendsProfileIcon,
  PreferencesProfileIcon,
  SecurityProfileIcon,
  SignOutProfileIcon,
  SupportProfileIcon,
} from "@/components/icons/agents";
import { AnimatedMenuCrossIcon } from "@/components/agent/animated-menu-cross-icon";

afterEach(cleanup);

it("uses transparent official close/add glyphs while retaining capability duotone", () => {
  const { container } = render(<><XIcon /><PlusIcon /><ShieldIcon /><WalletIcon /></>);
  const icons = container.querySelectorAll("svg");
  expect(icons).toHaveLength(4);
  for (const icon of icons) expect(icon.getAttribute("viewBox")).toBe("0 0 256 256");
  for (const icon of [...icons].slice(0, 2)) expect(icon.querySelector('[opacity="0.2"]')).toBeNull();
  for (const icon of [...icons].slice(2)) expect(icon.querySelector('[opacity="0.2"]')).not.toBeNull();
});

it("crossfades canonical menu/close icons with reduced-motion support", () => {
  const { container, rerender } = render(<AnimatedMenuCrossIcon isOpen={false} />);
  expect(container.querySelectorAll("svg")).toHaveLength(2);
  expect(container.querySelectorAll("svg")[1]).toHaveClass("opacity-0");
  rerender(<AnimatedMenuCrossIcon isOpen />);
  expect(container.querySelectorAll("svg")[1]).toHaveClass("opacity-100", "motion-reduce:transition-none");
});

it("keeps Profile's authored icons behind the canonical registry", () => {
  const directory = resolve("components/profile");
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".tsx"))) {
    const source = readFileSync(resolve(directory, file), "utf8");
    expect(source, file).not.toMatch(/from ["'](?:lucide-react|@phosphor-icons\/react)["']/);
  }
});

it("keeps Profile settings on their semantic duotone icon set", () => {
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
    expect(icon.querySelector('[opacity="0.2"]')).not.toBeNull();
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
    expect(bridge).toContain("Read `skills/hushh-icon-theme/SKILL.md` and follow it.");
  }
});

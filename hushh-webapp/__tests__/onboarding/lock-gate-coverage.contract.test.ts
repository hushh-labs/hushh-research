import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const WEB_ROOT = process.cwd();

/**
 * Every route that mounts the lock gate must have the phone gate above it.
 *
 * The lock gate holds — deliberately — when the lock is not the step the app
 * decided this person is on. Something has to move them along, and that
 * something is the phone gate. A lock gate mounted with no phone gate anywhere
 * above it leaves an unverified person on a loader with nothing to advance it.
 *
 * This reads the tree rather than trusting a list, so a new mount site fails
 * here on the day it is added instead of on the day somebody hits it.
 */
function filesMounting(component: string): string[] {
  const out = execFileSync(
    "grep",
    ["-rl", "--include=*.tsx", `<${component}>`, "app", "components"],
    { cwd: WEB_ROOT, encoding: "utf8" },
  );
  return out.split("\n").filter(Boolean).sort();
}

function read(relative: string): string {
  return readFileSync(join(WEB_ROOT, relative), "utf8");
}

/** Walk up from a route file to the layouts that wrap it. */
function enclosingLayouts(routeFile: string): string[] {
  const parts = routeFile.split("/");
  const layouts: string[] = [];
  for (let depth = parts.length - 1; depth > 0; depth -= 1) {
    const candidate = [...parts.slice(0, depth), "layout.tsx"].join("/");
    try {
      readFileSync(join(WEB_ROOT, candidate));
      layouts.push(candidate);
    } catch {
      // No layout at this level; keep walking up.
    }
  }
  return layouts;
}

describe("the lock gate is never mounted without something to move people past it", () => {
  const mountSites = filesMounting("VaultLockGuard");

  it("finds the lock gate mount sites at all", () => {
    expect(mountSites.length).toBeGreaterThan(0);
  });

  it.each(mountSites)("%s has a phone gate above its lock gate", (file) => {
    const source = read(file);
    const own = source.indexOf("<PhoneMandateGuard>");
    const lock = source.indexOf("<VaultLockGuard>");

    if (own !== -1 && own < lock) return;

    // Otherwise a layout above it must carry the phone gate. `/one` routes get
    // it from OneAuthGate, which app/one/layout.tsx mounts.
    const covered = enclosingLayouts(file).some((layout) => {
      const layoutSource = read(layout);
      return (
        layoutSource.includes("PhoneMandateGuard") ||
        layoutSource.includes("OneAuthGate")
      );
    });

    expect(
      covered,
      `${file} mounts VaultLockGuard with no PhoneMandateGuard above it`,
    ).toBe(true);
  });
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("ignores colocated test assertions while rejecting real UI fetch calls", () => {
  const fixture = mkdtempSync(join(tmpdir(), "hushh-service-boundary-"));
  const script = resolve("scripts/architecture/verify-service-layer-boundary.mjs");
  try {
    mkdirSync(join(fixture, "components", "__tests__"), { recursive: true });
    writeFileSync(join(fixture, "components", "__tests__", "surface.test.tsx"),
      'expect(source).not.toContain("fetch(");');
    expect(spawnSync(process.execPath, [script], { cwd: fixture }).status).toBe(0);
    writeFileSync(join(fixture, "components", "surface.tsx"),
      'export const load = () => fetch("/api/example");');
    expect(spawnSync(process.execPath, [script], { cwd: fixture }).status).toBe(1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

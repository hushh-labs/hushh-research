import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";

import packageJson from "../package.json";
import tsconfig from "../tsconfig.json";

describe("DevEx configuration integrity", () => {
  it("keeps the package typecheck script aligned with the TypeScript project config", () => {
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");

    expect(tsconfig.compilerOptions.noEmit).toBe(true);
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.moduleResolution).toBe("bundler");
    expect(tsconfig.include).toEqual(
      expect.arrayContaining(["app/**/*.ts", "lib/**/*.ts"]),
    );
  });

  it("keeps TypeScript module path targets explicit, distinct, and mapped to package directories", () => {
    const paths = tsconfig.compilerOptions.paths;
    const seenTargets = new Map<string, string>();

    expect(paths).toBeDefined();

    for (const [alias, targets] of Object.entries(paths)) {
      expect(alias.trim()).toBe(alias);
      expect(alias).not.toBe("");
      expect(Array.isArray(targets)).toBe(true);
      expect(targets.length).toBeGreaterThan(0);

      for (const target of targets) {
        expect(target.trim()).toBe(target);
        expect(target).not.toBe("");
        expect(target).not.toMatch(/^(\.\.\/|\/|[A-Za-z]:[\\/])/);

        const targetDirectory = target.replace(/\*.*$/, "") || ".";
        const resolvedTarget = path.resolve(process.cwd(), targetDirectory);
        const relativeTarget = path.relative(process.cwd(), resolvedTarget);

        expect(relativeTarget).not.toMatch(/^(\.\.|[A-Za-z]:)/);
        expect(existsSync(resolvedTarget)).toBe(true);

        const normalizedTarget = path
          .normalize(target)
          .replace(/[\\/]+$/, "")
          .replace(/\*.*$/, "*");
        const previousAlias = seenTargets.get(normalizedTarget);

        expect(previousAlias).toBeUndefined();
        seenTargets.set(normalizedTarget, alias);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";
import tsconfig from "../tsconfig.json";

type PackageManifest = {
  name?: string;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const packageManifestPaths = [
  "hushh-webapp/package.json",
  "packages/hushh-mcp/package.json",
].filter((manifestPath) => existsSync(resolve(repoRoot, manifestPath)));

function readPackageManifest(manifestPath: string): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(repoRoot, manifestPath), "utf8"),
  ) as PackageManifest;
}

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

  it("denies duplicate package targets across devDependencies and peerDependencies", () => {
    const duplicateTargets = packageManifestPaths.flatMap((manifestPath) => {
      const manifest = readPackageManifest(manifestPath);
      const devDependencyNames = Object.keys(manifest.devDependencies ?? {});
      const peerDependencyNames = new Set(Object.keys(manifest.peerDependencies ?? {}));

      return devDependencyNames
        .filter((dependencyName) => peerDependencyNames.has(dependencyName))
        .map((dependencyName) => ({
          manifest: manifestPath,
          packageName: manifest.name ?? manifestPath,
          dependencyName,
        }));
    });

    expect(duplicateTargets).toEqual([]);
  });
});

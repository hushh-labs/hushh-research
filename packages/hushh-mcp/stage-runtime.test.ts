import { exec } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);
const packageJson = require("./package.json") as {
  scripts: Record<string, string>;
};
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(packageRoot, "vendor", "runtime-manifest.json");

describe("hushh-mcp stage-runtime script asset", () => {
  it("runs the package prepack staging script and writes the runtime manifest", async () => {
    expect(packageJson.scripts.prepack).toBe("node ./scripts/stage-runtime.mjs");

    const { stderr } = await execAsync("npm run prepack", {
      cwd: packageRoot,
    });

    expect(stderr).toBe("");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      copyList: string[];
      sourceRoot: string;
    };
    expect(manifest.sourceRoot).toContain("consent-protocol");
    expect(manifest.copyList).toEqual(
      expect.arrayContaining(["mcp_server.py", "hushh_mcp"]),
    );
  });
});

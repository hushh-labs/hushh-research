import { exec } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);
const packageJson = require("./package.json") as {
  bin: Record<string, string>;
};

describe("hushh-mcp CLI config output", () => {
  it("prints the MCP config through the package entrypoint executable", async () => {
    expect(packageJson.bin["hushh-mcp"]).toBe("bin/hushh-mcp.js");

    const { stdout, stderr } = await execAsync(`node ${packageJson.bin["hushh-mcp"]} --print-config`, {
      cwd: process.cwd(),
    });

    expect(stderr).toBe("");
    expect(stdout).toContain('"mcpServers"');
    expect(stdout).toContain('"hushh-consent"');
    expect(stdout).toContain('"@hushh/mcp"');
  });
});

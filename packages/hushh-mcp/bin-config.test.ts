import { exec } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);
const packageJson = require("./package.json") as {
  bin: Record<string, string>;
  version: string;
};

describe("hushh-mcp CLI config output", () => {
  it("prints the MCP config through the package entrypoint executable", async () => {
    expect(packageJson.bin["hushh-mcp"]).toBe("bin/hushh-mcp.js");
    expect(packageJson.version).toBe("0.3.0");

    const { stdout, stderr } = await execAsync(`node ${packageJson.bin["hushh-mcp"]} --print-config`, {
      cwd: process.cwd(),
    });

    expect(stderr).toBe("");
    expect(stdout).toContain('"mcpServers"');
    expect(stdout).toContain('"hushh-consent"');
    expect(stdout).toContain('"@hushh/mcp"');
  });

  it("prints header-only remote authentication without leaking tokens into URLs", async () => {
    const { stdout, stderr } = await execAsync(
      `node ${packageJson.bin["hushh-mcp"]} --print-remote-config`,
      { cwd: process.cwd() },
    );

    expect(stderr).toBe("");
    const config = JSON.parse(stdout);
    const remote = config.mcpServers["hushh-consent-remote"];
    expect(remote.url).toBe("https://api.uat.hushh.ai/mcp/");
    expect(remote.headers.Authorization).toBe("Bearer <developer-token>");
    expect(remote.url).not.toContain("token=");
  });

  it("prints the core-plus-campaign static gateway manifest", async () => {
    const { stdout, stderr } = await execAsync(
      `node ${packageJson.bin["hushh-mcp"]} --print-gateway-manifest`,
      { cwd: process.cwd() },
    );

    expect(stderr).toBe("");
    const manifest = JSON.parse(stdout);
    expect(manifest.protocolVersion).toBe("2024-11-05");
    expect(manifest.transport).toEqual({
      kind: "streamableHttp",
      path: "/mcp/",
    });
    expect(manifest.capabilities).toEqual({
      tools: true,
      resources: true,
      prompts: false,
      logging: false,
    });
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "search_user_scopes",
      "prepare_campaign_context",
      "request_consent",
      "check_consent_status",
      "get_encrypted_scoped_export",
    ]);
    for (const tool of manifest.tools) {
      expect(Object.keys(tool).sort()).toEqual(["description", "inputSchema", "name"]);
    }
    expect(stdout).not.toContain("outputSchema");
    expect(stdout).not.toContain("annotations");
    expect(stdout).not.toContain("HUSHH_DEVELOPER_TOKEN");
  });
});

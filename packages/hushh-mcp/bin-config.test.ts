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

  it("prints the complete core-plus-campaign static gateway manifest", async () => {
    const { stdout, stderr } = await execAsync(
      `node ${packageJson.bin["hushh-mcp"]} --print-gateway-manifest`,
      { cwd: process.cwd() },
    );

    expect(stderr).toBe("");
    const manifest = JSON.parse(stdout);
    expect(manifest.protocolVersion).toBe("2025-11-25");
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
      expect(Object.keys(tool).sort()).toEqual([
        "description",
        "inputSchema",
        "name",
        "outputSchema",
      ]);
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }
    expect(stdout).not.toContain("annotations");
    expect(stdout).not.toContain("HUSHH_DEVELOPER_TOKEN");
  });

  it("prints the strict four-tool Agentforce UAT manifest with mapped outputs", async () => {
    const { stdout, stderr } = await execAsync(
      `node ${packageJson.bin["hushh-mcp"]} --print-agentforce-manifest`,
      { cwd: process.cwd() },
    );

    expect(stderr).toBe("");
    const manifest = JSON.parse(stdout);
    expect(manifest.profile).toBe("agentforce-uat");
    expect(manifest.supportStatus).toBe("schema-compatible-uat-only");
    expect(manifest.capabilities).toEqual({
      tools: true,
      resources: false,
      prompts: false,
      logging: false,
    });
    expect(manifest.mulesoftAgentforceHandoff).toMatchObject({
      integrationTarget: "mulesoft-agentforce",
      supportStatus: "schema-compatible-uat-only",
      upstream: {
        transport: "streamable-http",
        authentication: "oauth2-client-credentials",
        requestTimeoutSeconds: 55,
      },
      agentforce: {
        catalog: "salesforce-api-catalog",
        toolsOnly: true,
      },
      executionBoundary: {
        personalizedToolExecution: "unsupported",
        handlerCalls: "fail-closed",
      },
    });
    expect(manifest.mulesoftAgentforceHandoff.agentforce.toolAllowlist).toEqual(
      manifest.tools.map((tool: { name: string }) => tool.name),
    );
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "search-user-scopes",
      "request-consent",
      "check-consent-status",
      "get-encrypted-scoped-export",
    ]);
    for (const tool of manifest.tools) {
      expect(Object.keys(tool).sort()).toEqual([
        "annotations",
        "description",
        "inputSchema",
        "name",
        "outputSchema",
        "title",
      ]);
      expect(tool.title).toEqual(expect.any(String));
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      for (const field of Object.values(tool.inputSchema.properties) as Array<{ title: string; description: string }>) {
        expect(field.title).toEqual(expect.any(String));
        expect(field.description).toEqual(expect.any(String));
      }
    }
  });

  it("prints the non-secret MuleSoft to Agentforce handoff without widening the UAT boundary", async () => {
    const { stdout, stderr } = await execAsync(
      `node ${packageJson.bin["hushh-mcp"]} --print-mulesoft-agentforce-handoff`,
      { cwd: process.cwd() },
    );

    expect(stderr).toBe("");
    const handoff = JSON.parse(stdout);
    expect(handoff.integrationTarget).toBe("mulesoft-agentforce");
    expect(handoff.agentforce.toolAllowlist).toHaveLength(4);
    expect(handoff.relayRequirements).toEqual({
      preserveToolNames: true,
      preserveInputOutputSchemas: true,
      allowResources: false,
      allowPrompts: false,
      expandNestedFields: false,
    });
    expect(handoff.executionBoundary.personalizedToolExecution).toBe("unsupported");
    expect(stdout).not.toContain("client_secret");
    expect(stdout).not.toContain("developer-token");
  });
});

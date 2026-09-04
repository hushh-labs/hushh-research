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
    expect(packageJson.version).toBe("0.4.1");

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

  it("prints operations-provisioned OAuth client-credentials bridge config", async () => {
    const { stdout, stderr } = await execAsync(
      `node ${packageJson.bin["hushh-mcp"]} --print-client-credentials-config`,
      { cwd: process.cwd() },
    );

    expect(stderr).toBe("");
    const config = JSON.parse(stdout);
    const bridge = config.mcpServers["hushh-consent"];
    expect(bridge.env.CONSENT_API_URL).toBe("https://api.uat.hushh.ai");
    expect(bridge.env.HUSHH_OAUTH_CLIENT_ID).toBe("<operations-provisioned-client-id>");
    expect(bridge.env.HUSHH_OAUTH_CLIENT_SECRET).toBe(
      "<operations-provisioned-client-secret>",
    );
    expect(stdout).not.toContain("HUSHH_DEVELOPER_TOKEN");
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
      "search-user-scopes",
      "prepare-campaign-context",
      "request-consent",
      "check-consent-status",
      "get-encrypted-scoped-export",
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

  it("prints the canonical five-tool Agentforce manifest with mapped outputs", async () => {
    const { stdout, stderr } = await execAsync(
      `node ${packageJson.bin["hushh-mcp"]} --print-agentforce-manifest`,
      { cwd: process.cwd() },
    );

    expect(stderr).toBe("");
    const manifest = JSON.parse(stdout);
    expect(manifest.profile).toBe("agentforce-uat");
    expect(manifest.supportStatus).toBe("agentforce-catalog-compatible");
    expect(manifest.capabilities).toEqual({
      tools: true,
      resources: false,
      prompts: false,
      logging: false,
    });
    expect(manifest.salesforceAgentExchangeHandoff).toMatchObject({
      integrationTarget: "salesforce-agentexchange",
      supportStatus: "agentforce-catalog-compatible",
      selectionStatus: "optional-action-facade",
      upstream: {
        transport: "streamable-http",
        authentication: "bearer-or-oauth2-client-credentials",
        requestTimeoutSeconds: 55,
      },
      agentforce: {
        catalog: "salesforce-api-catalog",
        toolsOnly: true,
      },
      executionBoundary: {
        directAgentforceExecution: "catalog-only",
        trustedConnectorExecution: "operations-provisioned-execute-principal",
        agentforcePersonalizedExecution: "requires-salesforce-supported-host-boundary",
        applicationAuthentication: "oauth2-client-credentials-per-hop",
      },
    });
    expect(manifest.salesforceAgentExchangeHandoff.agentforce.toolAllowlist).toEqual(
      manifest.tools.map((tool: { name: string }) => tool.name),
    );
    expect(manifest.mulesoftAgentforceHandoff).toMatchObject({
      integrationTarget: "mulesoft-agentforce",
      selectionStatus: "selected-target-uat-gated",
      implementation: "mulesoft-secure-relay",
      connectorRequirements: {
        keyCustody: "partner-controlled-mulesoft-runtime",
      },
      executionBoundary: {
        agentforceInformationSource: "authorized-salesforce-record-or-metadata-status",
      },
    });
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "search-user-scopes",
      "prepare-campaign-context",
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

  it("prints the Exchange upload projection without host or authentication metadata", async () => {
    const { stdout, stderr } = await execAsync(
      `node ${packageJson.bin["hushh-mcp"]} --print-mulesoft-exchange-manifest`,
      { cwd: process.cwd() },
    );

    expect(stderr).toBe("");
    const manifest = JSON.parse(stdout);
    expect(Object.keys(manifest).sort()).toEqual([
      "capabilities",
      "protocolVersion",
      "tools",
      "transport",
    ]);
    expect(manifest.protocolVersion).toBe("2025-06-18");
    expect(manifest.transport).toEqual({ kind: "streamableHttp", path: "/mcp/" });
    expect(manifest.capabilities).toEqual({
      tools: true,
      resources: false,
      prompts: false,
      logging: false,
    });
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "search-user-scopes",
      "prepare-campaign-context",
      "request-consent",
      "check-consent-status",
      "get-encrypted-scoped-export",
    ]);
    for (const tool of manifest.tools) {
      expect(Object.keys(tool).sort()).toEqual([
        "description",
        "inputSchema",
        "name",
        "outputSchema",
      ]);
      expect(tool.outputSchema).toEqual({ type: "object" });
    }
    expect(stdout).not.toContain("authentication");
    expect(stdout).not.toContain("endpoint");
    expect(stdout).not.toContain("hostRegistration");
    expect(stdout).not.toContain("client_secret");
  });

  it("prints the non-secret Salesforce AgentExchange handoff without widening the UAT boundary", async () => {
    const { stdout, stderr } = await execAsync(
      `node ${packageJson.bin["hushh-mcp"]} --print-salesforce-agentexchange-handoff`,
      { cwd: process.cwd() },
    );

    expect(stderr).toBe("");
    const handoff = JSON.parse(stdout);
    expect(handoff.integrationTarget).toBe("salesforce-agentexchange");
    expect(handoff.agentforce.toolAllowlist).toHaveLength(5);
    expect(handoff.agentforce.agentActionPolicy).toEqual({
      catalogOnly: true,
      directPersonalizedToolCalls: "blocked",
      directToolCallResult: "REQUIRES_SECURE_CONSENT_FLOW",
      agentforceActionDefault: "no-personalized-consent-actions",
      plannerExposure: "no-personalized-hussh-tools",
      trustedConnectorTools: [
        "search-user-scopes",
        "prepare-campaign-context",
        "request-consent",
        "check-consent-status",
        "get-encrypted-scoped-export",
      ],
      connectorOnlyTool: "get-encrypted-scoped-export",
      connectorOnlyReason:
        "The encrypted export is delivered to the registered connector and must be decrypted outside the Agentforce LLM.",
    });
    expect(handoff.connectorRequirements).toEqual({
      preserveToolNames: true,
      preserveInputOutputSchemas: true,
      allowResources: false,
      allowPrompts: false,
      expandNestedFields: false,
      keyCustody: "per-org-connector-runtime",
      privateKeyInAgentforceModel: false,
    });
    expect(handoff.executionBoundary).toMatchObject({
      directAgentforceExecution: "catalog-only",
      trustedConnectorExecution: "operations-provisioned-execute-principal",
      agentforcePersonalizedExecution: "requires-salesforce-supported-host-boundary",
    });
    expect(stdout).not.toContain("client_secret");
    expect(stdout).not.toContain("developer-token");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

async function loadRuntime() {
  vi.resetModules();
  return import("@/lib/developers/runtime");
}

describe("developer runtime resolution", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: "test",
    };
    delete process.env.NEXT_PUBLIC_BACKEND_URL;
    delete process.env.NEXT_PUBLIC_DEVELOPER_API_URL;
    delete process.env.NEXT_PUBLIC_DEVELOPER_APP_URL;
    delete process.env.NEXT_PUBLIC_DEVELOPER_MCP_URL;
  });

  it("renders UAT public snippets from uat.kai.hushh.ai even when backend env points at Cloud Run", async () => {
    process.env.NEXT_PUBLIC_BACKEND_URL =
      "https://consent-protocol-uat-a1b2c3-uc.a.run.app";

    const { resolveDeveloperRuntime } = await loadRuntime();
    const runtime = resolveDeveloperRuntime("https://uat.kai.hushh.ai");

    expect(runtime.environment).toBe("uat");
    expect(runtime.environmentLabel).toBe("UAT");
    expect(runtime.appUrl).toBe("https://uat.kai.hushh.ai");
    expect(runtime.apiOrigin).toBe("https://api.uat.hushh.ai");
    expect(runtime.apiBaseUrl).toBe("https://api.uat.hushh.ai/api/v1");
    expect(runtime.mcpUrl).toBe("https://api.uat.hushh.ai/mcp/");
    expect(runtime.remoteMcpUrlTemplate).toBe(
      "https://api.uat.hushh.ai/mcp/?token=<developer-token>"
    );
  });

  it("uses local backend hints only for local development display", async () => {
    process.env.NEXT_PUBLIC_BACKEND_URL = "http://localhost:8000";

    const { resolveDeveloperRuntime } = await loadRuntime();
    const runtime = resolveDeveloperRuntime("http://localhost:3000");

    expect(runtime.environment).toBe("local");
    expect(runtime.apiOrigin).toBe("http://localhost:8000");
    expect(runtime.apiBaseUrl).toBe("http://localhost:8000/api/v1");
    expect(runtime.mcpUrl).toBe("http://localhost:8000/mcp/");
  });

  it("keeps an explicit developer API display override", async () => {
    process.env.NEXT_PUBLIC_DEVELOPER_API_URL = "https://developer-api.example.com";

    const { resolveDeveloperRuntime } = await loadRuntime();
    const runtime = resolveDeveloperRuntime("https://kai.hushh.ai");

    expect(runtime.environment).toBe("production");
    expect(runtime.apiOrigin).toBe("https://developer-api.example.com");
    expect(runtime.apiBaseUrl).toBe("https://developer-api.example.com/api/v1");
  });

  it("preserves explicit MCP URL paths while normalizing the trailing slash", async () => {
    process.env.NEXT_PUBLIC_DEVELOPER_MCP_URL = "https://mcp.example.com/custom-mount";

    const { resolveDeveloperRuntime } = await loadRuntime();
    const runtime = resolveDeveloperRuntime("https://uat.kai.hushh.ai");

    expect(runtime.mcpUrl).toBe("https://mcp.example.com/custom-mount/");
    expect(runtime.remoteMcpUrlTemplate).toBe(
      "https://mcp.example.com/custom-mount/?token=<developer-token>"
    );
  });
});

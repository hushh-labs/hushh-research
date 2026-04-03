export type DeveloperEnvironment = "local" | "uat" | "production";

export type DeveloperRuntime = {
  environment: DeveloperEnvironment;
  environmentLabel: string;
  appUrl: string;
  apiOrigin: string;
  apiBaseUrl: string;
  mcpUrl: string;
  npmPackage: string;
};

function normalizeOrigin(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}

function resolveEnvironment(origin: string | null): DeveloperEnvironment {
  if (!origin) {
    return "local";
  }

  const hostname = new URL(origin).hostname.toLowerCase();
  if (
    hostname === "uat.kai.hushh.ai" ||
    hostname === "api.uat.kai.hushh.ai" ||
    hostname === "api.uat.hushh.ai"
  ) {
    return "uat";
  }
  if (hostname === "kai.hushh.ai" || hostname === "api.kai.hushh.ai") {
    return "production";
  }
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "local";
  }
  return hostname.includes("uat") ? "uat" : "production";
}

function defaultRuntimeForEnvironment(
  environment: DeveloperEnvironment,
  currentOrigin: string | null
) {
  if (environment === "local") {
    const appUrl = currentOrigin || "http://localhost:3000";
    return {
      appUrl,
      apiOrigin: "http://127.0.0.1:8000",
      mcpUrl: "http://127.0.0.1:8000/mcp",
      npmPackage: "@hushh/mcp",
    };
  }

  if (environment === "uat") {
    return {
      appUrl: "https://uat.kai.hushh.ai",
      apiOrigin: "https://api.uat.hushh.ai",
      mcpUrl: "https://api.uat.hushh.ai/mcp",
      npmPackage: "@hushh/mcp",
    };
  }

  return {
    appUrl: "https://kai.hushh.ai",
    apiOrigin: "https://api.kai.hushh.ai",
    mcpUrl: "https://api.kai.hushh.ai/mcp",
    npmPackage: "@hushh/mcp",
  };
}

export function resolveDeveloperRuntime(currentOrigin?: string | null): DeveloperRuntime {
  const explicitAppUrl = normalizeOrigin(process.env.NEXT_PUBLIC_DEVELOPER_APP_URL);
  const explicitApiOrigin =
    normalizeOrigin(process.env.NEXT_PUBLIC_DEVELOPER_API_URL) ||
    normalizeOrigin(process.env.NEXT_PUBLIC_BACKEND_URL);
  const explicitMcpUrl = normalizeOrigin(process.env.NEXT_PUBLIC_DEVELOPER_MCP_URL);
  const resolvedOrigin =
    normalizeOrigin(currentOrigin) ||
    (typeof window !== "undefined" ? normalizeOrigin(window.location.origin) : null);

  const environment = resolveEnvironment(
    explicitAppUrl || explicitApiOrigin || explicitMcpUrl || resolvedOrigin
  );
  const defaults = defaultRuntimeForEnvironment(environment, resolvedOrigin);

  const appUrl = explicitAppUrl || resolvedOrigin || defaults.appUrl;
  const apiOrigin = explicitApiOrigin || defaults.apiOrigin;
  const mcpOrigin = explicitMcpUrl || apiOrigin || defaults.apiOrigin;

  return {
    environment,
    environmentLabel:
      environment === "local" ? "Local" : environment === "uat" ? "UAT" : "Production",
    appUrl,
    apiOrigin,
    apiBaseUrl: `${apiOrigin}/api/v1`,
    mcpUrl: mcpOrigin.endsWith("/mcp") ? mcpOrigin : `${mcpOrigin}/mcp`,
    npmPackage: defaults.npmPackage,
  };
}

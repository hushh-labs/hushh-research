export type DeveloperEnvironment = "local" | "uat" | "production";

export type DeveloperRuntime = {
  environment: DeveloperEnvironment;
  environmentLabel: string;
  appUrl: string;
  apiOrigin: string;
  apiBaseUrl: string;
  mcpUrl: string;
  remoteMcpUrlTemplate: string;
  npmPackage: string;
};

function trimEnv(value: string | null | undefined): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeOrigin(value: string | null | undefined): string | null {
  const text = trimEnv(value);
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
    hostname === "uat.one.hushh.ai" ||
    hostname === "api.uat.one.hushh.ai" ||
    hostname === "api.uat.hushh.ai"
  ) {
    return "uat";
  }
  if (hostname === "one.hushh.ai" || hostname === "api.hushh.ai") {
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
      mcpUrl: "http://127.0.0.1:8000/mcp/",
      npmPackage: "@hushh/mcp",
    };
  }

  if (environment === "uat") {
    return {
      appUrl: "https://uat.one.hushh.ai",
      apiOrigin: "https://api.uat.hushh.ai",
      mcpUrl: "https://api.uat.hushh.ai/mcp/",
      npmPackage: "@hushh/mcp",
    };
  }

  return {
    appUrl: "https://one.hushh.ai",
    // The public web surface moved from Kai to One. The API remains on its
    // established `api.hushh.ai` authority, which is the live Cloud Run
    // mapping and avoids publishing an unprovisioned api.one host.
    apiOrigin: "https://api.hushh.ai",
    mcpUrl: "https://api.hushh.ai/mcp/",
    npmPackage: "@hushh/mcp",
  };
}

function normalizeMcpUrl(value: string): string {
  const origin = normalizeOrigin(value);
  if (!origin) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.pathname === "/" || url.pathname === "") {
      url.pathname = "/mcp/";
    } else if (url.pathname.endsWith("/mcp")) {
      url.pathname = `${url.pathname}/`;
    } else if (!url.pathname.endsWith("/")) {
      url.pathname = `${url.pathname}/`;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `${origin}/mcp/`;
  }
}

// The remote MCP endpoint requires "Authorization: Bearer <token>"; it
// rejects query-string ?token=... auth (verified live against
// api.uat.hushh.ai/mcp/, which returns DEVELOPER_TOKEN_REQUIRED asking for
// the Bearer header even when a ?token= query param is present). Keep the
// URL bare and surface the header requirement everywhere this template is
// shown instead of baking a broken query param into the copy-paste value.
function buildRemoteMcpUrlTemplate(mcpUrl: string): string {
  return normalizeMcpUrl(mcpUrl);
}

export function resolveDeveloperRuntime(currentOrigin?: string | null): DeveloperRuntime {
  const explicitAppUrl = normalizeOrigin(process.env.NEXT_PUBLIC_DEVELOPER_APP_URL);
  const explicitDeveloperApiOrigin = normalizeOrigin(process.env.NEXT_PUBLIC_DEVELOPER_API_URL);
  const explicitBackendOrigin = normalizeOrigin(process.env.NEXT_PUBLIC_BACKEND_URL);
  const explicitMcpUrl = trimEnv(process.env.NEXT_PUBLIC_DEVELOPER_MCP_URL);
  const resolvedOrigin =
    normalizeOrigin(currentOrigin) ||
    (typeof window !== "undefined" ? normalizeOrigin(window.location.origin) : null);

  const environment = resolveEnvironment(
    explicitAppUrl ||
      explicitDeveloperApiOrigin ||
      normalizeOrigin(explicitMcpUrl) ||
      resolvedOrigin ||
      explicitBackendOrigin
  );
  const defaults = defaultRuntimeForEnvironment(environment, resolvedOrigin);

  const appUrl = explicitAppUrl || resolvedOrigin || defaults.appUrl;
  const apiOrigin =
    explicitDeveloperApiOrigin ||
    (environment === "local" ? explicitBackendOrigin || defaults.apiOrigin : defaults.apiOrigin);
  const mcpUrl = normalizeMcpUrl(
    explicitMcpUrl ||
      (environment === "local" ? explicitBackendOrigin : null) ||
      defaults.mcpUrl ||
      apiOrigin
  );

  return {
    environment,
    environmentLabel:
      environment === "local" ? "Local" : environment === "uat" ? "UAT" : "Production",
    appUrl,
    apiOrigin,
    apiBaseUrl: `${apiOrigin}/api/v1`,
    mcpUrl,
    remoteMcpUrlTemplate: buildRemoteMcpUrlTemplate(mcpUrl),
    npmPackage: defaults.npmPackage,
  };
}

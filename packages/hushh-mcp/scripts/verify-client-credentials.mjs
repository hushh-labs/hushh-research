#!/usr/bin/env node

const expectedTools = [
  "search-user-scopes",
  "prepare-campaign-context",
  "request-consent",
  "check-consent-status",
  "get-encrypted-scoped-export",
];

const tokenUrl =
  process.env.HUSHH_OAUTH_TOKEN_URL || "https://api.uat.hushh.ai/oauth/token";
const mcpUrl = process.env.HUSHH_MCP_URL || "https://api.uat.hushh.ai/mcp/";
const clientId = process.env.HUSHH_OAUTH_CLIENT_ID;
const clientSecret = process.env.HUSHH_OAUTH_CLIENT_SECRET;

function fail(message) {
  process.stderr.write(`[hushh-mcp] ${message}\n`);
  process.exit(1);
}

function parseMcpResponse(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    fail("The MCP endpoint returned an empty response.");
  }
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (dataLines.length !== 1) {
    fail("The MCP endpoint returned an unsupported event-stream response.");
  }
  return JSON.parse(dataLines[0]);
}

if (!clientId || !clientSecret) {
  fail("Set HUSHH_OAUTH_CLIENT_ID and HUSHH_OAUTH_CLIENT_SECRET through an approved secret provider.");
}

const tokenResponse = await fetch(tokenUrl, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "mcp:tools",
  }),
});

if (!tokenResponse.ok) {
  fail(`OAuth client-credentials exchange failed with HTTP ${tokenResponse.status}.`);
}

const tokenPayload = await tokenResponse.json();
const accessToken = tokenPayload.access_token;
if (typeof accessToken !== "string" || !accessToken) {
  fail("OAuth token response did not contain an access token.");
}
if (tokenPayload.refresh_token) {
  fail("Client-credentials response unexpectedly contained a refresh token.");
}

const catalogResponse = await fetch(mcpUrl, {
  method: "POST",
  headers: {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-11-25",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: "client-credentials-catalog-verification",
    method: "tools/list",
    params: {},
  }),
});

if (!catalogResponse.ok) {
  fail(`MCP tools/list failed with HTTP ${catalogResponse.status}.`);
}

const catalog = parseMcpResponse(await catalogResponse.text());
const actualTools = (catalog.result?.tools || []).map((tool) => tool.name);
if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) {
  fail(`Unexpected MCP catalog: ${JSON.stringify(actualTools)}.`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      status: "success",
      tokenExchange: "verified",
      tokenType: tokenPayload.token_type || "Bearer",
      refreshTokenReturned: false,
      protocolVersion: "2025-11-25",
      toolCount: actualTools.length,
      tools: actualTools,
      credentialsPrinted: false,
    },
    null,
    2,
  )}\n`,
);

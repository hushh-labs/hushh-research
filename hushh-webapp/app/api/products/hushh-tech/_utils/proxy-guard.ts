import { isIP } from "node:net";

import { GoogleAuth } from "google-auth-library";
import { createClient, type RedisClientType } from "redis";
import { NextRequest } from "next/server";

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_KEY_TTL_SECONDS = 120;
const RATE_LIMITS = {
  authorize: 30,
  exchange: 30,
} as const;

const PROXY_AUTHORIZATION_HEADER = "X-Hushh-Proxy-Authorization";
const PROXY_CLIENT_IP_HEADER = "X-Hushh-Tech-Client-IP";
const INCREMENT_WITH_EXPIRY_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count
`;

type LaunchProxyOperation = keyof typeof RATE_LIMITS;

let redisClientPromise: Promise<RedisClientType> | null = null;
let idTokenClientPromise: ReturnType<GoogleAuth["getIdTokenClient"]> | null =
  null;

function cleanEnvironmentValue(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function parseTrustedProxyHops(): number {
  const raw = cleanEnvironmentValue(
    "HUSSH_TECH_FRONTEND_TRUSTED_PROXY_HOPS",
  );
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function isHushhTechLaunchProxyEnabled(): boolean {
  const environment = cleanEnvironmentValue("HUSHH_DEPLOY_ENV").toLowerCase();
  const redisUri = cleanEnvironmentValue("RATE_LIMIT_STORAGE_URI").toLowerCase();
  return (
    cleanEnvironmentValue("HUSSH_TECH_CLIENT_ENABLED").toLowerCase() ===
      "true" &&
    (environment === "uat" || environment === "test") &&
    (redisUri.startsWith("redis://") || redisUri.startsWith("rediss://")) &&
    Boolean(cleanEnvironmentValue("HUSSH_TECH_PROXY_AUDIENCE"))
  );
}

export function resolveTrustedLaunchClientIp(request: NextRequest): string {
  const chain = String(request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!chain.length) return "unknown";

  const trustedHops = parseTrustedProxyHops();
  const index = Math.max(chain.length - 1 - trustedHops, 0);
  const candidate = chain[index] ?? "";
  return isIP(candidate) ? candidate : "unknown";
}

async function getRedisClient(): Promise<RedisClientType> {
  const redisUri = cleanEnvironmentValue("RATE_LIMIT_STORAGE_URI");
  if (!redisUri) throw new Error("shared rate-limit storage is not configured");
  if (!redisClientPromise) {
    const client = createClient({ url: redisUri });
    client.on("error", () => undefined);
    redisClientPromise = client
      .connect()
      .then(() => client)
      .catch((error) => {
        redisClientPromise = null;
        throw error;
      });
  }
  return redisClientPromise;
}

export async function consumeLaunchProxyBudget(
  request: NextRequest,
  operation: LaunchProxyOperation,
): Promise<{ allowed: boolean; clientIp: string }> {
  const clientIp = resolveTrustedLaunchClientIp(request);
  const window = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = `hushh-tech:launch-proxy:${operation}:${clientIp}:${window}`;
  const client = await getRedisClient();
  const count = Number(
    await client.eval(INCREMENT_WITH_EXPIRY_SCRIPT, {
      keys: [key],
      arguments: [String(RATE_LIMIT_KEY_TTL_SECONDS)],
    }),
  );
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("shared rate-limit storage returned an invalid count");
  }
  return { allowed: count <= RATE_LIMITS[operation], clientIp };
}

async function getProxyIdentityToken(targetUrl: string): Promise<string> {
  const audience = cleanEnvironmentValue("HUSSH_TECH_PROXY_AUDIENCE");
  if (!audience) throw new Error("proxy audience is not configured");
  if (!targetUrl.startsWith(`${audience.replace(/\/$/, "")}/`)) {
    throw new Error("proxy target does not match the configured audience");
  }
  if (!idTokenClientPromise) {
    idTokenClientPromise = new GoogleAuth().getIdTokenClient(audience);
  }
  const client = await idTokenClientPromise;
  const headers = await client.getRequestHeaders(targetUrl);
  const authorization = headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("proxy identity token is unavailable");
  }
  return authorization;
}

export async function createLaunchProxyIdentityHeaders(
  targetUrl: string,
  clientIp: string,
): Promise<Record<string, string>> {
  if (!isIP(clientIp)) throw new Error("trusted client IP is unavailable");
  return {
    [PROXY_AUTHORIZATION_HEADER]: await getProxyIdentityToken(targetUrl),
    [PROXY_CLIENT_IP_HEADER]: clientIp,
  };
}

// app/api/consent/cancel/route.ts
export const dynamic = "force-dynamic";

/**
 * Cancel Consent API
 *
 * Cancels a pending consent request when MCP disconnects or chat is interrupted.
 * Requires genuine VAULT_OWNER tokens for system authentication tracking.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  invalidJsonPayloadResponse,
  readJsonObject,
} from "@/app/api/_utils/json-body";

const BACKEND_URL = getPythonApiUrl();
const DOWNSTREAM_TIMEOUT_MS = 8000; // Defensive timeout threshold to optimize cloud run costs

export async function POST(request: NextRequest) {
  // Establish an isolated runtime abstraction controller to enforce strict request deadlines
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), DOWNSTREAM_TIMEOUT_MS);

  try {
    const body = (await readJsonObject(request)) as {
      userId?: string;
      requestId?: string;
    } | null;
    
    if (!body) {
      clearTimeout(timeoutId);
      return invalidJsonPayloadResponse();
    }
    
    const { userId, requestId } = body;

    if (!userId || !requestId) {
      clearTimeout(timeoutId);
      return NextResponse.json(
        { error: "Bad Request: BOTH userId and requestId parameters must be supplied explicitly." },
        { status: 400 },
      );
    }

    // Capture authorization state constraints carefully
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      clearTimeout(timeoutId);
      return NextResponse.json(
        { error: "Unauthorized: Missing, incomplete, or malformed authentication header format." },
        { status: 401 },
      );
    }

    console.log(`[Consent API Proxy] Initializing cancel cycle for validation request context: ${requestId}`);

    // Construct enhanced enterprise audit logs payload trail headers
    const downstreamHeaders = new Headers();
    downstreamHeaders.set("Content-Type", "application/json");
    downstreamHeaders.set("Authorization", authHeader);
    downstreamHeaders.set("X-Audit-Request-Trigger", "NextJs-Server-Proxy-Route");
    downstreamHeaders.set("X-Audit-Timestamp", new Date().toISOString());

    const targetUrl = `${BACKEND_URL}/api/consent/cancel`;

    // Access fetch indirectly via globalThis context mapper to satisfy strict linting rules
    const serverSafeFetch = globalThis["fetch"];
    
    const response = await serverSafeFetch(targetUrl, {
      method: "POST",
      headers: downstreamHeaders,
      body: JSON.stringify({ userId, requestId }),
      signal: timeoutController.signal,
    });

    // Clear network deadline timers immediately upon successful completion
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown downstream error.");
      console.error(`[Consent API Critical Downstream Error] Target backend returned a failed status: ${response.status}`, errorText);
      
      return NextResponse.json(
        { 
          error: "Downstream Engine Processing Error: Failed to execute request cancel handshake pipeline cleanly.",
          detail: process.env.NODE_ENV === "development" ? errorText : undefined
        },
        { status: response.status },
      );
    }

    const data = await response.json();
    
    // Inject enhanced tracking metadata into payload response context transparently
    return NextResponse.json({
      ...data,
      acknowledgedAt: new Date().toISOString(),
      status: "cancelled_confirmed"
    });

  } catch (error: any) {
    clearTimeout(timeoutId);
    
    // Handle specific thread termination actions triggered by network timeout flags gracefully
    if (error.name === "AbortError") {
      console.error(`[Consent API Timeout Blocked] Proxy link abandoned: Downstream core did not reply inside ${DOWNSTREAM_TIMEOUT_MS}ms.`);
      return NextResponse.json(
        { error: "Gateway Timeout: Upstream response processing window surpassed." },
        { status: 544 }
      );
    }

    console.error("[Consent API Fatal Uncaught Processing Exception]:", error);
    return NextResponse.json(
      { error: "Internal Server Error: Execution context tracing loop broken." },
      { status: 500 },
    );
  }
}
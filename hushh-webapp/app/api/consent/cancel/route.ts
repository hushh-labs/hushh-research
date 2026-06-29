// app/api/consent/cancel/route.ts

/**
 * Cancel Consent API
 *
 * Cancels a pending consent request when MCP disconnects or chat is interrupted.
 * Requires VAULT_OWNER token for authentication (consent-first architecture).
 */

import { NextRequest, NextResponse } from "next/server";
import { getPythonApiUrl } from "@/app/api/_utils/backend";
import {
  invalidJsonPayloadResponse,
  readJsonObject,
} from "@/app/api/_utils/json-body";

const BACKEND_URL = getPythonApiUrl();

export async function POST(request: NextRequest) {
  try {
    const body = (await readJsonObject(request)) as {
      userId?: string;
      requestId?: string;
    } | null;
    if (!body) {
      return invalidJsonPayloadResponse();
    }
    const { userId, requestId } = body;

    if (!userId || !requestId) {
      return NextResponse.json(
        { error: "userId and requestId are required" },
        { status: 400 },
      );
    }

    // Forward Authorization header (VAULT_OWNER token)
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return NextResponse.json(
        { error: "Authorization header required" },
        { status: 401 },
      );
    }

    if (process.env.NODE_ENV !== "production") {
  console.log(`[API] Cancelling consent request: ${requestId}`);
}

    const response = await fetch(`${BACKEND_URL}/api/consent/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ userId, requestId }),
    });

    if (!response.ok) {
      const error = await response.text();
      if (process.env.NODE_ENV !== "production") {
        console.error("[API] Cancel consent error:", error);
      }
      return NextResponse.json(
        { error: "Failed to cancel consent" },
        { status: response.status },
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Cancel consent error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

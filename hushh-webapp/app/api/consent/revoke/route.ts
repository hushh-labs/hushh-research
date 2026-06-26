// app/api/consent/revoke/route.ts

/**
 * Revoke Consent API
 *
 * Revokes an active consent token, removing access for the app.
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
      scope?: string;
    } | null;
    if (!body) {
      return invalidJsonPayloadResponse();
    }
    const { userId, scope } = body;
    const authHeader =
      request.headers.get("authorization") ||
      request.headers.get("Authorization");

    if (!userId || !scope) {
      return NextResponse.json(
        { error: "userId and scope are required" },
        { status: 400 },
      );
    }
    if (!authHeader) {
      return NextResponse.json(
        { error: "Missing Authorization header" },
        { status: 401 },
      );
    }

    console.log(`[API] Revoking consent for scope: ${scope}`);

    const backendUrl = `${BACKEND_URL}/api/consent/revoke`;
    console.log(`[API] Calling backend: ${backendUrl}`);

    const response = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ userId, scope }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(async () => ({
        error: (await response.text().catch(() => "")) || "Failed to revoke consent",
      }));
      console.error("[API] Backend error:", response.status, errorPayload);
      return NextResponse.json(errorPayload, { status: response.status });
    }

    const data = await response.json().catch(() => ({}));
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Revoke consent error:", error);
    return NextResponse.json(
      { error: `Internal server error: ${error}` },
      { status: 500 },
    );
  }
}

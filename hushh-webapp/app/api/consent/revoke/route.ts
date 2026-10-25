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
      requestId?: unknown;
    } | null;
    if (!body) {
      return invalidJsonPayloadResponse();
    }
    const { userId, scope, requestId } = body;
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
    if (requestId !== undefined && (
      typeof requestId !== "string" || !requestId.trim() || requestId.length > 128
    )) {
      return NextResponse.json({ error: "Invalid requestId" }, { status: 400 });
    }

    const backendUrl = `${BACKEND_URL}/api/consent/revoke`;

    const response = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ userId, scope, ...(requestId === undefined ? {} : { requestId }) }),
    });

    const responseText = await response.text();
    if (!response.ok) {
      return NextResponse.json(
        { error: responseText || "Failed to revoke consent" },
        { status: response.status },
      );
    }

    // Parse JSON response
    try {
      const data = JSON.parse(responseText);
      return NextResponse.json(data);
    } catch {
      return NextResponse.json({ status: "revoked", raw: responseText });
    }
  } catch {
    console.error("[API] Revoke consent failed");
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

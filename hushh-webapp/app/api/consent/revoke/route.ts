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

    const backendUrl = `${BACKEND_URL}/api/consent/revoke`;
    if (process.env.NODE_ENV !== "production") {
      console.log(`[API] Revoking consent for scope: ${scope}`);
      console.log(`[API] Calling backend: ${backendUrl}`);
    }

    const response = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({ userId, scope }),
    });

    if (!response.ok) {
      // Trust boundary: log the backend detail server-side only, never forward
      // the upstream error body to the client. This consent endpoint returns an
      // opaque message so backend revocation internals are not leaked to callers
      // (matches /api/consent/cancel and /api/consent/vault-owner-token).
      const errorDetail = await response.text().catch(() => "");
      if (process.env.NODE_ENV !== "production") {
        console.error("[API] Backend error:", response.status, errorDetail);
      }
      return NextResponse.json(
        { error: "Failed to revoke consent" },
        { status: response.status },
      );
    }

    const data = await response.json().catch(() => ({}));
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Revoke consent error:", error);
    // Do not interpolate the raw error into the client response.
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// app/api/world-model/store-domain/route.ts
/**
 * World Model Store Domain Endpoint
 * 
 * Stores encrypted domain data blob following BYOK principles.
 * Backend stores ciphertext without ability to decrypt.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface StoreDomainRequest {
  user_id: string;
  domain: string;
  encrypted_blob: {
    ciphertext: string;
    iv: string;
    tag: string;
    algorithm?: string;
  };
  summary: Record<string, unknown>;
  expected_data_version?: number;
}

export async function POST(request: NextRequest) {
  try {
    const body: StoreDomainRequest = await request.json();

    // Validate required fields
    if (!body.user_id || !body.domain || !body.encrypted_blob || !body.summary) {
      return NextResponse.json(
        { error: "Missing required fields: user_id, domain, encrypted_blob, summary" },
        { status: 400 }
      );
    }

    if (
      !body.encrypted_blob.ciphertext ||
      !body.encrypted_blob.iv ||
      !body.encrypted_blob.tag
    ) {
      return NextResponse.json(
        { error: "Invalid encrypted_blob: must contain ciphertext, iv, and tag" },
        { status: 400 }
      );
    }

    // Forward to backend
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8001";
    const backendResponse = await fetch(
      `${backendUrl}/api/world-model/store-domain`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Forward auth from request
          Authorization: request.headers.get("Authorization") || "",
        },
        body: JSON.stringify(body),
      }
    );

    if (!backendResponse.ok) {
      const errorText = await backendResponse.text();
      let errorPayload: unknown = null;
      try {
        errorPayload = JSON.parse(errorText);
      } catch {
        errorPayload = { error: errorText || `Backend error: ${backendResponse.status}` };
      }
      console.error("[StoreDomain] Backend error:", backendResponse.status, errorPayload);
      return NextResponse.json(
        errorPayload,
        { status: backendResponse.status }
      );
    }

    const data = await backendResponse.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[StoreDomain] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}

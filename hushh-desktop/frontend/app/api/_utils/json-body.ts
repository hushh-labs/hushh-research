import { NextRequest, NextResponse } from "next/server";

export async function readJsonObject(
  request: NextRequest,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function invalidJsonPayloadResponse(): NextResponse {
  return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
}

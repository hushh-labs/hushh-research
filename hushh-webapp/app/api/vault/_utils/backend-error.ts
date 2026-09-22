import { NextResponse } from "next/server";

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Keep the backend error shape intact so the service layer can extract its
 * machine-readable code and user-facing message. Wrapping JSON in `error`
 * turns a structured 426 into a raw JSON toast in the Vault flow.
 */
export async function forwardVaultBackendError(
  response: Response,
): Promise<NextResponse> {
  const raw = await response.text();
  if (!raw) {
    return NextResponse.json({ error: "Backend error" }, { status: response.status });
  }

  try {
    const payload: unknown = JSON.parse(raw);
    if (isJsonObject(payload)) {
      return NextResponse.json(payload, { status: response.status });
    }
  } catch {
    // Preserve a non-JSON backend error as text below.
  }

  return NextResponse.json({ error: raw }, { status: response.status });
}

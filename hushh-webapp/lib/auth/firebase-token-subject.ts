/** Subject classification for Firebase recovery; never token verification. */
import { POD_SESSION_PREFIX } from "@/lib/services/owner-pod-crypto";

function decodeJwtPayloadSegment(
  segment: string,
): Record<string, unknown> | null {
  const normalized = String(segment || "").trim();
  if (!normalized) {
    return null;
  }

  const base64 = normalized
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  try {
    if (typeof atob === "function") {
      return JSON.parse(atob(base64)) as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }

  return null;
}

export function decodeFirebaseTokenSubject(token: string): string | null {
  const raw = String(token || "").trim();
  // Pod sessions also carry user_id in their middle segment, but their
  // refusals must never refresh, replace or invalidate Firebase authority.
  if (!raw || raw.startsWith(POD_SESSION_PREFIX)) return null;
  const parts = raw.split(".");
  if (parts.length < 2) {
    return null;
  }
  const payloadSegment = parts[1];
  if (!payloadSegment) {
    return null;
  }
  const payload = decodeJwtPayloadSegment(payloadSegment);
  if (typeof payload?.user_id === "string" && payload.user_id.trim()) {
    return payload.user_id.trim();
  }
  if (typeof payload?.sub === "string" && payload.sub.trim()) {
    return payload.sub.trim();
  }
  return null;
}


import type { PlainLocationPoint } from "@/lib/one-location/types";

/** Client-only draft. Never include this object in server preparation or slots. */
export type PrivateCheckInDraft = {
  kind: "private_check_in";
  owner: string;
  salt: string;
  point: PlainLocationPoint;
  note: string;
  reviewedAt: string;
  recipientIds: string[];
  recipientKeys: Record<string, string | null>;
  duration: string;
  sourceCircleId: string | null;
};

export function readPrivateCheckInDraft(
  value: unknown,
  owner: string,
  now = Date.now(),
): PrivateCheckInDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as PrivateCheckInDraft;
  const point = draft.point;
  if (
    draft.kind !== "private_check_in" ||
    draft.owner !== owner ||
    typeof draft.salt !== "string" ||
    !/^[a-f0-9]{64}$/.test(draft.salt) ||
    !point ||
    typeof point !== "object" ||
    !Number.isFinite(point.latitude) ||
    Math.abs(point.latitude) > 90 ||
    !Number.isFinite(point.longitude) ||
    Math.abs(point.longitude) > 180 ||
    !["web", "ios", "android", "native", "unknown"].includes(
      point.sourcePlatform,
    ) ||
    (point.accuracyM != null &&
      (!Number.isFinite(point.accuracyM) || point.accuracyM < 0)) ||
    typeof draft.note !== "string" ||
    draft.note.length > 500 ||
    !Array.isArray(draft.recipientIds) ||
    !draft.recipientIds.length ||
    draft.recipientIds.length > 5000 ||
    draft.recipientIds.some(
      (id) => typeof id !== "string" || !id || id.length > 160,
    ) ||
    new Set(draft.recipientIds).size !== draft.recipientIds.length ||
    !draft.recipientKeys ||
    typeof draft.recipientKeys !== "object" ||
    draft.recipientIds.some(
      (id) =>
        typeof draft.recipientKeys[id] !== "string" &&
        draft.recipientKeys[id] !== null,
    ) ||
    typeof draft.duration !== "string" ||
    !Number.isFinite(Number(draft.duration)) ||
    Number(draft.duration) <= 0 ||
    Number(draft.duration) > 24 ||
    (draft.sourceCircleId !== null && typeof draft.sourceCircleId !== "string")
  )
    return null;
  const captured = Date.parse(point.capturedAt),
    reviewed = Date.parse(draft.reviewedAt);
  if (
    !Number.isFinite(captured) ||
    !Number.isFinite(reviewed) ||
    reviewed > now + 30_000 ||
    captured > reviewed + 30_000 ||
    reviewed - captured > 60_000 ||
    now - reviewed > 10 * 60_000
  )
    return null;
  return draft;
}

/** Only this salted change detector may leave the client before encryption. */
export async function privateCheckInDigest(
  draft: Pick<PrivateCheckInDraft, "salt" | "point" | "note">,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([draft.salt, draft.point, draft.note]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

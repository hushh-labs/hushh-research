import { validDocumentRequestTerms } from "@/lib/services/drive-sharing-service";

export type FileRequestTerms = {
  purpose: string;
  periodStart: string | null;
  periodEnd: string | null;
  accessDays?: number;
  requesterActorType?: "person" | "ria";
  reason?: string;
  receiveThrough?: "drive" | "one" | "both";
  activityAccepted?: boolean;
  activityDisclosureVersion?: string;
};

export const FILE_REQUEST_HELPER =
  "You get original Drive links for the files they share with you.";

export function validFileRequest(terms: FileRequestTerms): boolean {
  if (terms.receiveThrough && !["drive", "one", "both"].includes(terms.receiveThrough)) return false;
  if (terms.receiveThrough && terms.receiveThrough !== "drive" && (!terms.activityAccepted || terms.activityDisclosureVersion !== "one-document-activity-v1")) return false;
  if (terms.accessDays !== undefined &&
    (!Number.isSafeInteger(terms.accessDays) || terms.accessDays < 1 || terms.accessDays > 90)) return false;
  if (terms.requesterActorType !== undefined &&
    terms.requesterActorType !== "person" && terms.requesterActorType !== "ria") return false;
  if (terms.reason !== undefined && (terms.reason.length > 500 ||
    (terms.requesterActorType === "ria" && !terms.reason.trim()))) return false;
  return validDocumentRequestTerms(
    terms.purpose,
    terms.periodStart || null,
    terms.periodEnd || null,
  );
}

export function normalizeFileRequestTerms(terms: FileRequestTerms): FileRequestTerms {
  return {
    purpose: terms.purpose.trim(),
    periodStart: terms.periodStart || null,
    periodEnd: terms.periodEnd || null,
    ...(terms.accessDays === undefined ? {} : { accessDays: terms.accessDays }),
    ...(terms.requesterActorType === undefined ? {} : { requesterActorType: terms.requesterActorType }),
    ...(terms.reason === undefined ? {} : { reason: terms.reason.trim() }),
    ...(terms.receiveThrough === undefined ? {} : { receiveThrough: terms.receiveThrough }),
    ...(terms.activityAccepted === undefined ? {} : { activityAccepted: terms.activityAccepted }),
    ...(terms.activityDisclosureVersion === undefined ? {} : { activityDisclosureVersion: terms.activityDisclosureVersion }),
  };
}

export function fileRequestFingerprint(personRef: string, terms: FileRequestTerms): string {
  const clean = normalizeFileRequestTerms(terms);
  return JSON.stringify({ personRef, ...clean });
}

export function fileRequestLabel(
  phase: "idle" | "verifying" | "sending",
  needsGoogle: boolean,
): string {
  if (phase !== "idle") return "Sending…";
  return needsGoogle ? "Add Google account" : "Request files";
}

"use client";

export const PERSON_PROFILE_PREVIEW_EVENT = "hussh:person-profile-preview";

/** Identity comes from an authenticated people response, never a name or photo. */
export type PersonProfilePreviewIdentity = {
  personRef?: string | null;
  userId?: string | null;
  networkList?: "mutuals" | "connections" | "discovery";
  presentation?: "calendar" | "connect";
};

export function isPersonProfilePreviewOpen(doc: Document = document): boolean {
  return Boolean(doc.querySelector('[data-person-profile-preview][data-state="open"]'));
}

export function openPersonProfilePreview(identity: PersonProfilePreviewIdentity, returnFocus?: HTMLElement): boolean {
  if (!identity.personRef?.trim() && !identity.userId?.trim() && identity.networkList !== "discovery") return false;
  const opener = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const presentation = identity.presentation ?? (opener?.closest("[data-typography-scope]") ? "connect" : undefined);
  return !window.dispatchEvent(new CustomEvent(PERSON_PROFILE_PREVIEW_EVENT, {
    cancelable: true,
    detail: { ...identity, presentation, returnFocus: opener },
  }));
}

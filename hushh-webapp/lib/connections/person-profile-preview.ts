"use client";

export const PERSON_PROFILE_PREVIEW_EVENT = "hussh:person-profile-preview";

/** Identity comes from an authenticated people response, never a name or photo. */
export type PersonProfilePreviewIdentity = {
  personRef?: string | null;
  userId?: string | null;
};

export function isPersonProfilePreviewOpen(doc: Document = document): boolean {
  return Boolean(doc.querySelector('[data-person-profile-preview][data-state="open"]'));
}

export function openPersonProfilePreview(identity: PersonProfilePreviewIdentity, returnFocus?: HTMLElement): boolean {
  if (!identity.personRef?.trim() && !identity.userId?.trim()) return false;
  return !window.dispatchEvent(new CustomEvent(PERSON_PROFILE_PREVIEW_EVENT, {
    cancelable: true,
    detail: { ...identity, returnFocus: returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined) },
  }));
}

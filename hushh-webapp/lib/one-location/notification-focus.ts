/** Exact notification intent; explicit navigation always wins. */
export type LocationDeepLinkFocus = {
  detailAction: ("needs-review" | "shared-with-me") | null;
  nextTab: "now" | "people" | "links" | null;
};

/**
 * Resolve where a location deep link should land. An explicit `section` (set by
 * the notification "Open" action) ALWAYS wins over the id-presence heuristics:
 * an approval notification carries BOTH the newly created grantId and the
 * originating requestId, so only the section separates "Shared with me"
 * (section=shared) from "Needs my review" (section=approvals). Checking
 * `hasRequest` before the section — as the previous inline logic did — stranded
 * an approved requester on "Needs my review". The id checks remain as fallbacks
 * for legacy links that omit the section.
 */
export function resolveLocationDeepLinkFocus(input: {
  section: string;
  hasRequest: boolean;
  hasGrant: boolean;
  hasSubmission: boolean;
}): LocationDeepLinkFocus {
  const { section, hasRequest, hasGrant, hasSubmission } = input;
  if (section === "approvals" || section === "my_requests") {
    return { detailAction: "needs-review", nextTab: null };
  }
  if (section === "shared") {
    return { detailAction: "shared-with-me", nextTab: null };
  }
  if (section === "public_responses") {
    return { detailAction: null, nextTab: "links" };
  }
  if (section === "people") {
    return { detailAction: null, nextTab: "people" };
  }
  if (hasRequest) {
    return { detailAction: "needs-review", nextTab: null };
  }
  if (hasGrant) {
    return { detailAction: "shared-with-me", nextTab: null };
  }
  if (hasSubmission) {
    return { detailAction: null, nextTab: "links" };
  }
  return { detailAction: null, nextTab: null };
}

/** Resolve legacy notification intent without overriding a later explicit navigation. */
export function resolveLocationNotificationFocus(
  params: Pick<URLSearchParams, "get">,
): LocationDeepLinkFocus {
  if (params.get("action")?.trim()) {
    return { detailAction: null, nextTab: null };
  }
  const section = params.get("section")?.trim() ?? "";
  const view = params.get("view")?.trim();
  // Back and tab changes can retain a notification's ids. A named hub view
  // closes that detail; an explicit notification section still names its target.
  if (!section && (view === "now" || view === "people" || view === "links")) {
    return { detailAction: null, nextTab: null };
  }
  return resolveLocationDeepLinkFocus({
    section,
    hasRequest: Boolean(params.get("requestId")?.trim()),
    hasGrant: Boolean(params.get("grantId")?.trim()),
    hasSubmission: Boolean(params.get("submissionId")?.trim()),
  });
}

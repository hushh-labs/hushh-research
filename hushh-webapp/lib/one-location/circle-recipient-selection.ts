import type {
  OneLocationCircleDetail,
  OneLocationCircleMember,
  OneLocationRecipient,
} from "@/lib/one-location/types";

export type CircleRecipientExclusionReason =
  | "self"
  | "location_setup_needed"
  | "phone_verification_needed";

export type CircleRecipientExclusion = {
  member: OneLocationCircleMember;
  reason: CircleRecipientExclusionReason;
  label: string;
};

export type CircleRecipientTarget = {
  recipient: OneLocationRecipient & {
    keyId: string;
    publicKeyJwk: JsonWebKey;
  };
  sourceCircleId: string;
};

export type CircleRecipientSelection = {
  circle: OneLocationCircleDetail;
  ready: CircleRecipientTarget[];
  excluded: CircleRecipientExclusion[];
};

function exclusionLabel(reason: CircleRecipientExclusionReason): string {
  if (reason === "self") return "You are not added as a recipient";
  if (reason === "phone_verification_needed")
    return "Phone verification is needed for SMS";
  return "Location setup is not complete";
}

/**
 * Resolve the current authenticated Circle roster into explicit, encrypted
 * person-level targets. This is a snapshot: future Circle members are never
 * included automatically.
 */
export function resolveCircleRecipientSelection(params: {
  circle: OneLocationCircleDetail;
  currentUserId?: string | null;
  requirePhoneVerified?: boolean;
}): CircleRecipientSelection {
  const currentUserId = String(params.currentUserId || "").trim();
  const ready: CircleRecipientTarget[] = [];
  const excluded: CircleRecipientExclusion[] = [];
  const seen = new Set<string>();

  for (const member of params.circle.members ?? []) {
    const userId = String(member.userId || "").trim();
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);

    let reason: CircleRecipientExclusionReason | null = null;
    if (userId === currentUserId) {
      reason = "self";
    } else if (params.requirePhoneVerified && !member.phoneVerified) {
      reason = "phone_verification_needed";
    } else if (
      !member.canReceiveLocation ||
      !member.keyId ||
      !member.publicKeyJwk
    ) {
      reason = "location_setup_needed";
    }

    if (reason) {
      excluded.push({
        member,
        reason,
        label: exclusionLabel(reason),
      });
      continue;
    }

    ready.push({
      sourceCircleId: params.circle.id,
      recipient: {
        userId,
        displayName: member.displayName,
        phoneVerified: member.phoneVerified,
        keyId: member.keyId!,
        publicKeyJwk: member.publicKeyJwk!,
        keyAlgorithm:
          member.keyAlgorithm || "ECDH-P256-AES256-GCM", // gitleaks:allow - public algorithm identifier
        keyRegisteredAt: member.keyRegisteredAt,
        canReceiveLocation: true,
      },
    });
  }

  return { circle: params.circle, ready, excluded };
}

/**
 * Whether a resolved Circle is *still* the recipient selection.
 *
 * Picking a Circle selects each of its ready members individually in the people
 * list below, and those rows stay individually deselectable. The moment one of
 * them is turned off the share is no longer "this Circle", so the Circle row
 * must stop reading as selected — and the next tap on it must re-apply the full
 * roster rather than clear what is left.
 */
export function isCircleSelectionFullySelected(
  selection: CircleRecipientSelection | null | undefined,
  selectedRecipientIds: readonly string[],
): boolean {
  const ready = selection?.ready ?? [];
  if (!ready.length) return false;
  const selected = new Set(selectedRecipientIds);
  return ready.every((target) => selected.has(target.recipient.userId));
}

export function mergeRecipientsByUserId(
  ...groups: OneLocationRecipient[][]
): OneLocationRecipient[] {
  const merged = new Map<string, OneLocationRecipient>();
  for (const group of groups) {
    for (const recipient of group) {
      if (!recipient.userId) continue;
      const existing = merged.get(recipient.userId);
      // Prefer the richer/latest value while retaining recommendation metadata
      // from the normal People directory when Circle detail supplies the key.
      merged.set(recipient.userId, {
        ...(existing ?? {}),
        ...recipient,
        recommendationScore:
          recipient.recommendationScore ?? existing?.recommendationScore,
        recommendationRank:
          recipient.recommendationRank ?? existing?.recommendationRank,
        recommendationTier:
          recipient.recommendationTier ?? existing?.recommendationTier,
        recommendationCategory:
          recipient.recommendationCategory ?? existing?.recommendationCategory,
        recommendationCategoryLabel:
          recipient.recommendationCategoryLabel ??
          existing?.recommendationCategoryLabel,
        recommendationReasons:
          recipient.recommendationReasons ?? existing?.recommendationReasons,
        recommendationSummary:
          recipient.recommendationSummary ?? existing?.recommendationSummary,
      });
    }
  }
  return [...merged.values()];
}

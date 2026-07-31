"use client";

import { buildMarketplaceContactLookups } from "@/lib/marketplace/contact-matching";
import {
  RiaService,
  type MarketplaceContactMatch,
} from "@/lib/services/ria-service";

export type OneLocationContactSignalResult = {
  matches: MarketplaceContactMatch[];
  matchedUserIds: string[];
  totalContacts: number;
  inviteCandidateCount: number;
  sourcePlatform: "web" | "ios" | "android" | "native";
};

export async function syncOneLocationContactSignals({
  idToken,
  contactLimit = 500,
  matchLimit = 50,
}: {
  idToken: string;
  contactLimit?: number;
  matchLimit?: number;
}): Promise<OneLocationContactSignalResult> {
  const lookupResult = await buildMarketplaceContactLookups({
    limit: contactLimit,
  });

  if (lookupResult.lookups.length === 0) {
    return {
      matches: [],
      matchedUserIds: [],
      totalContacts: lookupResult.totalContacts,
      inviteCandidateCount: lookupResult.totalContacts,
      sourcePlatform: lookupResult.sourcePlatform,
    };
  }

  const matches = await RiaService.matchMarketplaceContacts(idToken, {
    phone_lookups: lookupResult.lookups.map(({ hash, last4 }) => ({
      hash,
      last4,
    })),
    limit: matchLimit,
  });
  const privacySafeMatches = matches.map((match) => {
    const safeMatch = { ...match };
    delete safeMatch.phone_last4;
    return safeMatch as MarketplaceContactMatch;
  });
  const matchedUserIds = Array.from(
    new Set(
      privacySafeMatches
        .map((match) => String(match.user_id || "").trim())
        .filter(Boolean),
    ),
  );

  return {
    matches: privacySafeMatches,
    matchedUserIds,
    totalContacts: lookupResult.totalContacts,
    inviteCandidateCount: Math.max(
      0,
      lookupResult.totalContacts - matchedUserIds.length,
    ),
    sourcePlatform: lookupResult.sourcePlatform,
  };
}

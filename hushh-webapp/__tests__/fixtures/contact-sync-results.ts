// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Hushh
import type { OneLocationContactSignalResult } from "@/lib/one-location/contact-signals";

export function contactSyncResult(
  overrides: Partial<OneLocationContactSignalResult> = {},
): OneLocationContactSignalResult {
  return {
    matches: [
      {
        lookupId: "lookup_1",
        userId: "user_1",
        displayName: "Asha Rao",
        photoUrl: null,
        outcome: "auto_connected",
      },
    ],
    matchedUserIds: ["user_1"],
    totalContacts: 1200,
    readContactCount: 1200,
    checkedContactCount: 1200,
    matchedContactCount: 1,
    unmatchedContactCount: 1199,
    uncheckableContactCount: 0,
    excludedSelfContactCount: 0,
    lookupLimitedContactCount: 0,
    lookupLimitExceeded: false,
    unknownContactCount: 0,
    mutationOutcomeUnknown: false,
    uncheckedContactCount: 0,
    inviteCandidateCount: 1199,
    autoConnectedCount: 1,
    alreadyConnectedCount: 0,
    requestRequiredCount: 0,
    suppressedCount: 0,
    completedBatchCount: 2,
    totalBatchCount: 2,
    partial: false,
    sourcePlatform: "android",
    region: "IN",
    limited: false,
    truncated: false,
    ...overrides,
  };
}

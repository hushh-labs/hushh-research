// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContactSyncResultsSheet } from "@/components/one-location/contact-sync-results-sheet";
import type { OneLocationContactSignalResult } from "@/lib/one-location/contact-signals";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function result(
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

describe("ContactSyncResultsSheet", () => {
  it("renders large matched sets progressively without making any identity unreachable", () => {
    const matches = Array.from({ length: 205 }, (_, index) => ({
      lookupId: `lookup_${index + 1}`,
      userId: `user_${index + 1}`,
      displayName: `Matched Person ${index + 1}`,
      photoUrl: null,
      outcome: "already_connected" as const,
    }));
    render(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({
          matches,
          matchedUserIds: matches.map((match) => match.userId),
          matchedContactCount: 205,
          alreadyConnectedCount: 205,
        })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Matched Person 100")).toBeInTheDocument();
    expect(screen.queryByText("Matched Person 101")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 100 of 205 matched people")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more (100)" }));
    expect(screen.getByText("Matched Person 200")).toBeInTheDocument();
    expect(screen.queryByText("Matched Person 201")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more (5)" }));
    expect(screen.getByText("Matched Person 205")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("lists matched identities but keeps unmatched contacts aggregate-only", () => {
    render(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result()}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );

    expect(screen.getByText("Asha Rao")).toBeInTheDocument();
    expect(screen.getByText("1199")).toBeInTheDocument();
    expect(
      screen.getByText(/raw phone numbers are never sent to Hushh/i),
    ).toBeInTheDocument();
    expect(screen.getByText("No match")).toBeInTheDocument();
    expect(screen.queryByText("Not on Hushh")).toBeNull();
    expect(screen.queryByText(/Local contact/i)).not.toBeInTheDocument();
  });

  it("explains consent-safe eligibility when no account can be listed", () => {
    render(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({
          matches: [],
          matchedUserIds: [],
          matchedContactCount: 0,
          autoConnectedCount: 0,
          inviteCandidateCount: 1200,
        })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/verified their phone and chose to be found/i),
    ).toBeInTheDocument();
  });

  it("wraps long matched identities instead of clipping them", () => {
    const longName =
      "Wilhelmina Featherstonehaugh-Rajendran International Household";
    render(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({
          matches: [
            {
              lookupId: "lookup_long",
              userId: "user_long",
              displayName: longName,
              photoUrl: null,
              outcome: "request_required",
            },
          ],
        })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );

    const identity = screen.getByText(longName);
    expect(identity.className).toContain("break-words");
    expect(identity.className).not.toContain("truncate");
    expect(identity.textContent).toBe(longName);
  });

  it("separates outcome-unknown contacts from unmatched invite candidates", () => {
    render(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({
          checkedContactCount: 1000,
          unmatchedContactCount: 999,
          inviteCandidateCount: 999,
          unknownContactCount: 200,
          mutationOutcomeUnknown: true,
          partial: true,
          partialFailureMessage:
            "A sync request may have completed even though its response was lost.",
        })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );

    expect(screen.getByText(/200 contacts need confirmation/i)).toBeInTheDocument();
    expect(screen.getByText(/not counted as unmatched or inviteable/i)).toBeInTheDocument();
  });

  it("offers Done only for cap-only partials and keeps retry for ambiguous mutation", () => {
    const view = render(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({
          lookupLimitExceeded: true,
          lookupLimitedContactCount: 2,
          uncheckedContactCount: 2,
          partial: true,
        })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync again" })).toBeNull();

    view.rerender(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({
          lookupLimitExceeded: true,
          lookupLimitedContactCount: 2,
          unknownContactCount: 1,
          mutationOutcomeUnknown: true,
          partialFailureMessage: "The response was lost.",
          partial: true,
        })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Sync again" })).toBeInTheDocument();

    view.rerender(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({
          lookupLimitExceeded: true,
          lookupLimitedContactCount: 2,
          uncheckedContactCount: 3,
          partial: true,
        })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Sync again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("shows connected provenance and no request action for auto-connected rows", () => {
    render(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({
          matches: [
            {
              lookupId: "lookup_1",
              userId: "user_1",
              displayName: "Asha Rao",
              photoUrl: null,
              outcome: "auto_connected",
            },
          ],
          autoConnectedCount: 1,
          requestRequiredCount: 0,
        })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText("Connected from your contacts"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send a connection request/i }))
      .not.toBeInTheDocument();
  });

  it("explains a bounded matched result even when no contact becomes unchecked", () => {
    render(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({
          lookupLimitExceeded: true,
          lookupLimitedContactCount: 0,
          partial: true,
        })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Additional numbers were outside the limit/i),
    ).toBeInTheDocument();
  });

  it("explains contacts skipped because they contain only the signed-in user's number", () => {
    render(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({ excludedSelfContactCount: 2 })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        /2 contact entries containing your own number were skipped/i,
      ),
    ).toBeInTheDocument();
  });

  it("resets progressive rendering when a fresh result arrives", async () => {
    const matches = Array.from({ length: 150 }, (_, index) => ({
      lookupId: `lookup_${index + 1}`,
      userId: `user_${index + 1}`,
      displayName: `First Sync ${index + 1}`,
      photoUrl: null,
      outcome: "already_connected" as const,
    }));
    const view = render(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({ matches, matchedUserIds: matches.map((row) => row.userId) })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show more (50)" }));
    expect(screen.getByText("First Sync 150")).toBeInTheDocument();

    const freshMatches = matches.map((match, index) => ({
      ...match,
      displayName: `Fresh Sync ${index + 1}`,
    }));
    view.rerender(
      <ContactSyncResultsSheet
        open
        onOpenChange={vi.fn()}
        result={result({
          matches: freshMatches,
          matchedUserIds: freshMatches.map((row) => row.userId),
          completedBatchCount: 2,
        })}
        syncing={false}
        onSyncAgain={vi.fn()}
        onInvite={vi.fn()}
        onRequestConnection={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByText("Fresh Sync 101")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Showing 100 of 150 matched people")).toBeInTheDocument();
  });
});

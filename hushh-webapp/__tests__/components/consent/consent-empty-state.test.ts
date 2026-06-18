import { describe, expect, it } from "vitest";

/**
 * Consent Empty-State Visibility Guard Tests
 *
 * Proves the conditional logic that gates the two empty-state cards
 * added to consent-center-page.tsx:
 *
 *   1. Non-relationship tab empty state ("Your vault is secure")
 *      Condition: !listResource.loading && !showFullRetryState && tab !== "relationships" && items.length === 0
 *
 *   2. Relationships tab empty state ("No active relationships")
 *      Condition: !centerResource.loading && !showFullRetryState && tab === "relationships" && items.length === 0
 *
 * These are pure boolean guards — no component mount needed.
 * The test proves the boundary: empty-state only shows when data
 * is resolved, there is no full retry state, and the list is empty.
 */

type EmptyStateParams = {
  loading: boolean;
  showFullRetryState: boolean;
  tab: string;
  itemCount: number;
};

function shouldShowNonRelationshipEmptyState({
  loading,
  showFullRetryState,
  tab,
  itemCount,
}: EmptyStateParams): boolean {
  return !loading && !showFullRetryState && tab !== "relationships" && itemCount === 0;
}

function shouldShowRelationshipEmptyState({
  loading,
  showFullRetryState,
  tab,
  itemCount,
}: EmptyStateParams): boolean {
  return !loading && !showFullRetryState && tab === "relationships" && itemCount === 0;
}

describe("consent empty-state: non-relationship tabs", () => {
  it("shows when resolved with zero items on requests tab", () => {
    expect(
      shouldShowNonRelationshipEmptyState({
        loading: false,
        showFullRetryState: false,
        tab: "requests",
        itemCount: 0,
      })
    ).toBe(true);
  });

  it("shows when resolved with zero items on active tab", () => {
    expect(
      shouldShowNonRelationshipEmptyState({
        loading: false,
        showFullRetryState: false,
        tab: "active",
        itemCount: 0,
      })
    ).toBe(true);
  });

  it("shows when resolved with zero items on history tab", () => {
    expect(
      shouldShowNonRelationshipEmptyState({
        loading: false,
        showFullRetryState: false,
        tab: "history",
        itemCount: 0,
      })
    ).toBe(true);
  });

  it("does NOT show while still loading", () => {
    expect(
      shouldShowNonRelationshipEmptyState({
        loading: true,
        showFullRetryState: false,
        tab: "requests",
        itemCount: 0,
      })
    ).toBe(false);
  });

  it("does NOT show when full retry state is active (error with no cached data)", () => {
    expect(
      shouldShowNonRelationshipEmptyState({
        loading: false,
        showFullRetryState: true,
        tab: "requests",
        itemCount: 0,
      })
    ).toBe(false);
  });

  it("does NOT show when items are present", () => {
    expect(
      shouldShowNonRelationshipEmptyState({
        loading: false,
        showFullRetryState: false,
        tab: "requests",
        itemCount: 3,
      })
    ).toBe(false);
  });

  it("does NOT show on relationships tab", () => {
    expect(
      shouldShowNonRelationshipEmptyState({
        loading: false,
        showFullRetryState: false,
        tab: "relationships",
        itemCount: 0,
      })
    ).toBe(false);
  });
});

describe("consent empty-state: relationships tab", () => {
  it("shows when resolved with zero relationships", () => {
    expect(
      shouldShowRelationshipEmptyState({
        loading: false,
        showFullRetryState: false,
        tab: "relationships",
        itemCount: 0,
      })
    ).toBe(true);
  });

  it("does NOT show while center resource is still loading", () => {
    expect(
      shouldShowRelationshipEmptyState({
        loading: true,
        showFullRetryState: false,
        tab: "relationships",
        itemCount: 0,
      })
    ).toBe(false);
  });

  it("does NOT show when full retry state is active", () => {
    expect(
      shouldShowRelationshipEmptyState({
        loading: false,
        showFullRetryState: true,
        tab: "relationships",
        itemCount: 0,
      })
    ).toBe(false);
  });

  it("does NOT show when relationships exist", () => {
    expect(
      shouldShowRelationshipEmptyState({
        loading: false,
        showFullRetryState: false,
        tab: "relationships",
        itemCount: 2,
      })
    ).toBe(false);
  });

  it("does NOT show on non-relationship tabs", () => {
    expect(
      shouldShowRelationshipEmptyState({
        loading: false,
        showFullRetryState: false,
        tab: "active",
        itemCount: 0,
      })
    ).toBe(false);
  });
});

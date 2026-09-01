import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, because `vi.mock` is lifted above every import and a plain
// `const` would not exist yet when the factory runs.
const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));

vi.mock("@/lib/services/api-client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/services/api-client")
  >("@/lib/services/api-client");
  return { ...actual, apiJson };
});

import { OneLocationService } from "@/lib/one-location/service";
import { ApiError } from "@/lib/services/api-client";

/**
 * The paged reads must reject a payload they cannot iterate, at the boundary.
 *
 * This is not defensive tidiness. Every caller hands the list straight to a
 * React state updater — `setPagedRecipientsByUserId((current) => { for (const
 * row of result.items) … })` in `app/one/location/page.tsx`, `setMemberRows`
 * in `named-circle-flows.tsx`. React invokes those updaters after the awaited
 * call has returned, so a throw inside one lands OUTSIDE the caller's own
 * `try`/`catch` and outside a `.catch()` on the promise. The handler written
 * for exactly this case never runs, and the page dies instead.
 *
 * `/one/location` crashed this way on `result.items is not iterable`: a backend
 * answered 200 with `{ recipients: [...] }`, the unpaged shape the same route
 * returns when it is called with no page/limit. Nothing about that response is
 * an HTTP error, so `apiJson` passed it through intact.
 */

const RECIPIENT = {
  userId: "u-1",
  displayName: "Aman",
  email: "a***@example.com",
  isRia: false,
};

describe("one-location paged reads", () => {
  beforeEach(() => {
    apiJson.mockReset();
  });

  describe("listRecipientsPage", () => {
    it("passes a well-formed page through", async () => {
      apiJson.mockResolvedValue({
        items: [RECIPIENT],
        page: 2,
        hasMore: true,
        totalCount: 57,
      });

      const page = await OneLocationService.listRecipientsPage({
        vaultOwnerToken: "vot",
        page: 2,
      });

      expect(page.items).toEqual([RECIPIENT]);
      expect(page.page).toBe(2);
      expect(page.hasMore).toBe(true);
      expect(page.totalCount).toBe(57);
    });

    it("rejects the unpaged shape the same route also returns", async () => {
      // The exact payload that took /one/location down: a 200, no `items`.
      apiJson.mockResolvedValue({ recipients: [RECIPIENT] });

      await expect(
        OneLocationService.listRecipientsPage({ vaultOwnerToken: "vot" }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("rejects a null payload rather than returning an empty page", async () => {
      apiJson.mockResolvedValue(null);

      await expect(
        OneLocationService.listRecipientsPage({ vaultOwnerToken: "vot" }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("throws rather than coercing, so a caller keeps its last good page", async () => {
      // The distinction this whole change rests on. Coercing to `items: []`
      // would REPLACE the roster on screen with nothing, which reads as "you
      // have no one" — a worse answer than "that read failed", because it
      // looks like data. Throwing routes into the caller's existing catch,
      // whose comment already says it keeps the last safe page.
      apiJson.mockResolvedValue({ recipients: [] });

      const page = OneLocationService.listRecipientsPage({
        vaultOwnerToken: "vot",
      });

      await expect(page).rejects.toThrow(/items/i);
      await expect(page).rejects.not.toEqual(
        expect.objectContaining({ items: [] }),
      );
    });

    it("fills in a page number and total the server left out", async () => {
      apiJson.mockResolvedValue({ items: [RECIPIENT] });

      const page = await OneLocationService.listRecipientsPage({
        vaultOwnerToken: "vot",
        page: 3,
      });

      expect(page.page).toBe(3);
      expect(page.hasMore).toBe(false);
      expect(page.totalCount).toBe(1);
    });
  });

  describe("listCircleMembersPage", () => {
    it("passes a well-formed page through", async () => {
      apiJson.mockResolvedValue({
        items: [RECIPIENT],
        page: 1,
        hasMore: false,
        totalCount: 1,
      });

      const page = await OneLocationService.listCircleMembersPage({
        vaultOwnerToken: "vot",
        circleId: "c-1",
      });

      expect(page.items).toEqual([RECIPIENT]);
      expect(page.totalCount).toBe(1);
    });

    it("rejects a payload with no items", async () => {
      // Same defect, same shape: `for (const member of result.items)` inside
      // `setMemberRows` in named-circle-flows.tsx.
      apiJson.mockResolvedValue({ members: [RECIPIENT] });

      await expect(
        OneLocationService.listCircleMembersPage({
          vaultOwnerToken: "vot",
          circleId: "c-1",
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });
});

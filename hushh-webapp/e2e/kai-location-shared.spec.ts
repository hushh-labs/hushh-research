import { expect, test } from "@playwright/test";

test.describe("KAI shared live location", () => {
  test("renders live coordinates, updates from polling, and reflects owner stop", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    let resolveCount = 0;

    await page.route(/\/api\/kai\/location\/shared\?token=live-token$/, async (route) => {
      resolveCount += 1;
      const activePayload = {
        state: "active",
        canRequestAccess: false,
        share: {
          id: "share-1",
          ownerUserId: "owner-1",
          contactId: "contact-1",
          contactDisplayName: "Family",
          contactTier: "family",
          contactAutoApprove: true,
          status: "active",
          liveMode: true,
          expiresAt: "2026-05-19T18:00:00.000Z",
          createdAt: "2026-05-19T17:00:00.000Z",
          updatedAt: "2026-05-19T17:00:00.000Z",
          lastViewedAt: null,
          deactivatedAt: null,
          revokedAt: null,
        },
        latest: {
          ownerUserId: "owner-1",
          latitude: resolveCount === 1 ? 12.9716 : 12.972,
          longitude: resolveCount === 1 ? 77.5946 : 77.5951,
          accuracyM: 9,
          headingDeg: null,
          speedMps: null,
          capturedAt: "2026-05-19T17:05:00.000Z",
          sourcePlatform: "web",
          updatedAt: "2026-05-19T17:05:00.000Z",
        },
        live: {
          transport: "gcp_polling",
          pollIntervalMs: 5000,
          staleAfterSeconds: 90,
          serverTime: "2026-05-19T17:05:05.000Z",
          isLive: true,
          freshnessSeconds: 5,
          stoppedAt: null,
        },
      };

      const stoppedPayload = {
        state: "revoked",
        canRequestAccess: false,
        share: {
          ...activePayload.share,
          status: "revoked",
          revokedAt: "2026-05-19T17:05:10.000Z",
        },
        latest: null,
        live: {
          transport: "gcp_polling",
          pollIntervalMs: 5000,
          staleAfterSeconds: 90,
          serverTime: "2026-05-19T17:05:10.000Z",
          isLive: false,
          freshnessSeconds: null,
          stoppedAt: "2026-05-19T17:05:10.000Z",
        },
      };

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(resolveCount >= 3 ? stoppedPayload : activePayload),
      });
    });

    await page.goto("/location/shared?token=live-token", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Shared Location" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("12.971600, 77.594600")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();

    await expect(page.getByText("12.972000, 77.595100")).toBeVisible({
      timeout: 7000,
    });
    await expect(page.getByRole("heading", { name: "Live location stopped" }).first()).toBeVisible(
      {
        timeout: 7000,
      }
    );
  });

  test("lets an expired viewer request renewed access", async ({ page }) => {
    test.setTimeout(60_000);

    await page.route(/\/api\/kai\/location\/shared\?token=expired-token$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          state: "expired",
          canRequestAccess: true,
          share: {
            id: "share-1",
            ownerUserId: "owner-1",
            contactId: "contact-1",
            contactDisplayName: "Friend",
            contactTier: "friend",
            contactAutoApprove: false,
            status: "deactivated",
            liveMode: true,
            expiresAt: "2026-05-19T17:00:00.000Z",
            createdAt: "2026-05-19T16:00:00.000Z",
            updatedAt: "2026-05-19T17:00:00.000Z",
            lastViewedAt: null,
            deactivatedAt: "2026-05-19T17:00:01.000Z",
            revokedAt: null,
          },
          latest: null,
          live: {
            transport: "gcp_polling",
            pollIntervalMs: 5000,
            staleAfterSeconds: 90,
            serverTime: "2026-05-19T17:05:00.000Z",
            isLive: false,
            freshnessSeconds: null,
            stoppedAt: "2026-05-19T17:00:01.000Z",
          },
        }),
      });
    });
    await page.route("**/api/kai/location/shared/access-request", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(await route.request().postDataJSON()).toMatchObject({
        token: "expired-token",
        requesterLabel: "Alex",
        requesterMessage: "Need your live location again",
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "pending",
          accessRequest: {
            id: "request-1",
            shareId: "share-1",
            ownerUserId: "owner-1",
            contactId: "contact-1",
            contactDisplayName: "Friend",
            contactTier: "friend",
            status: "pending",
            requesterLabel: "Alex",
            requesterMessage: "Need your live location again",
            requestedAt: "2026-05-19T17:05:00.000Z",
            resolvedAt: null,
            renewedShareId: null,
          },
          share: null,
          publicView: null,
        }),
      });
    });

    await page.goto("/location/shared?token=expired-token", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Location link expired" }).first()).toBeVisible(
      {
        timeout: 15_000,
      }
    );
    await page.getByLabel("Your name").fill("Alex");
    await page.getByLabel("Message").fill("Need your live location again");
    await page.getByRole("button", { name: "Request access" }).click();
    await expect(page.getByRole("button", { name: "Request sent" })).toBeVisible();
  });
});

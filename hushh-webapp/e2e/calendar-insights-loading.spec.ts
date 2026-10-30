import { expect, test } from "@playwright/test";
import { openFixture, registerCalendarConnectedFixture } from "./fixtures/calendar-connected-workspace-harness";

registerCalendarConnectedFixture();

test("Calendar Insights keeps controls stable during cold, warm and refreshed reads", async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await openFixture(page, 1280);
  const reads: { date: string; query: string }[] = [];
  let releaseCold!: () => void;
  const coldGate = new Promise<void>(resolve => { releaseCold = resolve; });
  const rows = ["a", "b", "c", "d", "e"].map((id, index) => ({
    id, calendar_id: "primary", account_id: "default", occurrence_id: id.repeat(64), grant_id: "b".repeat(64),
    sources: [{ calendar_id: "primary", event_id: id }], title: `QA meeting ${index + 1}`,
    start: { dateTime: "2026-10-14T09:00:00Z" }, artifact_kinds: [], availability: {}, discovery: "checked", file_state: "unknown",
  }));
  await page.route("**/api/one/calendar/meetings", async route => {
    const body = route.request().postDataJSON() as { date: string; time_zone: string; query?: string };
    reads.push({ date: body.date, query: body.query || "" });
    if (reads.length === 1) await coldGate;
    await route.fulfill({ json: { complete: true, calendar_complete: true, next_cursor: null, limitations: [],
      checked_events: 5, meeting_file_access: "ready", account_id: "default", date: body.date, time_zone: body.time_zone,
      meetings: rows.filter(row => row.title.toLowerCase().includes((body.query || "").toLowerCase())),
    } });
  });
  await page.route("**/api/one/calendar/meetings/request-statuses", route => route.fulfill({ json: { meetings: [] } }));
  await page.getByRole("tab", { name: "Insights", exact: true }).click();
  const start = Date.now();
  await page.getByRole("button", { name: /Recordings & Notes/ }).click();
  const search = page.getByRole("searchbox", { name: "Search meetings on this day" });
  await expect(search).toBeVisible();
  const controlMs = Date.now() - start;
  const before = (await search.boundingBox())!;
  await expect(page.getByText("Checking meetings…")).toBeVisible();
  await expect(page.getByRole("status", { name: "Insights loading" })).toHaveCount(0);
  expect(reads).toHaveLength(1);
  releaseCold();
  await expect(page.getByRole("button", { name: /QA meeting 1/ })).toBeVisible();
  const coldMs = Date.now() - start;
  const after = (await search.boundingBox())!;
  const controlShiftPx = Math.abs(after.y - before.y);
  expect(controlShiftPx).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: /QA meeting/ })).toHaveCount(5);

  await page.getByRole("button", { name: "Back to Insights" }).click();
  const warmStart = Date.now();
  await page.getByRole("button", { name: /Recordings & Notes/ }).click();
  await expect(page.getByRole("button", { name: /QA meeting 1/ })).toBeVisible();
  const warmMs = Date.now() - warmStart;
  await expect.poll(() => reads.length).toBe(2);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => reads.length).toBe(3);
  await search.fill("Q");
  await search.fill("QA");
  await search.fill("QA meeting");
  await expect.poll(() => reads.length).toBe(4);
  expect(reads.filter(read => read.query === "QA meeting")).toHaveLength(1);
  await page.getByRole("button", { name: "Next day" }).click();
  await expect.poll(() => reads.length).toBe(5);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hushh:feed-state-changed", { detail: { reason: "arrived" } })));
  await expect.poll(() => reads.length).toBe(6);
  expect(controlMs).toBeLessThan(coldMs);
  expect(warmMs).toBeLessThan(coldMs);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpectedRequests).toEqual([]);
});

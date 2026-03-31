const { test, expect } = require("@playwright/test");
const {
  ensureReviewerSession,
  gotoStable,
  installPasskeyBypass,
  seedKaiOnboardingResolved,
  unlockIfNeeded,
} = require("./runtime-audit.helpers.js");

function escapeRe(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function maybeVisible(locator) {
  return await locator.isVisible().catch(() => false);
}

async function text(locator) {
  return ((await locator.textContent().catch(() => "")) || "").trim();
}

async function getHistoryRowTimestamp(page, ticker) {
  const search = page.getByPlaceholder(/search analysis history by ticker or company/i);
  const searchVisible = await search.isVisible().catch(() => false);
  if (!searchVisible) {
    return { exists: false, timestamp: null };
  }
  await search.fill("");
  await search.fill(ticker);
  await page.waitForTimeout(1200);

  const row = page
    .getByRole("row")
    .filter({ hasText: new RegExp(`\\b${escapeRe(ticker)}\\b`, "i") })
    .first();
  if (!(await maybeVisible(row))) {
    return { exists: false, timestamp: null };
  }

  const timestamp = await text(row.locator("td").nth(4));
  return { exists: true, timestamp: timestamp || null };
}

async function openHistoryEntry(page, ticker) {
  const row = page
    .getByRole("row")
    .filter({ hasText: new RegExp(`\\b${escapeRe(ticker)}\\b`, "i") })
    .first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  await row.getByRole("button", { name: /open menu/i }).click();
  await page.getByRole("menuitem", { name: /view analysis/i }).click();
}

async function ensureKaiInvestorReady(page) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const chooserHeading = page.getByRole("heading", {
      name: /start as an investor or set up ria first/i,
    });
    if (await maybeVisible(chooserHeading)) {
      await page
        .getByRole("button", {
          name: /investor build your kai profile first/i,
        })
        .click();
      await page.waitForTimeout(1200);
      continue;
    }

    const questionOne = page.getByRole("heading", {
      name: /how long do you expect to keep this money invested/i,
    });
    if (await maybeVisible(questionOne)) {
      await page.getByText(/3.?7 years/i).click();
      await page.getByRole("button", { name: /^next$/i }).click();
      await page.waitForTimeout(900);
      continue;
    }

    const questionTwo = page.getByRole("heading", {
      name: /if your portfolio drops 20%/i,
    });
    if (await maybeVisible(questionTwo)) {
      await page.getByText(/stay invested and review the situation/i).click();
      await page.getByRole("button", { name: /^next$/i }).click();
      await page.waitForTimeout(900);
      continue;
    }

    const questionThree = page.getByRole("heading", {
      name: /which feels more comfortable/i,
    });
    if (await maybeVisible(questionThree)) {
      await page.getByText(/moderate ups and downs for better returns/i).click();
      await page.getByRole("button", { name: /^continue$/i }).click();
      await page.waitForTimeout(1200);
      continue;
    }

    const openPortfolio = page.getByRole("button", { name: /open portfolio/i });
    if (await maybeVisible(openPortfolio)) {
      await openPortfolio.click();
      await page.waitForTimeout(1500);
      continue;
    }

    const topBarTitle = page.locator('[data-testid="top-app-bar-title"]').first();
    const topBarText = (await text(topBarTitle)).toLowerCase();
    if (topBarText && !topBarText.includes("get started")) {
      return;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error("Kai investor onboarding did not settle into the signed-in shell.");
}

test.describe("Kai debate flow", () => {
  test.setTimeout(240_000);

  test("persists selected source and saves to PKM history", async ({ page }) => {
    const ticker = "AAPL";

    await installPasskeyBypass(page);
    await ensureReviewerSession(page);
    await seedKaiOnboardingResolved(page);
    await unlockIfNeeded(page);
    await gotoStable(page, "/kai");
    await page.waitForTimeout(1200);
    await unlockIfNeeded(page);
    await ensureKaiInvestorReady(page);
    await page.getByRole("radio", { name: /^analysis$/i }).click();
    await page.waitForTimeout(1800);
    await unlockIfNeeded(page);

    const before = await getHistoryRowTimestamp(page, ticker);
    await page.evaluate((nextTicker) => {
      window.history.pushState({}, "", `/kai/analysis?ticker=${encodeURIComponent(nextTicker)}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, ticker);
    await page.waitForTimeout(1800);

    const previewHeading = page.getByText(/compare before debate|vs the active picks list/i).first();
    await expect(previewHeading).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("button", { name: /open full analysis/i })).toHaveCount(0);

    const startDebate = page.getByRole("button", { name: /^start debate$/i }).first();
    await expect(startDebate).toBeVisible({ timeout: 15000 });

    const sourceTrigger = page.locator('button[role="combobox"]').first();
    let selectedSourceLabel = await text(sourceTrigger);
    let selectedRiaSource = false;
    if (await maybeVisible(sourceTrigger)) {
      await sourceTrigger.click();
      await page.waitForTimeout(500);

      const options = page.getByRole("option");
      const optionCount = await options.count();
      let chosenIndex = 0;
      for (let i = 0; i < optionCount; i += 1) {
        const label = await text(options.nth(i));
        if (/ria|advisor|connected/i.test(label) && !/default/i.test(label)) {
          chosenIndex = i;
          selectedRiaSource = true;
          break;
        }
      }

      if (optionCount > 0) {
        await options.nth(chosenIndex).click();
        await page.waitForTimeout(1200);
        selectedSourceLabel = (await text(sourceTrigger)) || selectedSourceLabel;
      }
    }

    await startDebate.click();

    const debateTab = page.getByRole("tab", { name: /^debate$/i });
    const summaryTab = page.getByRole("tab", { name: /^summary$/i });
    const detailedTab = page.getByRole("tab", { name: /detailed view/i });
    await expect(debateTab).toBeVisible({ timeout: 20000 });
    await expect(summaryTab).toBeVisible({ timeout: 20000 });
    await expect(detailedTab).toBeVisible({ timeout: 20000 });

    const finalRecommendation = page.getByText(/final recommendation/i).first();
    await expect(finalRecommendation).toBeVisible({ timeout: 240000 });

    await summaryTab.click();
    await page.waitForTimeout(1200);
    await expect(finalRecommendation).toBeVisible();

    const savingBanner = page.getByText(/saving this debate to your PKM history/i).first();
    const retrySave = page.getByRole("button", { name: /retry save/i }).first();
    const saveDeadline = Date.now() + 180000;
    while (Date.now() < saveDeadline) {
      if (await maybeVisible(retrySave)) {
        throw new Error("Persistence failed and surfaced Retry save.");
      }
      if (!(await maybeVisible(savingBanner))) {
        break;
      }
      await page.waitForTimeout(2000);
    }
    await expect(retrySave).toHaveCount(0);

    await detailedTab.click();
    await page.waitForTimeout(1200);
    await expect(finalRecommendation).toBeVisible();
    await expect(page.getByText(/AlphaAgents Reference:/i)).toHaveCount(0);
    await expect(page.getByRole("link", { name: /AlphaAgents paper/i }).first()).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByRole("link", { name: /AlphaAgents paper/i }).first()).toHaveAttribute(
      "href",
      /2508\.11152/
    );
    await expect(
      page.getByText(new RegExp(escapeRe(selectedSourceLabel), "i")).first()
    ).toBeVisible();

    await debateTab.click();
    await page.waitForTimeout(1000);
    await expect(
      page.getByText(/initial deep analysis|strategic debate|final recommendation/i).first()
    ).toBeVisible();

    await page.getByRole("button", { name: /back to history/i }).click();
    await page.waitForTimeout(1800);
    await unlockIfNeeded(page);

    const after = await getHistoryRowTimestamp(page, ticker);
    expect(after.exists).toBe(true);
    expect(!before.exists || after.timestamp !== before.timestamp).toBe(true);

    await openHistoryEntry(page, ticker);
    await page.waitForTimeout(1500);
    await expect(
      page.getByText(new RegExp(escapeRe(selectedSourceLabel), "i")).first()
    ).toBeVisible();

    test.info().annotations.push({
      type: "source",
      description: selectedSourceLabel || "unknown-source",
    });
    test.info().annotations.push({
      type: "source_kind",
      description: selectedRiaSource ? "ria" : "default",
    });
  });
});

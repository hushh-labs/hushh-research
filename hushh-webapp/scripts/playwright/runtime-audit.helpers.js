const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const dotenv = require("dotenv");

const CONSENT_PROTOCOL_ROOT = path.resolve(process.cwd(), "../consent-protocol");
const REPO_ROOT = path.resolve(process.cwd(), "..");
const ENV_FILES = [".env", ".env.local"];
const ROUTE_LAYOUT_CONTRACT = require(path.resolve(
  process.cwd(),
  "lib/navigation/app-route-layout.contract.json"
));

ENV_FILES.forEach((fileName) => {
  const envPath = path.join(CONSENT_PROTOCOL_ROOT, fileName);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
});

function resolveRawPassphrase() {
  for (const fileName of ENV_FILES) {
    const envPath = path.join(CONSENT_PROTOCOL_ROOT, fileName);
    if (!fs.existsSync(envPath)) continue;
    const source = fs.readFileSync(envPath, "utf8");
    const match = source.match(/^KAI_TEST_PASSPHRASE=(.+)$/m);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return process.env.KAI_TEST_PASSPHRASE || "";
}

function resolveReviewerUid() {
  for (const fileName of ENV_FILES) {
    const envPath = path.join(CONSENT_PROTOCOL_ROOT, fileName);
    if (!fs.existsSync(envPath)) continue;
    const source = fs.readFileSync(envPath, "utf8");
    const reviewerMatch = source.match(/^REVIEWER_UID=(.+)$/m);
    const reviewerUid = reviewerMatch?.[1]?.trim();
    if (reviewerUid && !/^__.+__$/.test(reviewerUid)) {
      return reviewerUid;
    }
    const kaiTestMatch = source.match(/^KAI_TEST_USER_ID=(.+)$/m);
    if (kaiTestMatch?.[1]) {
      return kaiTestMatch[1].trim();
    }
  }

  const runtimeReviewer = process.env.REVIEWER_UID || "";
  if (runtimeReviewer && !/^__.+__$/.test(runtimeReviewer)) {
    return runtimeReviewer;
  }
  return process.env.KAI_TEST_USER_ID || "";
}

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const BASE_ORIGIN = new URL(BASE_URL).origin;
const PASS = resolveRawPassphrase();
const REVIEWER_UID = resolveReviewerUid();
const SHELL_TOKEN_KEYS = [
  "--page-top-start",
  "--page-top-local-offset",
  "--app-top-mask-tail-clearance",
  "--app-top-content-offset",
  "--app-fullscreen-flow-content-offset",
];

function slugify(input) {
  return String(input || "")
    .replace(/^\//, "")
    .replace(/[/?=&]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "root";
}

function normalizeTokenValue(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s*([():,+\-/*])\s*/g, "$1")
    .trim();
}

function extractTokenSnapshotFromCss(sourceText) {
  const snapshot = {};
  for (const key of SHELL_TOKEN_KEYS) {
    const matcher = new RegExp(`${key}\\s*:\\s*([^;]+);`);
    const match = sourceText.match(matcher);
    snapshot[key] = match?.[1] ? normalizeTokenValue(match[1]) : null;
  }
  return snapshot;
}

function readSourceTokenSnapshot() {
  const globalsPath = path.resolve(process.cwd(), "app/globals.css");
  return extractTokenSnapshotFromCss(fs.readFileSync(globalsPath, "utf8"));
}

function runLocalCommand(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readLocalProcessFingerprint(port) {
  if (!/^https?:\/\/(?:localhost|127\.0\.0\.1):/i.test(BASE_URL)) {
    return null;
  }

  const pid = runLocalCommand("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"])
    .split(/\s+/)
    .map((value) => value.trim())
    .find(Boolean);
  if (!pid) {
    return null;
  }

  const processLine = runLocalCommand("ps", ["-p", pid, "-o", "pid=,lstart=,command="]);
  return {
    port,
    pid: String(pid),
    process: processLine || null,
  };
}

async function readServedTokenSnapshot(page) {
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map((node) => node.href)
      .filter((href) => href.includes("/_next/static/css/"))
  );

  const cssChunks = [];
  for (const href of hrefs) {
    const response = await page.request.get(href).catch(() => null);
    if (!response || !response.ok()) continue;
    cssChunks.push(await response.text().catch(() => ""));
  }

  return extractTokenSnapshotFromCss(cssChunks.join("\n"));
}

async function readComputedTokenSnapshot(page) {
  return await page.evaluate((tokenKeys) => {
    const root = getComputedStyle(document.documentElement);
    const shellRoot = document.querySelector('[data-app-shell-root="true"]');
    const shellStyles = shellRoot ? getComputedStyle(shellRoot) : null;
    const spacer = document.querySelector('[data-app-shell-top-spacer="true"]');
    const row = document.querySelector('[data-testid="top-app-bar-row"]');
    const anchor =
      document.querySelector('[data-page-primary="true"]') ||
      document.querySelector('[data-testid="page-primary-module"]') ||
      document.querySelector('[data-testid$="-primary"]') ||
      document.querySelector('[data-top-content-anchor="true"]') ||
      document.querySelector("main");

    const readTokens = (styles) =>
      tokenKeys.reduce((acc, key) => {
        acc[key] = styles ? styles.getPropertyValue(key).trim() : "";
        return acc;
      }, {});

    const spacerRect = spacer?.getBoundingClientRect?.() || null;
    const rowRect = row?.getBoundingClientRect?.() || null;
    const anchorRect = anchor?.getBoundingClientRect?.() || null;

    return {
      root: readTokens(root),
      shellRoot: readTokens(shellStyles),
      spacerHeight: spacerRect ? spacerRect.height : 0,
      rowBottom: rowRect ? rowRect.bottom : 0,
      firstMeaningfulTop: anchorRect ? anchorRect.top : 0,
    };
  }, SHELL_TOKEN_KEYS);
}

async function buildRuntimeFingerprint(page) {
  const sourceTokens = readSourceTokenSnapshot();
  const servedTokens = await readServedTokenSnapshot(page);
  const computedTokens = await readComputedTokenSnapshot(page);
  const gitSha = runLocalCommand("git", ["rev-parse", "HEAD"]);
  const gitStatus = runLocalCommand("git", ["status", "--short"]);

  const mismatches = SHELL_TOKEN_KEYS.filter(
    (key) =>
      normalizeTokenValue(sourceTokens[key]) !== normalizeTokenValue(servedTokens[key])
  );

  const frontendPort = (() => {
    try {
      return String(new URL(BASE_URL).port || (BASE_URL.startsWith("https:") ? "443" : "80"));
    } catch {
      return "3000";
    }
  })();
  return {
    baseUrl: BASE_URL,
    sourceTokens,
    servedTokens,
    computedTokens,
    mismatches,
    localProcesses: {
      frontend: readLocalProcessFingerprint(frontendPort),
      backend: readLocalProcessFingerprint(8000),
    },
    git: {
      sha: gitSha || null,
      dirty: Boolean(gitStatus),
      statusPreview: gitStatus ? gitStatus.split("\n").slice(0, 20) : [],
    },
  };
}

async function installPasskeyBypass(page) {
  await page.addInitScript(() => {
    if (!navigator.credentials?.get) return;
    const originalGet = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (...args) => {
      const [options] = args;
      if (options && typeof options === "object" && "publicKey" in options) {
        throw new DOMException("Playwright audit bypassed passkey prompt", "NotAllowedError");
      }
      return originalGet(...args);
    };
  });
}

async function gotoStable(page, routePath) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(`${BASE_URL}${routePath}`, { waitUntil: "domcontentloaded" });
      return;
    } catch (error) {
      lastError = error;
      if (!/ERR_ABORTED/i.test(String(error))) {
        throw error;
      }
      await page.waitForTimeout(800);
    }
  }

  throw lastError || new Error(`Failed to navigate to ${routePath}`);
}

async function waitForReviewModeConfig(page) {
  const response = await page
    .waitForResponse(
      (candidate) =>
        candidate.url().includes("/api/app-config/review-mode") &&
        candidate.request().method() === "GET",
      { timeout: 20000 }
    )
    .catch(() => null);

  if (!response) return null;
  if (!response.ok()) {
    throw new Error(`Review mode config request failed with HTTP ${response.status()}`);
  }
  return await response.json().catch(() => null);
}

async function ensureReviewerSession(page, redirectPath = "/kai") {
  await gotoStable(page, `/login?redirect=${encodeURIComponent(redirectPath)}`);

  if (!new URL(page.url()).pathname.startsWith("/login")) {
    return { bootstrap: "already_authenticated" };
  }

  const reviewConfig = await waitForReviewModeConfig(page);
  if (!new URL(page.url()).pathname.startsWith("/login")) {
    return { bootstrap: "already_authenticated" };
  }

  const reviewer = page.getByRole("button", { name: /continue as reviewer/i });
  const reviewerVisible = await reviewer.isVisible().catch(() => false);
  if (reviewConfig?.enabled === false && !reviewerVisible) {
    throw new Error("Review mode is unavailable for the runtime audit session.");
  }

  await reviewer.waitFor({ state: "visible", timeout: 15000 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sessionResponsePromise = page
      .waitForResponse(
        (candidate) =>
          candidate.url().includes("/api/app-config/review-mode/session") &&
          candidate.request().method() === "POST",
        { timeout: 10000 }
      )
      .catch(() => null);

    await reviewer.click({ force: true }).catch(() => undefined);
    const sessionResponse = await sessionResponsePromise;
    if (sessionResponse && !sessionResponse.ok()) {
      throw new Error(
        `Reviewer session bootstrap failed with HTTP ${sessionResponse.status()}`
      );
    }

    const transitioned = await page
      .waitForFunction(() => !window.location.pathname.startsWith("/login"), null, {
        timeout: 15000,
      })
      .then(() => true)
      .catch(() => false);
    if (transitioned) {
      await page.waitForTimeout(1200);
      return { bootstrap: "reviewer_login" };
    }
  }

  throw new Error(`Reviewer login did not transition off /login. Final URL: ${page.url()}`);
}

async function snapshotUnlockState(page) {
  return await page.evaluate(() => {
    const selectors = ['[role="dialog"]', "#unlock-passphrase", "button", "input"];
    const textPreview = Array.from(document.querySelectorAll("button, [role='dialog']"))
      .map((node) => (node.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 16);

    return {
      pathname: window.location.pathname + window.location.search,
      visibleSelectors: selectors.filter((selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }),
      textPreview,
    };
  });
}

async function unlockIfNeeded(page) {
  if (!PASS) {
    throw new Error("KAI_TEST_PASSPHRASE missing for vault unlock");
  }

  const unlockDialog = page.getByRole("dialog", { name: /unlock vault/i });
  const inlineUnlockButton = page.getByRole("button", { name: /^unlock vault$/i }).first();
  const lockedBadge = page.getByText(/vault locked/i).first();
  const passphraseField = page.locator("#unlock-passphrase");
  const unlockButton = page.getByRole("button", { name: /unlock with passphrase/i });
  const passphraseFallback = page.getByRole("button", { name: /use passphrase/i });
  const retryVaultCheck = page.getByRole("button", { name: /try again/i }).first();
  const checkingVault = page.getByText(/checking vault|opening your vault/i).first();
  const mainContent = page.locator("main").first();

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await checkingVault.isVisible().catch(() => false)) {
      await page.waitForTimeout(2000);
      continue;
    }

    const dialogVisible = await unlockDialog.isVisible().catch(() => false);
    const fieldVisible = await passphraseField.isVisible().catch(() => false);
    const fallbackVisible = await passphraseFallback.isVisible().catch(() => false);
    const mainVisible = await mainContent.isVisible().catch(() => false);
    const unlockButtonVisible = await unlockButton.isVisible().catch(() => false);
    const inlineUnlockVisible = await inlineUnlockButton.isVisible().catch(() => false);
    const lockedBadgeVisible = await lockedBadge.isVisible().catch(() => false);
    const retryVisible = await retryVaultCheck.isVisible().catch(() => false);

    if ((inlineUnlockVisible || lockedBadgeVisible) && !fieldVisible) {
      if (inlineUnlockVisible) {
        await inlineUnlockButton.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(700);
        continue;
      }
    }

    if (retryVisible) {
      await retryVaultCheck.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(900);
      continue;
    }

    if (!dialogVisible && !fieldVisible && !fallbackVisible && mainVisible) {
      return { state: "already_unlocked" };
    }

    if (!fieldVisible && fallbackVisible) {
      await passphraseFallback.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(600);
      continue;
    }

    if (!fieldVisible && unlockButtonVisible) {
      await unlockButton.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(600);
      continue;
    }

    if (dialogVisible && !fieldVisible && !fallbackVisible && !unlockButtonVisible) {
      await page.waitForTimeout(1500);
      continue;
    }

    if (fieldVisible) {
      await passphraseField.fill(PASS);
      if (unlockButtonVisible) {
        await unlockButton.waitFor({ state: "visible", timeout: 10000 });
        await unlockButton.click();
      } else {
        await passphraseField.press("Enter").catch(() => undefined);
      }
      await page.waitForTimeout(1500);

      if (
        !(await unlockDialog.isVisible().catch(() => false)) &&
        !(await passphraseField.isVisible().catch(() => false))
      ) {
        return { state: "unlocked_with_passphrase" };
      }
    }

    await page.waitForTimeout(700);
  }

  const snapshot = await snapshotUnlockState(page);
  const hasUnlockChrome =
    snapshot.visibleSelectors.includes('[role="dialog"]') ||
    snapshot.visibleSelectors.includes("#unlock-passphrase");
  if (!hasUnlockChrome) {
    return { state: "no_unlock_ui_detected" };
  }
  throw new Error(`Vault unlock did not complete. Snapshot: ${JSON.stringify(snapshot)}`);
}

async function resolveInvestorOnboardingIfNeeded(page) {
  const onboardingHeading = page.getByRole("heading", {
    name: /how long do you expect to keep this money invested/i,
  });
  const onboardingProgress = page.getByText(/step 1 of 3|step 2 of 3|step 3 of 3/i).first();
  const skipButton = page.getByRole("button", { name: /^skip$/i }).first();
  const nextButton = page.getByRole("button", { name: /^next$/i }).first();
  const continueButton = page.getByRole("button", { name: /^continue$/i }).first();
  const openPortfolioButton = page.getByRole("button", { name: /open portfolio/i }).first();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const onOnboardingRoute = /\/kai\/onboarding(?:[/?#]|$)/i.test(page.url());
    const headingVisible = await onboardingHeading.isVisible().catch(() => false);
    const progressVisible = await onboardingProgress.isVisible().catch(() => false);
    const skipVisible = await skipButton.isVisible().catch(() => false);
    if (!onOnboardingRoute && !headingVisible && !progressVisible && !skipVisible) {
      return { resolved: false };
    }

    if (await openPortfolioButton.isVisible().catch(() => false)) {
      await openPortfolioButton.click({ force: true }).catch(() => undefined);
      await page.waitForFunction(
        () => !/\/kai\/onboarding(?:[/?#]|$)/i.test(window.location.pathname),
        undefined,
        { timeout: 15000 }
      ).catch(() => undefined);
      await page.waitForTimeout(1200).catch(() => undefined);
      await unlockIfNeeded(page);
      continue;
    }

    const promptText = (
      (await page
        .locator("main [role='heading'], main h1, main h2")
        .first()
        .textContent()
        .catch(() => "")) || ""
    ).trim();

    const optionMatchers = [
      {
        prompt: /how long do you expect to keep this money invested/i,
        option: /3.?7 years/i,
      },
      {
        prompt: /if your portfolio drops 20%/i,
        option: /stay invested and review the situation/i,
      },
      {
        prompt: /which feels more comfortable/i,
        option: /moderate ups and downs for better returns/i,
      },
    ];
    const optionMatch = optionMatchers.find((entry) => entry.prompt.test(promptText));
    if (optionMatch) {
      const option = page.getByRole("radio", { name: optionMatch.option }).first();
      if (await option.isVisible().catch(() => false)) {
        await option.click({ force: true }).catch(() => undefined);
        await page.waitForTimeout(500).catch(() => undefined);
      }
    }

    if (await nextButton.isVisible().catch(() => false)) {
      await nextButton.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1200).catch(() => undefined);
      continue;
    }

    if (await continueButton.isVisible().catch(() => false)) {
      await continueButton.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1500).catch(() => undefined);
      continue;
    }

    if (skipVisible) {
      await skipButton.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1500).catch(() => undefined);
      continue;
    }

    await page.waitForTimeout(800);
  }

  return { resolved: true };
}

async function seedKaiOnboardingResolved(page, userId = REVIEWER_UID) {
  if (!userId) return { seeded: false };

  const now = new Date().toISOString();
  await page.evaluate(
    ({ uid, completedAt }) => {
      const onboardingState = {
        version: 1,
        completed: true,
        skipped: true,
        completed_at: completedAt,
        answers: {
          investment_horizon: "medium_term",
          drawdown_response: "stay",
          volatility_preference: "moderate",
        },
        risk_score: 3,
        risk_profile: "balanced",
        synced_to_vault_at: null,
        updated_at: completedAt,
      };

      window.localStorage.setItem(
        `kai_pre_vault_onboarding_v1:fallback:${uid}`,
        JSON.stringify(onboardingState)
      );
      window.sessionStorage.setItem(`kai_onboarding_complete:${uid}`, "1");
      document.cookie = "kai_onboarding_required=0; path=/; SameSite=Lax; max-age=2592000";
      document.cookie = "kai_onboarding_flow_active=0; path=/; SameSite=Lax; max-age=2592000";
    },
    { uid: userId, completedAt: now }
  );

  return { seeded: true, userId };
}

async function waitForRouteSurface(page) {
  const anchor = page.locator('[data-top-content-anchor="true"]').first();
  const blockingLoaders = [
    page.getByText(/loading kai/i).first(),
    page.getByText(/loading onboarding/i).first(),
    page.getByText(/loading marketplace/i).first(),
    page.getByText(/checking vault|opening your vault/i).first(),
  ];

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await unlockIfNeeded(page);
    await resolveInvestorOnboardingIfNeeded(page);

    if (await anchor.isVisible().catch(() => false)) {
      return;
    }

    const anyLoaderVisible = await Promise.all(
      blockingLoaders.map((locator) => locator.isVisible().catch(() => false))
    );
    if (anyLoaderVisible.some(Boolean)) {
      await page.waitForTimeout(1000);
      continue;
    }

    const mainVisible = await page.locator("main").first().isVisible().catch(() => false);
    if (mainVisible) {
      return;
    }

    await page.waitForTimeout(700);
  }
}

async function ensurePersona(page, persona) {
  const targetRoute = persona === "ria" ? "/ria" : "/kai";
  const chooserHeading = page.getByRole("heading", {
    name: /start as an investor or set up ria first/i,
  });
  const chooserButton =
    persona === "ria"
      ? page.getByRole("button", { name: /^ria\b/i }).first()
      : page.getByRole("button", { name: /^investor\b/i }).first();
  const personaMatches = (currentLabel) => {
    if (persona === "ria") {
      return currentLabel.includes("ria");
    }

    const pathname = (() => {
      try {
        return new URL(page.url()).pathname;
      } catch {
        return "";
      }
    })();
    const investorOnKaiShell =
      /^\/kai(?:\/|$)/i.test(pathname) && !/\/kai\/onboarding(?:\/|$)/i.test(pathname);
    return currentLabel.includes("investor") || investorOnKaiShell;
  };

  if (await chooserHeading.isVisible().catch(() => false)) {
    await chooserButton.click();
    await page.waitForTimeout(1500);
    await unlockIfNeeded(page);
    await resolveInvestorOnboardingIfNeeded(page);
  }

  await resolveInvestorOnboardingIfNeeded(page);

  let label = page.locator('[data-testid="top-app-bar-title"]').first();
  const initialLabelVisible = await label.isVisible().catch(() => false);
  if (!initialLabelVisible) {
    await gotoStable(page, targetRoute);
    if (await chooserHeading.isVisible().catch(() => false)) {
      await chooserButton.click();
      await page.waitForTimeout(1500);
      await unlockIfNeeded(page);
      await resolveInvestorOnboardingIfNeeded(page);
    }
    await waitForRouteSurface(page);
    await page.waitForTimeout(600);
  }
  label = page.locator('[data-testid="top-app-bar-title"]').first();
  await label.waitFor({ state: "visible", timeout: 15000 });
  let current = ((await label.textContent()) || "").trim().toLowerCase();
  const onboardingShellVisible =
    current.includes("get started") ||
    (await page
      .getByRole("heading", { name: /how long do you expect to keep this money invested/i })
      .isVisible()
      .catch(() => false)) ||
    (await page.getByRole("button", { name: /^skip$/i }).first().isVisible().catch(() => false));

  if (onboardingShellVisible) {
    await resolveInvestorOnboardingIfNeeded(page);
    await gotoStable(page, targetRoute);
    await page.waitForTimeout(1200);
    await unlockIfNeeded(page);
    await waitForRouteSurface(page);
    label = page.locator('[data-testid="top-app-bar-title"]').first();
    await label.waitFor({ state: "visible", timeout: 15000 });
    current = ((await label.textContent()) || "").trim().toLowerCase();
  }

  if (personaMatches(current)) {
    return { persona, switched: false };
  }

  await gotoStable(page, targetRoute);
  await page.waitForTimeout(1000);
  await unlockIfNeeded(page);
  await resolveInvestorOnboardingIfNeeded(page);
  await page.waitForTimeout(600);

  label = page.locator('[data-testid="top-app-bar-title"]').first();
  await label.waitFor({ state: "visible", timeout: 15000 });
  current = ((await label.textContent()) || "").trim().toLowerCase();

  if (personaMatches(current)) {
    return { persona, switched: false };
  }

  await label.click();
  const menuLabel = persona === "ria" ? /^ria$|set up ria/i : /^investor$/i;
  const option = page.getByRole("menuitem", { name: menuLabel }).first();
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click();
  await page.waitForTimeout(1200);
  await label.waitFor({ state: "visible", timeout: 15000 });

  return { persona, switched: true };
}

function inferScenarioPersona(route) {
  if (route.startsWith("/ria")) return "ria";
  return "investor";
}

async function discoverWorkspaceRoute(page) {
  try {
    await ensurePersona(page, "ria");
    await gotoStable(page, "/ria/clients");
    await page.waitForTimeout(1200);
    await unlockIfNeeded(page);
    await page.waitForTimeout(800);

    const connectedSection = page.locator('[data-testid="ria-clients-connected"]');
    if (!(await connectedSection.isVisible().catch(() => false))) {
      return null;
    }

    const candidateRow = connectedSection.getByRole("button").first();
    if ((await candidateRow.count()) === 0) {
      return null;
    }

    await candidateRow.click();
    const workspaceLink = page.getByRole("link", { name: /open workspace/i }).first();
    if (!(await workspaceLink.isVisible().catch(() => false))) {
      return null;
    }

    return await workspaceLink.getAttribute("href");
  } catch (error) {
    console.warn("[runtime-audit] Workspace discovery skipped:", error);
    return null;
  }
}

async function discoverMarketplaceProfileRoute(page) {
  try {
    await ensurePersona(page, "investor");
    await gotoStable(page, "/marketplace");
    await page.waitForTimeout(1200);
    await unlockIfNeeded(page);
    await page.waitForTimeout(800);

    const profileLink = page.locator('a[href^="/marketplace/ria?riaId="]').first();
    if (!(await profileLink.isVisible().catch(() => false))) {
      return null;
    }

    return await profileLink.getAttribute("href");
  } catch (error) {
    console.warn("[runtime-audit] Marketplace RIA discovery skipped:", error);
    return null;
  }
}

async function resolveScenarioPath(page, scenario) {
  if (scenario.route === "/ria/workspace") {
    return await discoverWorkspaceRoute(page);
  }
  if (scenario.route === "/marketplace/ria") {
    return await discoverMarketplaceProfileRoute(page);
  }
  return scenario.route;
}

function buildAuditScenarios() {
  const scenarios = [];

  for (const entry of ROUTE_LAYOUT_CONTRACT) {
    if (entry.mode === "hidden") continue;
    scenarios.push({
      route: entry.route,
      slug: slugify(entry.route),
      mode: entry.mode,
      persona: inferScenarioPersona(entry.route),
    });
  }

  for (const sharedRoute of ["/consents", "/marketplace", "/profile"]) {
    scenarios.push({
      route: sharedRoute,
      slug: `${slugify(sharedRoute)}-ria`,
      mode: "standard",
      persona: "ria",
    });
  }

  scenarios.push({
    route: "/consents?actor=ria&view=outgoing&tab=pending",
    slug: "ria-consent-manager",
    mode: "standard",
    persona: "ria",
  });

  return scenarios;
}

function attachRuntimeAudit(page) {
  const requests = [];
  const failedRequests = [];
  const httpFailures = [];
  const consoleMessages = [];
  const pageErrors = [];
  const resourceEvents = [];
  const pendingParses = [];

  const requestListener = (request) => {
    try {
      const url = new URL(request.url());
      if (url.origin !== BASE_ORIGIN) return;
      requests.push({
        method: request.method(),
        pathname: url.pathname,
        url: `${url.pathname}${url.search}`,
        requestId: request.headers()["x-request-id"] || null,
      });
    } catch {
      // ignore malformed URLs
    }
  };

  const requestFailedListener = (request) => {
    try {
      const url = new URL(request.url());
      if (url.origin !== BASE_ORIGIN) return;
      failedRequests.push({
        method: request.method(),
        pathname: url.pathname,
        url: `${url.pathname}${url.search}`,
        failure: request.failure()?.errorText || "request_failed",
        requestId: request.headers()["x-request-id"] || null,
      });
    } catch {
      // ignore malformed URLs
    }
  };

  const responseListener = (response) => {
    const parsePromise = (async () => {
      try {
        const url = new URL(response.url());
        if (url.origin !== BASE_ORIGIN) return;
        if (response.status() >= 400) {
          httpFailures.push({
            method: response.request().method(),
            pathname: url.pathname,
            url: `${url.pathname}${url.search}`,
            status: response.status(),
            requestId: response.request().headers()["x-request-id"] || response.headers()["x-request-id"] || null,
          });
        }
      } catch {
        // ignore malformed URLs
      }
    })();
    pendingParses.push(parsePromise);
  };

  const consoleListener = (message) => {
    const text = message.text();
    const entry = {
      type: message.type(),
      text,
      location: message.location(),
    };
    consoleMessages.push(entry);

    if (!text.startsWith("[RequestAudit:")) {
      return;
    }

    const parsePromise = (async () => {
      const match = text.match(/^\[RequestAudit:([^\]]+)\]\s+([a-z_]+)/i);
      if (!match) return;
      let detail = null;
      const args = message.args();
      if (args.length > 1) {
        detail = await args[1].jsonValue().catch(() => null);
      }
      resourceEvents.push({
        label: match[1],
        stage: match[2],
        detail,
      });
    })();
    pendingParses.push(parsePromise);
  };

  const pageErrorListener = (error) => {
    pageErrors.push({
      name: error?.name || "Error",
      message: error?.message || String(error),
    });
  };

  page.on("request", requestListener);
  page.on("requestfailed", requestFailedListener);
  page.on("response", responseListener);
  page.on("console", consoleListener);
  page.on("pageerror", pageErrorListener);

  return {
    async drain() {
      await Promise.allSettled(pendingParses);
      page.off("request", requestListener);
      page.off("requestfailed", requestFailedListener);
      page.off("response", responseListener);
      page.off("console", consoleListener);
      page.off("pageerror", pageErrorListener);
      return {
        requests,
        failedRequests,
        httpFailures,
        consoleMessages,
        pageErrors,
        resourceEvents,
      };
    },
  };
}

function summarizeRequests(records) {
  const grouped = new Map();

  for (const record of records) {
    const key = `${record.method} ${record.pathname}`;
    const next = grouped.get(key) || { count: 0, requestIds: new Set(), urls: new Set() };
    next.count += 1;
    if (record.requestId) next.requestIds.add(record.requestId);
    next.urls.add(record.url);
    grouped.set(key, next);
  }

  return Array.from(grouped.entries())
    .map(([key, value]) => ({
      key,
      count: value.count,
      requestIds: Array.from(value.requestIds),
      urls: Array.from(value.urls),
    }))
    .sort((left, right) => right.count - left.count);
}

function summarizeResourceEvents(events) {
  const grouped = new Map();

  for (const event of events) {
    const cacheKey =
      typeof event.detail?.cacheKey === "string"
        ? event.detail.cacheKey
        : typeof event.detail?.userId === "string"
          ? `${event.label}:${event.detail.userId}`
          : event.label;
    const key = `${event.label}:${cacheKey}`;
    const next = grouped.get(key) || {
      key,
      label: event.label,
      resourceKey: cacheKey,
      total: 0,
      stages: {},
      firstSignal: null,
    };
    next.total += 1;
    next.stages[event.stage] = (next.stages[event.stage] || 0) + 1;
    if (
      !next.firstSignal &&
      ["cache_hit", "stale_hit", "device_hit", "revision_match_hit", "cache_miss", "network_fetch"].includes(event.stage)
    ) {
      next.firstSignal = {
        stage: event.stage,
        detail: event.detail,
      };
    }
    grouped.set(key, next);
  }

  return Array.from(grouped.values()).sort((left, right) => right.total - left.total);
}

async function collectShellMetrics(page) {
  return await page.evaluate((tokenKeys) => {
    const root = getComputedStyle(document.documentElement);
    const shellRoot = document.querySelector('[data-app-shell-root="true"]');
    const shellStyles = shellRoot ? getComputedStyle(shellRoot) : null;
    const row = document.querySelector('[data-testid="top-app-bar-row"]');
    const title = document.querySelector('[data-testid="top-app-bar-title"]');
    const actions = document.querySelector('[data-testid="top-app-bar-actions"]');
    const spacer = document.querySelector('[data-app-shell-top-spacer="true"]');

    const readTokens = (styles) =>
      tokenKeys.reduce((acc, key) => {
        acc[key] = styles ? styles.getPropertyValue(key).trim() : "";
        return acc;
      }, {});

    const candidates = Array.from(
      document.querySelectorAll(
        '[data-page-primary="true"], [data-testid="page-primary-module"], [data-testid$="-primary"], [data-slot="page-header"], h1, h2, section, article, .surface-card, .surface-stack > *'
      )
    );

    const firstMeaningful = candidates.find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      const styles = getComputedStyle(node);
      return (
        rect.width > 24 &&
        rect.height > 12 &&
        styles.display !== "none" &&
        styles.visibility !== "hidden" &&
        styles.opacity !== "0"
      );
    });

    const rowRect = row?.getBoundingClientRect?.() || null;
    const titleRect = title?.getBoundingClientRect?.() || null;
    const actionsRect = actions?.getBoundingClientRect?.() || null;
    const spacerRect = spacer?.getBoundingClientRect?.() || null;
    const firstRect = firstMeaningful?.getBoundingClientRect?.() || null;

    return {
      tokens: {
        root: readTokens(root),
        shellRoot: readTokens(shellStyles),
      },
      rowBox: rowRect,
      titleBox: titleRect,
      actionsBox: actionsRect,
      spacerHeight: spacerRect ? spacerRect.height : 0,
      firstMeaningfulTop: firstRect ? firstRect.top : 0,
      firstMeaningfulTestId: firstMeaningful?.getAttribute?.("data-testid") || null,
      firstMeaningfulTag: firstMeaningful?.tagName?.toLowerCase?.() || null,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  }, SHELL_TOKEN_KEYS);
}

async function captureScreens(page, outDir, slug) {
  const screenshots = [];
  const positions = [
    { label: "top", ratio: 0 },
    { label: "mid", ratio: 0.5 },
    { label: "bottom", ratio: 1 },
  ];

  fs.mkdirSync(outDir, { recursive: true });

  for (const position of positions) {
    await page.evaluate((ratio) => {
      const maxScroll = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight
      );
      window.scrollTo({
        top: Math.floor(maxScroll * ratio),
        behavior: "auto",
      });
    }, position.ratio);
    await page.waitForTimeout(250);

    const filePath = path.join(outDir, `${slug}-${position.label}.png`);
    await page.screenshot({
      path: filePath,
      fullPage: false,
      animations: "disabled",
    });
    screenshots.push({
      label: position.label,
      filePath,
    });
  }

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  return screenshots;
}

module.exports = {
  BASE_URL,
  BASE_ORIGIN,
  PASS,
  ROUTE_LAYOUT_CONTRACT,
  SHELL_TOKEN_KEYS,
  attachRuntimeAudit,
  buildAuditScenarios,
  buildRuntimeFingerprint,
  captureScreens,
  collectShellMetrics,
  ensurePersona,
  ensureReviewerSession,
  gotoStable,
  installPasskeyBypass,
  normalizeTokenValue,
  seedKaiOnboardingResolved,
  resolveScenarioPath,
  slugify,
  summarizeRequests,
  summarizeResourceEvents,
  unlockIfNeeded,
  waitForRouteSurface,
};

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  createReviewerSessionHarness,
  decryptAesGcm,
} from "../../reviewer-app-testing/scripts/reviewer-session-harness.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../..");

const appOrigin = String(
  process.env.PKM_REVIEWER_REHEARSAL_ORIGIN || "https://uat.one.hushh.ai"
).replace(/\/$/, "");
const allowMutation = process.env.PKM_REVIEWER_REHEARSAL_ALLOW_MUTATION === "1";
const naturalPrompt =
  process.env.PKM_REVIEWER_REHEARSAL_PROMPT ||
  "Remember that I prefer index funds for long-term investing.";
const tmpRoot = path.resolve(repoRoot, "tmp");
const encryptedOutput = path.resolve(
  process.env.PKM_REVIEWER_ENCRYPTED_OUTPUT ||
    path.join(repoRoot, "tmp/reviewer-pkm-encrypted-payload.json")
);
const decryptedOutput = path.resolve(
  process.env.PKM_REVIEWER_DECRYPTED_OUTPUT ||
    path.join(repoRoot, "tmp/reviewer-pkm-decrypted-payload.json")
);
const timeoutMs = Number(process.env.PKM_REVIEWER_REHEARSAL_TIMEOUT_MS || 360_000);

function assertPrivateOutputPath(filePath, label) {
  const relative = path.relative(tmpRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the repository tmp directory.`);
  }
}

assertPrivateOutputPath(encryptedOutput, "Encrypted reviewer output");
assertPrivateOutputPath(decryptedOutput, "Decrypted reviewer output");

if (process.argv.includes("--help")) {
  process.stdout.write(
    [
      "Reviewer PKM app rehearsal (mutates the canonical reviewer account).",
      "",
      "Required gate:",
      "  PKM_REVIEWER_REHEARSAL_ALLOW_MUTATION=1",
      "",
      "Optional:",
      "  PKM_REVIEWER_REHEARSAL_ORIGIN=https://uat.one.hushh.ai",
      "  PKM_REVIEWER_REHEARSAL_PROMPT='Remember that ...'",
      "  PKM_REVIEWER_ENCRYPTED_OUTPUT=tmp/reviewer-pkm-encrypted-payload.json",
      "  PKM_REVIEWER_DECRYPTED_OUTPUT=tmp/reviewer-pkm-decrypted-payload.json",
      "",
    ].join("\n")
  );
  process.exit(0);
}

if (!allowMutation) {
  throw new Error(
    "Refusing reviewer-account mutation. Set PKM_REVIEWER_REHEARSAL_ALLOW_MUTATION=1."
  );
}
if (encryptedOutput === decryptedOutput) {
  throw new Error("Encrypted and decrypted output paths must be different.");
}

const reviewer = await createReviewerSessionHarness({ repoRoot, appOrigin, timeoutMs });
const {
  assertVaultContinuity,
  chromium,
  deriveVaultKey,
  endpointPath,
  fetchOwnerJson,
  navigateInApp,
  openSession: openReviewerSession,
  reviewerUid,
} = reviewer;

function encryptedBlobFromPayload(payload) {
  const blob = payload?.encrypted_blob || payload?.encryptedBlob;
  if (!blob || typeof blob !== "object") {
    throw new Error("PKM encrypted response has no encrypted_blob.");
  }
  return blob;
}

function decryptDomainPayload(payload, domain, vaultKey) {
  const blob = encryptedBlobFromPayload(payload);
  const segments = blob.segments && typeof blob.segments === "object" ? blob.segments : {};
  if (Object.keys(segments).length === 0) {
    const decoded = JSON.parse(
      decryptAesGcm(
        { ciphertext: blob.ciphertext, iv: blob.iv, tag: blob.tag },
        vaultKey
      ).toString("utf8")
    );
    if (payload.storage_mode === "legacy_full_blob" && decoded?.[domain]) {
      return decoded[domain];
    }
    return decoded;
  }

  const domainData = {};
  for (const [segmentId, encryptedSegment] of Object.entries(segments)) {
    const parsed = JSON.parse(
      decryptAesGcm(
        {
          ciphertext: encryptedSegment.ciphertext,
          iv: encryptedSegment.iv,
          tag: encryptedSegment.tag,
        },
        vaultKey
      ).toString("utf8")
    );
    if (segmentId === "root" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.assign(domainData, parsed);
    } else {
      domainData[segmentId] = parsed;
    }
  }
  return domainData;
}

async function fetchExactFinancialPayload(ownerToken) {
  const encodedUid = encodeURIComponent(reviewerUid);
  const snapshot = await fetchOwnerJson(
    `/api/pkm/domain-snapshot/${encodedUid}/financial`,
    ownerToken,
    { allow404: true }
  );
  if (snapshot) return snapshot;
  return fetchOwnerJson(`/api/pkm/domain-data/${encodedUid}/financial`, ownerToken);
}

function assertFinancialScopes(scopePayload) {
  const scopes = Array.isArray(scopePayload?.scopes) ? scopePayload.scopes : [];
  const requiredScope = "attr.financial.*";
  if (!scopes.includes(requiredScope)) {
    throw new Error(`Generated scope ${requiredScope} is missing.`);
  }
  const entries = Array.isArray(scopePayload?.scope_entries) ? scopePayload.scope_entries : [];
  const entry = entries.find((candidate) => candidate?.scope === requiredScope);
  if (!entry) throw new Error(`Generated scope entry ${requiredScope} is missing.`);
  if (entry.scope_origin !== "dynamic" || entry.scope_origin_code !== "d") {
    throw new Error(`Generated scope ${requiredScope} is not marked dynamic/d.`);
  }
  const originSource = entry.scope_origin_source_kind || entry.source_kind;
  if (originSource !== "manifest_branch") {
    throw new Error(`Generated scope ${requiredScope} has invalid origin source.`);
  }
  return scopes;
}

function waitForFinancialStore(page) {
  return page.waitForResponse(
    (response) => {
      if (endpointPath(response.url()) !== "/api/pkm/store-domain") return false;
      if (response.request().method() !== "POST") return false;
      try {
        return JSON.parse(response.request().postData() || "{}").domain === "financial";
      } catch {
        return false;
      }
    },
    { timeout: timeoutMs }
  );
}

async function boundedResponseError(response) {
  const raw = await response.text().catch(() => "");
  if (!raw) return "no response detail";
  try {
    const payload = JSON.parse(raw);
    const detail = payload?.detail?.code || payload?.detail || payload?.code || payload?.error;
    const normalized =
      typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : "unknown error";
    return normalized.replaceAll(reviewerUid, "[reviewer]").slice(0, 500);
  } catch {
    return raw.replaceAll(reviewerUid, "[reviewer]").replace(/\s+/g, " ").slice(0, 500);
  }
}

async function loadSampleBrokerage(page) {
  await navigateInApp(page, "/one/kai/import");
  const loadButton = page.getByRole("button", { name: /^Load Sample Brokerage$/i });
  await loadButton.waitFor({ state: "visible", timeout: timeoutMs });
  await loadButton.click();
  await page.getByRole("heading", { name: /review portfolio/i }).waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  const holdingsLabel = page.getByText(/Holdings\s*\(\d+\)/i).first();
  await holdingsLabel.waitFor({ state: "visible", timeout: timeoutMs });
  const holdingsText = (await holdingsLabel.textContent()) || "";
  const holdingsCount = Number(holdingsText.match(/Holdings\s*\((\d+)\)/i)?.[1] || 0);
  if (!Number.isFinite(holdingsCount) || holdingsCount <= 0) {
    throw new Error("Sample brokerage produced no holdings.");
  }

  const storeResponsePromise = waitForFinancialStore(page);
  await page.getByRole("button", { name: /^Save to Vault$/i }).click();
  const storeResponse = await storeResponsePromise;
  if (!storeResponse.ok()) {
    throw new Error(
      `Sample brokerage PKM save failed with HTTP ${storeResponse.status()}: ${await boundedResponseError(storeResponse)}`
    );
  }
  return holdingsCount;
}

function proposalDomain(payload) {
  const cards = Array.isArray(payload?.preview_cards) ? payload.preview_cards : [];
  const card = cards.find((candidate) => {
    const domain =
      candidate?.manifest_draft?.domain ||
      candidate?.structure_decision?.target_domain ||
      candidate?.target_domain;
    return domain === "financial";
  });
  return card ? "financial" : "";
}

async function saveNaturalFinancialMemory(page) {
  await navigateInApp(page, "/agent");
  const composer = page.getByRole("textbox", { name: "Message One" });
  await composer.waitFor({ state: "visible", timeout: timeoutMs });

  const proposalPromise = page.waitForResponse(
    (response) =>
      endpointPath(response.url()) === "/api/pkm/memory/proposals" &&
      response.request().method() === "POST",
    { timeout: timeoutMs }
  );
  await composer.fill(naturalPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  const proposalResponse = await proposalPromise;
  if (!proposalResponse.ok()) {
    throw new Error(`Natural PKM proposal failed with HTTP ${proposalResponse.status()}.`);
  }
  const proposal = await proposalResponse.json();
  if (proposalDomain(proposal) !== "financial") {
    throw new Error("Natural prompt was not structured into the financial domain.");
  }

  const reviewTitle = page.getByText("Save to PKM?", { exact: true });
  await reviewTitle.waitFor({ state: "visible", timeout: timeoutMs });
  const reviewPanel = reviewTitle.locator(
    "xpath=ancestor::div[.//button[normalize-space()='Save']][1]"
  );
  const storeResponsePromise = waitForFinancialStore(page);
  await reviewPanel.getByRole("button", { name: /^Save$/i }).click();
  const storeResponse = await storeResponsePromise;
  if (!storeResponse.ok()) {
    throw new Error(
      `Natural PKM save failed with HTTP ${storeResponse.status()}: ${await boundedResponseError(storeResponse)}`
    );
  }
  await page.getByText(/Saved \d+ PKM memor/i).waitFor({ state: "visible", timeout: timeoutMs });
}

function writePrivateJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const realTmpRoot = fs.realpathSync(tmpRoot);
  const realParent = fs.realpathSync(path.dirname(filePath));
  const relativeParent = path.relative(realTmpRoot, realParent);
  if (relativeParent.startsWith("..") || path.isAbsolute(relativeParent)) {
    throw new Error("Reviewer payload output resolved outside the repository tmp directory.");
  }
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

const browser = await chromium.launch({ headless: process.env.PLAYWRIGHT_HEADLESS !== "0" });
let firstSession;
let freshSession;
let firstVaultKey;
let freshVaultKey;
try {
  firstSession = await openReviewerSession(browser, "/one/kai/import");
  const firstVaultState = await firstSession.capture.vaultState();
  firstVaultKey = deriveVaultKey(firstVaultState);

  const holdingsCount = await loadSampleBrokerage(firstSession.page);
  const firstOwnerToken = await firstSession.capture.ownerToken();
  const scopesAfterBrokerage = await fetchOwnerJson(
    `/api/pkm/scopes/${encodeURIComponent(reviewerUid)}`,
    firstOwnerToken
  );
  const canonicalScopes = assertFinancialScopes(scopesAfterBrokerage);

  await saveNaturalFinancialMemory(firstSession.page);
  await assertVaultContinuity(firstSession.page, "natural PKM save");
  const scopesAfterMemory = await fetchOwnerJson(
    `/api/pkm/scopes/${encodeURIComponent(reviewerUid)}`,
    firstOwnerToken
  );
  const updatedScopes = assertFinancialScopes(scopesAfterMemory);
  for (const scope of canonicalScopes) {
    if (!updatedScopes.includes(scope)) throw new Error(`Existing scope disappeared: ${scope}`);
  }

  const firstEncryptedPayload = await fetchExactFinancialPayload(firstOwnerToken);
  const firstDecryptedPayload = decryptDomainPayload(
    firstEncryptedPayload,
    "financial",
    firstVaultKey
  );

  await firstSession.context.close();
  firstSession = null;

  freshSession = await openReviewerSession(browser, "/one/kai/portfolio");
  const freshVaultState = await freshSession.capture.vaultState();
  freshVaultKey = deriveVaultKey(freshVaultState);
  const freshOwnerToken = await freshSession.capture.ownerToken();
  const freshEncryptedPayload = await fetchExactFinancialPayload(freshOwnerToken);
  const freshDecryptedPayload = decryptDomainPayload(
    freshEncryptedPayload,
    "financial",
    freshVaultKey
  );

  if (!isDeepStrictEqual(firstDecryptedPayload, freshDecryptedPayload)) {
    throw new Error("Fresh-session PKM decrypt does not match the write session.");
  }
  if (!isDeepStrictEqual(firstEncryptedPayload, freshEncryptedPayload)) {
    throw new Error("Fresh-session encrypted PKM read does not match the write session.");
  }

  writePrivateJson(encryptedOutput, freshEncryptedPayload);
  writePrivateJson(decryptedOutput, freshDecryptedPayload);
  process.stdout.write(
    `[reviewer-pkm-rehearsal] PASS holdings=${holdingsCount} scopes=${updatedScopes.length} outputs=2\n`
  );
} finally {
  firstVaultKey?.fill(0);
  freshVaultKey?.fill(0);
  await firstSession?.context.close().catch(() => undefined);
  await freshSession?.context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

/**
 * Native UAT evidence collector. It never seeds product state. Use dedicated
 * test accounts and normal provider/app operations before collecting a pair.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { uatCases as cases, escapeHtml as h } from "./feed-visual-journey.mjs";

process.umask(0o077);
const [command, directory, ...args] = process.argv.slice(2);
if (!directory || !["init", "capture", "record", "report"].includes(command)) {
  throw new Error("Usage: verify-feed-uat-evidence.mjs <init|capture|record|report> <private-directory> [arguments]");
}
const root = path.resolve(directory);
const file = path.join(root, "qa-manifest.json");
const safeId = value => typeof value === "string" && /^[\w:-]{1,180}$/.test(value);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && value.endsWith("Z");
const shotPath = (key, kind) => path.join(root, "uat-" + key + "-" + kind + ".png");
function required(condition, context) { if (!condition) throw new Error(context); }
function normalDestination(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  const parsed = new URL(value, doc.origin);
  if (parsed.origin !== doc.origin) return null;
  parsed.searchParams.sort();
  return parsed.pathname + parsed.search + parsed.hash;
}

async function writeManifest(doc) {
  const next = file + ".new";
  await fs.writeFile(next, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(next, file);
}

if (command === "init") {
  const [revision, origin] = args;
  required(/^[\da-f]{40}$/.test(revision || ""), "Provide the deployed, verified 40-character revision.");
  let host;
  try { host = new URL(origin); } catch { throw new Error("Provide the verified HTTPS UAT origin."); }
  required(host.protocol === "https:" && host.href === host.origin + "/" &&
    /(^|[.-])uat([.-]|$)/i.test(host.hostname), "Use a dedicated UAT origin.");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  required(((await fs.stat(root)).mode & 0o077) === 0, "Use a private directory (chmod 700).");
  await fs.writeFile(file, JSON.stringify({
    protocol: 1, origin: host.origin, revision, startedAt: new Date().toISOString(),
    device: "iPhone 15 Pro", captures: {}, checkpoints: {},
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("Initialized private UAT manifest.");
  process.exit(0);
}

required(((await fs.stat(root)).mode & 0o077) === 0 && ((await fs.stat(file)).mode & 0o077) === 0, "UAT evidence and manifest must be private.");
const doc = JSON.parse(await fs.readFile(file, "utf8"));
required(doc.protocol === 1 && doc.device === "iPhone 15 Pro", "Initialize a native UAT manifest first.");

if (command === "capture") {
  const [key, kind, deviceId] = args;
  required(cases.some(item => item.key === key), "Unknown checkpoint.");
  required(kind === "feed" || kind === "detail", "Provide feed or detail.");
  required(/^[\da-f-]{36}$/i.test(deviceId || ""), "Provide the booted iPhone 15 Pro UDID.");
  required(!doc.checkpoints[key], "The recorded checkpoint is immutable; reproduce it in a fresh run.");
  const inventory = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], { encoding: "utf8" }));
  const device = Object.values(inventory.devices).flat().find(item => item.udid === deviceId);
  required(device?.state === "Booted" && device.deviceTypeIdentifier === "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
    "Capture requires a booted iPhone 15 Pro. No browser or copied fixture images are accepted.");
  const target = shotPath(key, kind);
  execFileSync("xcrun", ["simctl", "io", deviceId, "screenshot", "--type=png", target], { stdio: "inherit" });
  const png = await fs.readFile(target);
  required(png.readUInt32BE(16) === 1179 && png.readUInt32BE(20) === 2556, "Use the native portrait viewport.");
  doc.captures[key] ??= {};
  doc.captures[key][kind] = { at: new Date().toISOString(), sha256: digest(png), platform: "native-simulator" };
  await writeManifest(doc);
  process.exit(0);
}

if (command === "record") {
  const checkpoint = JSON.parse(await fs.readFile(args[0], "utf8"));
  const item = cases.find(entry => entry.key === checkpoint.case);
  required(item && item.role === checkpoint.role, "Checkpoint role must match the journey.");
  const { case: key, role, viewer, operationId, sourceId = operationId, feedItemId, state, copy, destination,
    status, reason, proof, occurredAt } = checkpoint;
  required(!doc.checkpoints[key], "Already recorded; preserve this run and start a new one for a repeat.");
  required(/^qa_[\w-]{1,45}$/.test(viewer || ""), "Use a dedicated viewer alias: qa_… (never email).");
  required(["pass", "fail", "unsupported"].includes(status), "Record pass, fail, or unsupported.");
  required(status !== "unsupported" || ["15-statement-correction", "18-transfer-returned", "25-search-transfer"].includes(key),
    "An unmet required checkpoint is a failure, not unsupported.");
  required(status === "pass" || (typeof reason === "string" && reason.trim()), "Record the failure or unsupported reason.");
  required(status === "unsupported" || (safeId(operationId) && safeId(sourceId) && validTime(occurredAt)), "Record exact stable operation/source IDs and UTC time.");
  if (status === "pass") {
    required(typeof state === "string" && state.trim() && typeof copy === "string" &&
      (copy.trim() || key === "38-location-nearby"), "Record authoritative state and actual displayed copy.");
    required(normalDestination(destination) === normalDestination(item.destination.replace("{id}", encodeURIComponent(sourceId)).replace("{feedItemId}", encodeURIComponent(feedItemId || ""))),
      "Tap opened a different destination; record failure and fix before approval.");
    if (["07-payment", "13-search-receipt"].includes(key)) {
      required(proof?.providerMode === "stripe-test", "Record Stripe test-mode provider evidence.");
    }
    if (["21-institution-action", "22-institution-return"].includes(key)) {
      required(proof?.providerMode === "plaid-sandbox", "Record Plaid Sandbox evidence.");
    }
    if (key === "18-transfer-returned") {
      required(proof?.providerMode === "transfer-sandbox", "Record transfer sandbox provider evidence.");
    }
    if (["27-history-refresh", "44-location-history-refresh"].includes(key)) {
      const readback = proof?.readback;
      required(readback?.sessions === 2 && readback.visibleRows === 1 &&
        readback.selectedRowUnreadAfterRefresh === false &&
        Number.isSafeInteger(readback.unreadBefore) && readback.unreadBefore >= 0 &&
        Number.isSafeInteger(readback.unreadAfter) && readback.unreadAfter >= 0 &&
        readback.unreadAfter <= readback.unreadBefore,
      "Record the duplicate and unread check from two sessions.");
    }
    if (key === "41-location-two-emergencies") {
      const readback = proof?.readback;
      required(safeId(feedItemId), "Record the selected incident’s exact Feed receipt ID.");
      required(Array.isArray(readback?.incidentIds) && readback.incidentIds.length === 2 &&
        readback.incidentIds.every(safeId) && new Set(readback.incidentIds).size === 2 &&
        readback.liveRowsAfterClear === 2,
      "Record both distinct confirmed incidents and both Live rows after Clear Feed.");
    }
    if (key === "38-location-nearby") {
      required(proof?.readback?.feedRows === 0 && proof.readback.searchResults === 0,
        "Nearby presence must have no durable Feed or search entry.");
    }
    required(proof && safeId(proof.requestRef) && validTime(proof.at) &&
      typeof proof.source === "string" && proof.source.length > 0 &&
      proof.operationId === operationId && proof.viewer === viewer && proof.state === state,
    "A redacted authority receipt must bind the same operation, viewer and confirmed state.");
    if (item.section === "Location") {
      required(!item.selectorIsOperation || sourceId === operationId,
        "This Location route must select the exact reviewed operation.");
      required(proof.sourceId === sourceId,
        "Location proof must bind the exact source selector opened from Feed.");
      if (item.destination === "/one/feed") {
        required(safeId(proof.openedFeedItemId) &&
          proof.openedFeedGroupId === item.feedGroup?.replace("{operationId}", operationId),
          "Record the exact opened Feed detail ID and its verified operation group.");
      }
      if (key === "41-location-two-emergencies") {
        required(proof.readback.incidentIds.includes(sourceId) && proof.openedFeedItemId === feedItemId &&
          proof.openedFeedGroupId === "location-grant:" + sourceId,
          "The selected incident and Feed receipt must belong to the confirmed pair.");
      }
      if (key === "42-location-incident-ended") {
        const active = doc.checkpoints["41-location-two-emergencies"];
        required(active?.status === "pass" && active.sourceId === sourceId &&
          proof.openedFeedGroupId === "location-grant:" + sourceId &&
          proof.readback?.endedIncidentId === sourceId &&
          proof.readback.liveIncidentIds?.length === 1 &&
          proof.readback.liveIncidentIds[0] !== sourceId &&
          active.proof.readback.incidentIds.includes(proof.readback.liveIncidentIds[0]),
          "End the selected incident; retain the other confirmed incident as Live.");
      }
    }
    const historical = item.section === "Legacy UAT history" || item.family.startsWith("old-");
    if (historical) {
      required(Date.parse(occurredAt) < Date.parse(doc.startedAt), "Use an operation that predates this QA run for older-history evidence.");
      required(Date.parse(proof.at) >= Date.parse(doc.startedAt), "Recheck older-history authorization and state during this QA run.");
    } else {
      required(Date.parse(occurredAt) >= Date.parse(doc.startedAt), "Start a fresh QA operation after initializing this run.");
    }
    for (const previous of Object.values(doc.checkpoints)) {
      if (previous.status === "pass" && cases.find(entry => entry.key === previous.key)?.family === item.family) {
        required(previous.operationId === operationId, "Related checkpoints must use the same stable operation.");
        const approved = ["30-location-approved-owner", "31-location-approved-recipient", "32-location-share-expired"];
        required(!approved.includes(key) || !approved.includes(previous.key) || previous.sourceId === sourceId,
          "Owner, recipient and expiry must verify the same resulting grant.");
        required(previous.role === role ? previous.viewer === viewer : previous.viewer !== viewer,
          "Use the same test account per role and different accounts across counterpart roles.");
      }
    }
    required(doc.captures[key]?.feed && doc.captures[key]?.detail, "Capture both native screenshots before passing.");
    for (const kind of ["feed", "detail"]) {
      const saved = doc.captures[key][kind];
      const png = await fs.readFile(shotPath(key, kind));
      required(saved.platform === "native-simulator" && saved.sha256 === digest(png), "The native capture no longer matches its recorded bytes.");
    }
  }
  const safeProof = proof ? { source: proof.source, requestRef: proof.requestRef, at: proof.at,
    operationId: proof.operationId, viewer: proof.viewer, state: proof.state, providerMode: proof.providerMode,
    ...(item.section === "Location" ? { sourceId: proof.sourceId, openedFeedItemId: proof.openedFeedItemId,
      openedFeedGroupId: proof.openedFeedGroupId } : {}),
    ...(["27-history-refresh", "44-location-history-refresh"].includes(key) && status === "pass" ? {
      readback: { sessions: proof.readback.sessions, visibleRows: proof.readback.visibleRows,
        selectedRowUnreadAfterRefresh: proof.readback.selectedRowUnreadAfterRefresh,
        unreadBefore: proof.readback.unreadBefore, unreadAfter: proof.readback.unreadAfter },
    } : {}),
    ...(key === "41-location-two-emergencies" && status === "pass" ? {
      readback: { incidentIds: proof.readback.incidentIds, liveRowsAfterClear: proof.readback.liveRowsAfterClear },
    } : {}),
    ...(key === "38-location-nearby" && status === "pass" ? {
      readback: { feedRows: proof.readback.feedRows, searchResults: proof.readback.searchResults },
    } : {}),
    ...(key === "42-location-incident-ended" && status === "pass" ? {
      readback: { endedIncidentId: proof.readback.endedIncidentId, liveIncidentIds: proof.readback.liveIncidentIds },
    } : {}),
  } : undefined;
  doc.checkpoints[key] = { key, role, viewer, operationId, sourceId, feedItemId, occurredAt, state, copy, destination,
    status, reason, proof: safeProof, recordedAt: new Date().toISOString() };
  await writeManifest(doc);
  process.exit(0);
}

const pass = cases.filter(item => doc.checkpoints[item.key]?.status === "pass").length;
const rows = cases.map(item => {
  const ev = doc.checkpoints[item.key];
  const screenshots = ["feed", "detail"].filter(kind => doc.captures[item.key]?.[kind]).map(kind => {
    const filename = path.basename(shotPath(item.key, kind));
    return '<a href="' + filename + '"><img loading="lazy" alt="Native ' + kind + ' screenshot" src="' + filename + '"></a>';
  }).join(" ");
  return "<tr><td>" + h(item.key) + "<br>" + (screenshots || "No native evidence") +
    "</td><td>" + h(ev?.role || item.role) + "<br>" + h(ev?.viewer || "—") + "<br>" + h(ev?.operationId || "—") +
    "<br>" + h(ev?.occurredAt || "—") + "</td><td>" + h(ev?.state || item.state) + "<br>" + h(ev?.proof?.source || item.authority) +
    (ev?.proof ? "<br><small>" + h(ev.proof.requestRef) + " · " + h(ev.proof.at) + "</small>" : "") +
    "</td><td>" + h(ev?.copy || "—") + "</td><td>" + h(ev?.destination || "—") +
    "</td><td>" + h(ev?.status || "not run") + (ev?.reason ? "<br>" + h(ev.reason) : "") + "</td></tr>";
}).join("");
await fs.writeFile(path.join(root, "index.html"), '<!doctype html><meta charset="utf-8"><title>Private One Feed native UAT</title>' +
  '<style>body{font:15px/1.5 system-ui;margin:24px}td,th{border:1px solid #ccc;text-align:left;vertical-align:top;padding:8px}table{border-collapse:collapse}img{width:120px;height:auto}</style>' +
  "<h1>Private One Feed · native UAT evidence</h1><p>iPhone 15 Pro · revision " + h(doc.revision) + " · " + pass + "/" + cases.length +
  " passed</p><table><tr><th>Screenshot</th><th>Role / operation / UTC</th><th>Confirmed state / source</th><th>Actual copy</th><th>Actual tap destination</th><th>Pass/fail</th></tr>" + rows + "</table>",
  { mode: 0o600 });
console.log("Private native report: " + pass + "/" + cases.length + " passed.");
if (cases.some(item => !["pass", "unsupported"].includes(doc.checkpoints[item.key]?.status))) process.exitCode = 1;

/** Validator fixtures only; no app account, provider operation or native evidence. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./verify-feed-uat-evidence.mjs", import.meta.url));
function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "feed-evidence-validator-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  assert.equal(run("init", directory, "0".repeat(40), "https://validator.uat.example.com").status, 0);
  const manifest = path.join(directory, "qa-manifest.json");
  const time = JSON.parse(fs.readFileSync(manifest)).startedAt;
  const checkpoint = {
    case: "28-location-review", role: "location-owner", viewer: "qa_validator",
    operationId: "request-1", sourceId: "request-1", occurredAt: time,
    state: "validator-only", copy: "Validator fixture", status: "pass",
    destination: "/one/location?action=needs-review&requestId=request-1",
    proof: { source: "validator-only-not-UAT", requestRef: "receipt-1", at: time,
      operationId: "request-1", viewer: "qa_validator", state: "validator-only", sourceId: "request-1" },
  };
  const record = value => {
    const input = path.join(directory, "checkpoint.json");
    fs.writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
    return run("record", directory, input);
  };
  return { directory, run, manifest, checkpoint, record };
}
function rejected(result, message) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
}

test("settled review/share URLs pass routing checks but fixtures cannot pass as native evidence", t => {
  const { checkpoint, record } = harness(t);
  rejected(record(checkpoint), /Capture both native screenshots/);
  const share = { ...checkpoint, case: "31-location-approved-recipient", role: "requester", sourceId: "grant-1",
    proof: { ...checkpoint.proof, sourceId: "grant-1" },
    destination: "/one/location?action=shared-with-me&locationNotification=opened&grantId=grant-1" };
  rejected(record(share), /Capture both native screenshots/);
  rejected(record({ ...share, destination: "/one/location?grantId=grant-1" }), /different destination/);
});

test("a matching workflow cannot authorize another source or an unspecified Feed detail", t => {
  const { checkpoint, record } = harness(t);
  rejected(record({ ...checkpoint, proof: { ...checkpoint.proof, sourceId: "foreign-grant" } }), /exact source selector/);
  const history = { ...checkpoint, case: "32-location-share-expired", role: "requester", destination: "/one/feed" };
  rejected(record(history), /exact opened Feed detail ID/);
  rejected(record({ ...history, proof: { ...history.proof, openedFeedItemId: "123", openedFeedGroupId: "foreign-group" } }), /verified operation group/);
  rejected(record({ ...history, proof: { ...history.proof, openedFeedItemId: "123", openedFeedGroupId: "location-request:request-1" } }), /Capture both native screenshots/);
  rejected(record({ ...checkpoint, sourceId: "another-request", destination: "/one/location?action=needs-review&requestId=another-request" }), /exact reviewed operation/);
  rejected(record({ ...history, destination: "/\\attacker.example/one/feed" }), /different destination/);
});

test("both distinct incidents must include the selected grant and exact receipt", t => {
  const { checkpoint, record } = harness(t);
  const incident = { ...checkpoint, operationId: "grant-1", sourceId: "grant-1", case: "41-location-two-emergencies", role: "recipient", feedItemId: "123",
    destination: "/one/location?action=shared-with-me&locationNotification=opened&grantId=grant-1&feedItemId=123",
    proof: { ...checkpoint.proof, operationId: "grant-1", sourceId: "grant-1", openedFeedItemId: "123", openedFeedGroupId: "location-grant:grant-1",
      readback: { incidentIds: ["grant-1", "grant-2"], liveRowsAfterClear: 2 } } };
  rejected(record(incident), /Capture both native screenshots/);
  for (const ids of [["grant-1", "grant-1"], ["foreign-1", "foreign-2"]]) {
    rejected(record({ ...incident, proof: { ...incident.proof, readback: { ...incident.proof.readback, incidentIds: ids } } }), /distinct confirmed|belong to the confirmed pair/);
  }
});

test("ending one incident preserves the other and allows a new terminal receipt in the same group", t => {
  const { checkpoint, record, manifest } = harness(t);
  const value = JSON.parse(fs.readFileSync(manifest));
  value.checkpoints["41-location-two-emergencies"] = { status: "pass", sourceId: "grant-1",
    proof: { readback: { incidentIds: ["grant-1", "grant-2"] } } };
  fs.writeFileSync(manifest, JSON.stringify(value));
  const ended = { ...checkpoint, operationId: "grant-1", sourceId: "grant-1", case: "42-location-incident-ended", role: "recipient", destination: "/one/feed",
    proof: { ...checkpoint.proof, operationId: "grant-1", sourceId: "grant-1", openedFeedItemId: "124", openedFeedGroupId: "location-grant:grant-1",
      readback: { endedIncidentId: "grant-1", liveIncidentIds: ["grant-2"] } } };
  rejected(record(ended), /Capture both native screenshots/);
  rejected(record({ ...ended, proof: { ...ended.proof, readback: { endedIncidentId: "grant-2", liveIncidentIds: ["grant-1"] } } }), /End the selected incident/);
});

test("Nearby presence and incomplete journeys cannot be reported as passed", t => {
  const { directory, run, checkpoint, record } = harness(t);
  rejected(record({ ...checkpoint, case: "38-location-nearby", role: "nearby-participant", destination: "/one/location/map",
    proof: { ...checkpoint.proof, readback: { feedRows: 1, searchResults: 0 } } }), /no durable Feed or search entry/);
  const report = run("report", directory);
  assert.equal(report.status, 1);
  assert.match(report.stdout, /0\/44 passed/);
});

test("approved owner, recipient and expiry preserve the same resulting grant", t => {
  const { checkpoint, record, manifest } = harness(t);
  const value = JSON.parse(fs.readFileSync(manifest));
  value.checkpoints["30-location-approved-owner"] = { key: "30-location-approved-owner", status: "pass",
    operationId: "request-1", sourceId: "grant-1", role: "location-owner", viewer: "qa_owner" };
  fs.writeFileSync(manifest, JSON.stringify(value));
  const recipient = { ...checkpoint, case: "31-location-approved-recipient", role: "requester", sourceId: "grant-2",
    destination: "/one/location?action=shared-with-me&locationNotification=opened&grantId=grant-2",
    proof: { ...checkpoint.proof, sourceId: "grant-2" } };
  rejected(record(recipient), /same resulting grant/);
  rejected(record({ ...recipient, sourceId: "grant-1", proof: { ...recipient.proof, sourceId: "grant-1" },
    destination: "/one/location?action=shared-with-me&locationNotification=opened&grantId=grant-1" }), /Capture both native screenshots/);
});


test("older document search uses its own operation and requires a current authority readback", t => {
  const { checkpoint, record, manifest } = harness(t);
  const value = JSON.parse(fs.readFileSync(manifest));
  value.checkpoints["03-document-requester"] = { key: "03-document-requester", status: "pass",
    operationId: "fresh-document", role: "requester", viewer: "qa_validator" };
  fs.writeFileSync(manifest, JSON.stringify(value));
  const old = new Date(Date.parse(value.startedAt) - 86400000).toISOString();
  const history = { ...checkpoint, case: "11-search-request", role: "requester",
    operationId: "old-document", sourceId: "old-document", occurredAt: old,
    destination: "/one/consent?tab=pending&requestId=document_share_request%3Aold-document&from=%2Fone%2Ffeed&requestView=sent",
    proof: { ...checkpoint.proof, operationId: "old-document" } };
  rejected(record(history), /Capture both native screenshots/);
  rejected(record({ ...history, occurredAt: value.startedAt }), /predates this QA run/);
  rejected(record({ ...history, proof: { ...history.proof, at: old } }), /Recheck older-history authorization/);
});

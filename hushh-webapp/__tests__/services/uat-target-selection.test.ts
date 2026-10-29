// @vitest-environment node
// The UAT deployment selector.
//
// Every case below is one row of the agreed stale-candidate policy. They are
// tests rather than a runbook because the rule that was broken in the real
// incident - "deploy the newest eligible green SHA, never latest main" - is
// exactly the kind of rule that reads as obvious and gets violated under time
// pressure by someone typing a SHA by hand.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertDeployable,
  assertRuntimeIdentity,
  reconcileUatTarget,
} from "@/scripts/ci/uat-target-selection.mjs";

const A = "a".repeat(40); // older
const B = "b".repeat(40); // newer
const LIVE = "c".repeat(40); // what UAT runs now

describe("the production selector CLI", () => {
  let fixtureDir: string;
  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "uat-selector-"));
    // Replace only the external Git/GitHub inputs in a child process. The
    // production entrypoint, reporting, output file and exit code all run.
    writeFileSync(join(fixtureDir, "inputs.mjs"), `
      import childProcess from "node:child_process";
      import { createHash } from "node:crypto";
      import { readFileSync } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const state = JSON.parse(process.env.SELECTOR_FIXTURE);
      childProcess.execFileSync = (file, args) => {
        if (file === "python3" && args[0] === "scripts/ci/uat_attempt_receipt.py" &&
            args[1] === "verify-attestation") {
          if (state.invalidAttemptAttestation) throw new Error("synthetic wrong signer or run");
          return "";
        }
        if (file !== "git") throw new Error("Unexpected subprocess");
        if (args[0] === "fetch") return "";
        if (args[0] === "rev-parse") return state.main;
        if (args[0] === "rev-list") {
          if (state.historyError) throw new Error("Invalid history");
          return state.candidates.map(item => item.sha).join("\\n");
        }
        if (args[0] === "merge-base") {
          const edge = args[2] + ":" + args[3];
          if (state.diverged || state.notAncestors?.includes(edge)) throw new Error("Not an ancestor");
          return "";
        }
        throw new Error("Unexpected Git command");
      };
      syncBuiltinESMExports();
      function storedZip(fileName, content) {
        const name = Buffer.from(fileName);
        const body = Buffer.from(content);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(0, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(body.length, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 10);
        central.writeUInt32LE(0, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(body.length, 24);
        central.writeUInt16LE(name.length, 28);
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(1, 8);
        end.writeUInt16LE(1, 10);
        end.writeUInt32LE(central.length + name.length, 12);
        end.writeUInt32LE(local.length + name.length + body.length, 16);
        return Buffer.concat([local, name, body, central, name, end]);
      }
      globalThis.fetch = async url => {
        if (state.apiError) return new Response("{}", { status: 503 });
        const path = new URL(url).pathname;
        let payload;
        if (path.endsWith("/deployments")) {
          const page = new URL(url).searchParams.get("page") || "1";
          payload = state.deploymentsByPage?.[page] ??
            (page === "1" ? state.deployments ?? (state.live ? [{ id: 1, sha: state.live,
              created_at: "2026-10-28T09:00:00.000Z" }] : []) : []);
        } else if (path.includes("/statuses")) {
          payload = state.statuses?.[path.split("/").at(-2)] ??
            [{ state: state.verified === false ? "failure" : "success",
              log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/456" }];
        } else if (path.includes("/git/ref/tags/deployed/uat-attempt/")) {
          const tagName = path.split("/git/ref/tags/").at(-1);
          const match = tagName.match(/^deployed\\/uat-attempt\\/([1-9][0-9]*)-([1-9][0-9]*)$/);
          const runId = match?.[1];
          const attempt = Number(match?.[2]);
          const workflow = (state.workflowPaths?.[runId] ?? state.workflowPath ??
            ".github/workflows/deploy-uat.yml").split("@")[0];
          const isChat = workflow === ".github/workflows/deploy-uat-one-chat.yml";
          const kind = isChat ? "one-chat" : "full";
          if (!match || !state.attemptTags?.[kind + ":" + runId + ":" + attempt])
            return new Response("{}", { status: 404 });
          const deployment = state.deployments?.find(item =>
            state.statuses?.[item.id]?.[0]?.log_url?.includes("/actions/runs/" + runId + "/")) ?? {};
          const targetSha = state.fullAcceptanceTargetShaByRun?.[runId] ??
            state.fullAcceptanceTargetSha ?? state.receiptSha ?? deployment.sha ?? state.live ?? state.main;
          const scope = state.fullScopeByRun?.[runId] ?? state.fullScope ?? "all";
          const overrides = state.fullServiceHeadsByRun?.[runId] ?? state.fullServiceHeads ?? {};
          const receipt = isChat
            ? state.oneChatReceipts?.[runId + ":" + attempt] ?? {
                project: "hushh-pda-uat", region: "us-central1", service: "consent-protocol",
                target_sha: state.artifactTargetSha ?? deployment.sha ?? state.live ?? state.main,
                run_id: runId, attempt, status: "success",
                image: "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "e".repeat(64),
                final_serving_revision: "consent-protocol-uat-fixture",
                final_traffic: { "consent-protocol-uat-fixture": 100 },
              }
            : state.fullAcceptanceReceipts?.[runId + ":" + attempt] ?? {
                schema_version: 1,
                repository: "hushh-labs/hushh-research",
                workflow: ".github/workflows/deploy-uat.yml",
                run_id: Number(state.receiptRun ?? runId), run_attempt: attempt,
                environment: "uat", target: "uat",
                resolved_services: scope === "all" ? ["backend", "frontend"] : [scope],
                release: {
                  status: "healthy", release_failed: false, sha: targetSha, scope,
                  final: {
                    backend_revision: "consent-protocol-uat-fixture",
                    backend_sha: overrides.backend ?? targetSha,
                    frontend_revision: "hushh-webapp-uat-fixture",
                    frontend_sha: overrides.frontend ?? targetSha,
                  },
                },
                classification: { status: "healthy", release_failed: false, blocking_classifications: [] },
              };
          const raw = Buffer.from(JSON.stringify(receipt));
          const sha = isChat ? receipt.target_sha : receipt.release.sha;
          const tagSha = "f".repeat(40);
          const tagMessage = [
            "HUSHH-RELEASE-ATTEMPT-RECEIPT v1",
            "kind: " + kind,
            "repository: hushh-labs/hushh-research",
            "workflow: .github/workflows/deploy-uat" + (isChat ? "-one-chat" : "") + ".yml",
            "run_id: " + runId,
            "run_attempt: " + attempt,
            "sha: " + sha,
            "receipt_sha256: " + createHash("sha256").update(raw).digest("hex"),
            "receipt_json_base64: " + raw.toString("base64"),
            "",
          ].join("\\n");
          state.attemptTagObjects ??= {};
          state.attemptTagObjects[tagSha] = {
            tag: tagName,
            object: { type: "commit", sha },
            message: tagMessage,
          };
          payload = { ref: "refs/tags/" + tagName, object: { type: "tag", sha: tagSha } };
        } else if (path.includes("/git/ref/tags/")) {
          payload = { object: { type: "tag", sha: "d".repeat(40) } };
        } else if (path.includes("/git/tags/")) {
          const tagSha = path.split("/").at(-1);
          if (state.attemptTagObjects?.[tagSha]) payload = state.attemptTagObjects[tagSha];
          else {
          const sha = state.receiptSha ?? state.live;
          payload = { object: { type: "commit", sha }, message:
            "sha: " + sha + "\\nrun: https://github.com/hushh-labs/hushh-research/actions/runs/" +
            (state.receiptRun ?? "123") + "\\nbackend_revision: backend-1\\nfrontend_revision: frontend-1" };
          }
        } else if (path.includes("/actions/runs/") && path.includes("/attempts/") && path.endsWith("/jobs")) {
          const pieces = path.split("/");
          const runId = pieces.at(-3);
          const attempt = Number(pieces.at(-2));
          const names = state.receiptWriterJobsByRun?.[runId + ":" + attempt] ??
            (state.receiptWriterJobPresent ? [
              (state.workflowPaths?.[runId] ?? state.workflowPath ?? ".github/workflows/deploy-uat.yml")
                .includes("one-chat")
                ? "Persist and attest exact One Chat UAT attempt receipt"
                : "Persist and attest exact UAT attempt receipt",
            ] : []);
          payload = { total_count: names.length, jobs: names.map(name => ({ name })) };
        } else if (path.includes("/actions/runs/") && path.endsWith("/artifacts")) {
          const runId = path.split("/").at(-2);
          state.artifactRunId = runId;
          const runState = state.runs?.[runId] ?? {};
          const workflow = (state.workflowPaths?.[runId] ?? state.workflowPath ?? ".github/workflows/deploy-uat.yml").split("@")[0];
          const isChat = workflow === ".github/workflows/deploy-uat-one-chat.yml";
          const attemptCount = runState.run_attempt ?? 1;
          payload = state.artifactMissing ? { artifacts: [] } : { artifacts: Array.from(
            { length: attemptCount }, (_, index) => {
              const attempt = index + 1;
              return {
                id: (isChat ? 320 : 330) + attempt,
                name: isChat
                  ? "uat-one-chat-backend-release-" + attempt
                  : "release-acceptance-uat-" + runId + "-" + attempt,
                expired: false,
                size_in_bytes: 1024,
              };
            },
          ) };
        } else if (path.includes("/actions/artifacts/") && path.endsWith("/zip")) {
          const runId = state.artifactRunId;
          const runState = state.runs?.[runId] ?? {};
          const artifactId = Number(path.split("/").at(-2));
          const isChat = artifactId <= 329;
          const artifactAttempt = artifactId - (isChat ? 320 : 330);
          if (isChat) {
            const receipt = state.artifactReceipt ?? {
              project: "hushh-pda-uat", region: "us-central1", service: "consent-protocol",
              target_sha: state.artifactTargetSha ?? state.deployments?.[0]?.sha ?? state.live ?? state.main,
              run_id: runId, attempt: artifactAttempt, status: "success",
              image: "gcr.io/hushh-pda-uat/consent-protocol@sha256:" + "e".repeat(64),
              final_serving_revision: "consent-protocol-uat-fixture",
              final_traffic: { "consent-protocol-uat-fixture": 100 },
            };
            return new Response(storedZip("uat-one-chat-release.json", JSON.stringify(receipt)), {
              status: 200, headers: { "content-type": "application/zip" },
            });
          }
          const deployment = state.deployments?.find(item =>
            state.statuses?.[item.id]?.[0]?.log_url?.includes("/actions/runs/" + runId + "/")) ?? {};
          const targetSha = state.fullAcceptanceTargetShaByRun?.[runId] ??
            state.fullAcceptanceTargetSha ?? state.receiptSha ?? deployment.sha ?? state.live ?? state.main;
          const scope = state.fullScopeByRun?.[runId] ?? state.fullScope ?? "all";
          const overrides = state.fullServiceHeadsByRun?.[runId] ?? state.fullServiceHeads ?? {};
          const receipt = state.fullAcceptanceReceipt ?? {
            schema_version: 1,
            repository: "hushh-labs/hushh-research",
            workflow: ".github/workflows/deploy-uat.yml",
            run_id: Number(state.receiptRun ?? runId), run_attempt: artifactAttempt,
            environment: "uat", target: "uat",
            resolved_services: scope === "all" ? ["backend", "frontend"] : [scope],
            release: {
              status: "healthy", release_failed: false, sha: targetSha, scope,
              final: {
                backend_revision: "consent-protocol-uat-fixture",
                backend_sha: overrides.backend ?? targetSha,
                frontend_revision: "hushh-webapp-uat-fixture",
                frontend_sha: overrides.frontend ?? targetSha,
              },
            },
            classification: { status: "healthy", release_failed: false, blocking_classifications: [] },
          };
          return new Response(storedZip("acceptance.json", JSON.stringify(receipt)), {
            status: 200, headers: { "content-type": "application/zip" },
          });
        } else if (path.includes("/actions/runs/") && path.includes("/attempts/")) {
          const pieces = path.split("/");
          const runId = pieces.at(-3);
          const attempt = Number(pieces.at(-1));
          const runState = state.attempts?.[runId]?.[attempt] ?? {};
          payload = {
            path: state.workflowPaths?.[runId] ?? state.workflowPath ?? ".github/workflows/deploy-uat.yml",
            event: "workflow_dispatch", head_sha: state.runSha ?? state.live,
            status: runState.status ?? "completed", conclusion: runState.conclusion ?? "success",
            run_attempt: attempt,
            run_started_at: runState.run_started_at ?? "2026-10-28T08:00:00.000Z",
          };
        } else if (path.includes("/actions/runs/")) {
          const runId = path.split("/").at(-1);
          const runState = state.runs?.[runId] ?? {};
          payload = { path: state.workflowPaths?.[runId] ?? state.workflowPath ?? ".github/workflows/deploy-uat.yml",
            event: "workflow_dispatch", head_sha: state.runSha ?? state.live,
            status: runState.status ?? "completed", conclusion: runState.conclusion ?? "success",
            run_attempt: runState.run_attempt ?? 1,
            run_started_at: runState.run_started_at ?? "2026-10-28T08:00:00.000Z" };
        } else if (path.includes("/check-runs")) {
          const sha = path.split("/").at(-2);
          const gate = state.candidates.find(item => item.sha === sha)?.gate;
          // GitHub's shape: newest first, per_page window, exact check_name
          // filter. state.crowded puts that many newer checks ahead of the gate.
          const params = new URL(url).searchParams;
          const all = [
            ...Array.from({ length: state.crowded ?? 0 }, () => ({
              name: "Check for due maintenance without cloud credentials",
              status: "completed", conclusion: "success" })),
            ...(gate ? [{ name: "Main Post-Merge Smoke Gate",
              status: gate === "pending" ? "in_progress" : "completed",
              conclusion: gate === "pending" ? null : gate }] : []),
          ];
          const named = params.get("check_name");
          payload = { check_runs: (named ? all.filter(run => run.name === named) : all)
            .slice(0, Number(params.get("per_page") ?? 30)) };
        } else throw new Error("Unexpected GitHub request");
        return new Response(JSON.stringify(payload), { status: 200 });
      };
    `);
  });
  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

  function run(state: object, allowNoOp = true, extraArgs: string[] = []) {
    const output = join(fixtureDir, "github-output");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [
      "--import", pathToFileURL(join(fixtureDir, "inputs.mjs")).href,
      resolve("scripts/ci/select-uat-target.mjs"),
      "--github-output", ...(allowNoOp ? ["--allow-no-op"] : []), ...extraArgs,
    ], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: "synthetic-selector-token",
        GITHUB_RUN_ATTEMPT: String((state as { currentAttempt?: number }).currentAttempt ?? 1),
        GITHUB_OUTPUT: output, GITHUB_RUN_ID: (state as { currentRunId?: string }).currentRunId ?? "999",
        SELECTOR_FIXTURE: JSON.stringify(state) },
    });
    return { ...result, output: readFileSync(output, "utf8") };
  }

  it("captures and rechecks the exact UAT predecessor under the deployment lock", () => {
    const selected = run({ main: LIVE, live: LIVE, candidates: [] }, true, ["--capture-uat-baseline"]);
    expect(selected.status, selected.stderr).toBe(0);
    const expected = selected.output.match(/^snapshot=(.+)$/m)?.[1];
    expect(expected).toBeTruthy();

    // Only the deployment record from this exact workflow attempt is excluded.
    const lockTime = run({
      main: LIVE,
      live: LIVE,
      currentRunId: "456",
      currentAttempt: 2,
      deployments: [
        { id: 3, sha: B, created_at: "2026-10-28T12:02:00.000Z" },
        { id: 1, sha: LIVE, created_at: "2026-10-28T09:00:00.000Z" },
      ],
      statuses: {
        3: [{ id: 303, state: "pending", created_at: "2026-10-28T12:02:01.000Z", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      runs: { 456: { status: "in_progress", run_attempt: 2, run_started_at: "2026-10-28T12:00:00.000Z" } },
      workflowPaths: {
        123: ".github/workflows/deploy-uat.yml@main",
        456: ".github/workflows/deploy-uat.yml@main",
      },
    }, false, ["--check-uat-baseline", expected!]);
    expect(lockTime.status, lockTime.stderr).toBe(0);
    expect(lockTime.stdout).toContain("still matches the selected baseline");

    const changed = run({
      main: LIVE,
      live: LIVE,
      currentRunId: "456",
      deployments: [{ id: 3, sha: B, created_at: "2026-10-28T11:00:00.000Z" }, { id: 1, sha: LIVE }],
      statuses: {
        3: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/789/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        123: ".github/workflows/deploy-uat.yml@main",
        789: ".github/workflows/deploy-uat.yml@main",
      },
    }, false, ["--check-uat-baseline", expected!]);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("predecessor changed while this deployment waited");
  }, 20_000);

  it("detects a service-only backend mutation while the full release waits", () => {
    const selected = run({ main: LIVE, live: LIVE, candidates: [] }, true, ["--capture-uat-baseline"]);
    const expected = selected.output.match(/^snapshot=(.+)$/m)?.[1];
    const changed = run({
      main: LIVE,
      live: LIVE,
      currentRunId: "456",
      deployments: [
        { id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" },
        { id: 1, sha: LIVE, created_at: "2026-10-28T09:00:00.000Z" },
      ],
      statuses: {
        2: [{ id: 202, state: "success", created_at: "2026-10-28T11:01:00.000Z", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/789/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        123: ".github/workflows/deploy-uat.yml@main",
        789: ".github/workflows/deploy-uat-one-chat.yml@main",
      },
    }, false, ["--check-uat-baseline", expected!]);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("predecessor changed while this deployment waited");
  });

  it("does not exclude a successful deployment from an earlier attempt of the same run", () => {
    const selected = run({ main: LIVE, live: LIVE, candidates: [] }, true, ["--capture-uat-baseline"]);
    const expected = selected.output.match(/^snapshot=(.+)$/m)?.[1];
    const lockTime = run({
      main: LIVE,
      live: LIVE,
      currentRunId: "456",
      currentAttempt: 2,
      deployments: [
        { id: 3, sha: B, created_at: "2026-10-28T12:02:00.000Z" },
        { id: 2, sha: A, created_at: "2026-10-28T11:00:00.000Z" },
        { id: 1, sha: LIVE, created_at: "2026-10-28T09:00:00.000Z" },
      ],
      statuses: {
        3: [{ id: 303, state: "pending", created_at: "2026-10-28T12:02:01.000Z", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        2: [{ id: 202, state: "success", created_at: "2026-10-28T11:01:00.000Z", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      runs: { 456: { status: "in_progress", run_attempt: 2, run_started_at: "2026-10-28T12:00:00.000Z" } },
      workflowPaths: {
        123: ".github/workflows/deploy-uat.yml@main",
        456: ".github/workflows/deploy-uat.yml@main",
      },
    }, false, ["--check-uat-baseline", expected!]);
    expect(lockTime.status).toBe(1);
    expect(lockTime.stderr).toContain("predecessor changed while this deployment waited");
  });

  it("blocks unclassified or unhealthy UAT mutation predecessors", () => {
    const unknown = run({
      main: LIVE, live: LIVE, candidates: [],
      deployments: [{ id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" }, { id: 1, sha: LIVE }],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/789/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: { 789: ".github/workflows/unknown-uat.yml@main", 123: ".github/workflows/deploy-uat.yml@main" },
    }, true, ["--capture-uat-baseline"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("unclassified workflow");
    const unhealthy = run({ main: LIVE, live: LIVE, verified: false, candidates: [] }, true, ["--capture-uat-baseline"]);
    expect(unhealthy.status).toBe(1);
    expect(unhealthy.stderr).toContain("is not healthy");
  });

  it("recognizes an already-deployed commit without inventing a deployment target", () => {
    const state = { main: LIVE, live: LIVE, candidates: [] };
    const result = run(state);
    expect(result.status).toBe(0);
    expect(result.output).toContain("sha=\ndecision=NO_OP\n");
    expect(result.output).toContain(`uat_actual_sha=${LIVE}\n`);
    expect(result.output).toContain("reason=UAT already runs");
    // Existing callers still fail closed when they require a new target.
    expect(run(state, false).status).toBe(3);
  });

  it.each([
    { state: { main: B, live: null, candidates: [] }, expectedStatus: 1 },
    { state: { main: LIVE, live: LIVE, statuses: { 1: [{ state: "failure" }, { state: "success" }] }, candidates: [] }, expectedStatus: 1 },
    { state: { main: LIVE, live: LIVE, statuses: { 1: [{ state: "inactive" }, { state: "success" }] }, candidates: [] }, expectedStatus: 1 },
    { state: { main: LIVE, live: LIVE, deployments: [{ id: 2, sha: B }, { id: 1, sha: LIVE }],
      statuses: { 2: [{ state: "failure" }], 1: [{ state: "success" }] }, candidates: [] }, expectedStatus: 1 },
    { state: { main: LIVE, live: LIVE, workflowPath: ".github/workflows/rollback.yml", candidates: [] }, expectedStatus: 1 },
    { state: { main: LIVE, live: LIVE, workflowPath: ".github/workflows/pkm-upgrade-rehearsal.yml", candidates: [] }, expectedStatus: 1 },
    { state: { main: LIVE, live: LIVE, receiptSha: B, candidates: [] }, expectedStatus: 3 },
    { state: { main: LIVE, live: LIVE, receiptRun: "999", candidates: [] }, expectedStatus: 1 },
    { state: { main: LIVE, live: LIVE, runSha: B, candidates: [] }, expectedStatus: 3 },
    { state: { main: LIVE, live: LIVE, statuses: { 1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }] }, candidates: [] }, expectedStatus: 0 },
    { state: { main: B, live: LIVE, candidates: [] }, expectedStatus: 3 },
    { state: { main: B, live: LIVE, candidates: [{ sha: B, gate: "pending" }] }, expectedStatus: 3 },
    { state: { main: B, live: LIVE, candidates: [{ sha: B, gate: "failure" }] }, expectedStatus: 3 },
  ])("refuses an unverified or unavailable target (%j)", ({ state, expectedStatus }) => {
    expect(run(state).status).toBe(expectedStatus);
  });

  it("blocks when no full UAT deployment has succeeded", () => {
    expect(run({ main: LIVE, live: LIVE, verified: false, candidates: [] }).status).toBe(1);
  });

  it("refuses an exact-SHA rollback that predates the serving UAT source", () => {
    const safe = run({ main: LIVE, live: LIVE, candidates: [] }, true, [
      "--assert-forward-from-uat", LIVE,
    ]);
    expect(safe.status).toBe(0);
    const rollback = run({ main: LIVE, live: LIVE, candidates: [], notAncestors: [`${LIVE}:${B}`] }, true, [
      "--assert-forward-from-uat", B,
    ]);
    expect(rollback.status).toBe(1);
    expect(rollback.stderr).toContain("does not descend from the current UAT predecessor");
  }, 20_000);

  it("requires exact service receipt ancestry after a One Chat backend release", () => {
    const predecessor = {
      main: B,
      live: LIVE,
      artifactTargetSha: B,
      candidates: [{ sha: A, gate: "success" }],
      notAncestors: [`${B}:${A}`],
      deployments: [
        { id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" },
        { id: 1, sha: LIVE, created_at: "2026-10-28T09:00:00.000Z" },
      ],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        456: ".github/workflows/deploy-uat-one-chat.yml@main",
        123: ".github/workflows/deploy-uat.yml@main",
      },
    };
    const automatic = run(predecessor);
    expect(automatic.status).toBe(2);
    expect(automatic.stdout).toContain("regress the serving UAT backend service predecessor");

    const explicit = run(predecessor, true, ["--assert-forward-from-uat", A]);
    expect(explicit.status).toBe(1);
    expect(explicit.stderr).toContain("does not descend from the current UAT predecessor for serving backend");
  }, 20_000);

  it.each([
    ["backend", { backend: B, frontend: LIVE }, `${B}, ${LIVE}`],
    ["frontend", { backend: LIVE, frontend: B }, `${LIVE}, ${B}`],
  ] as const)("preserves both serving source heads after a %s-only full UAT release", (scope, serviceHeads, expected) => {
    const result = run({
      main: B,
      live: B,
      candidates: [],
      fullScope: scope,
      fullServiceHeads: serviceHeads,
      deployments: [{ id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" }],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
      },
      workflowPaths: { 456: ".github/workflows/deploy-uat.yml@main" },
    }, true, ["--assert-forward-from-uat", B]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`service predecessors ${expected}`);
  });

  it("keeps the unchanged backend source through a later frontend-only full release", () => {
    const result = run({
      main: B,
      live: B,
      candidates: [],
      fullScopeByRun: { 456: "frontend" },
      fullServiceHeadsByRun: { 456: { backend: A, frontend: B } },
      deployments: [
        { id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" },
        { id: 1, sha: A, created_at: "2026-10-28T09:00:00.000Z" },
      ],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        456: ".github/workflows/deploy-uat.yml@main",
        123: ".github/workflows/deploy-uat-one-chat.yml@main",
      },
    }, true, ["--assert-forward-from-uat", B]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`service predecessors ${A}, ${B}`);
  });

  it("blocks when the exact One Chat attempt release receipt is missing", () => {
    const result = run({
      main: LIVE,
      live: LIVE,
      candidates: [],
      artifactMissing: true,
      deployments: [
        { id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" },
        { id: 1, sha: LIVE, created_at: "2026-10-28T09:00:00.000Z" },
      ],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        456: ".github/workflows/deploy-uat-one-chat.yml@main",
        123: ".github/workflows/deploy-uat.yml@main",
      },
    }, false, ["--capture-uat-baseline"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no unique, retained release receipt");
  });

  it("blocks a full UAT predecessor without its exact attempt acceptance artifact", () => {
    const result = run({
      main: LIVE,
      live: LIVE,
      candidates: [],
      artifactMissing: true,
    }, false, ["--capture-uat-baseline"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no unique, retained acceptance receipt");
  });

  it("does not fall back to a retained artifact after the durable receipt writer ran", () => {
    const result = run({
      main: LIVE,
      live: LIVE,
      candidates: [],
      receiptWriterJobPresent: true,
    }, false, ["--capture-uat-baseline"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing its required durable receipt tag");
  });

  it("lets a successful backend full release supersede an older failed One Chat attempt", () => {
    const result = run({
      main: B,
      live: B,
      candidates: [],
      fullScope: "backend",
      deployments: [
        { id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" },
        { id: 1, sha: A, created_at: "2026-10-28T10:00:00.000Z" },
      ],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "failure", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        456: ".github/workflows/deploy-uat.yml@main",
        123: ".github/workflows/deploy-uat-one-chat.yml@main",
      },
    }, false, ["--capture-uat-baseline"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Captured current UAT predecessor identity");
  }, 20_000);

  it("keeps a failed One Chat attempt blocking after a frontend-only full release", () => {
    const result = run({
      main: B,
      live: B,
      candidates: [],
      fullScope: "frontend",
      fullServiceHeads: { backend: A, frontend: B },
      deployments: [
        { id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" },
        { id: 1, sha: A, created_at: "2026-10-28T10:00:00.000Z" },
      ],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "failure", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        456: ".github/workflows/deploy-uat.yml@main",
        123: ".github/workflows/deploy-uat-one-chat.yml@main",
      },
    }, false, ["--capture-uat-baseline"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("One Chat predecessor 1 is not successful");
  }, 20_000);

  it("retains backend supersession when a later full release is frontend-only", () => {
    const result = run({
      main: B,
      live: B,
      candidates: [],
      fullScopeByRun: { 789: "frontend", 456: "backend" },
      fullServiceHeadsByRun: {
        789: { backend: A, frontend: B },
        456: { backend: B, frontend: A },
      },
      deployments: [
        { id: 3, sha: B, created_at: "2026-10-28T12:00:00.000Z" },
        { id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" },
        { id: 1, sha: A, created_at: "2026-10-28T10:00:00.000Z" },
      ],
      statuses: {
        3: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/789/job/1" }],
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "failure", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        789: ".github/workflows/deploy-uat.yml@main",
        456: ".github/workflows/deploy-uat.yml@main",
        123: ".github/workflows/deploy-uat-one-chat.yml@main",
      },
    }, false, ["--capture-uat-baseline"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Captured current UAT predecessor identity");
  }, 20_000);

  it("uses an immutable full-attempt tag after the acceptance artifact expires", () => {
    const result = run({
      main: B,
      live: B,
      candidates: [],
      artifactMissing: true,
      attemptTags: { "full:456:1": true },
      deployments: [{ id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" }],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
      },
      workflowPaths: { 456: ".github/workflows/deploy-uat.yml@main" },
    }, false, ["--capture-uat-baseline"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Captured current UAT predecessor identity");
  });

  it("uses a durable One Chat attempt tag after its artifact expires", () => {
    const result = run({
      main: B,
      live: B,
      candidates: [],
      artifactMissing: true,
      attemptTags: { "one-chat:456:1": true, "full:123:1": true },
      deployments: [
        { id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" },
        { id: 1, sha: LIVE, created_at: "2026-10-28T09:00:00.000Z" },
      ],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        456: ".github/workflows/deploy-uat-one-chat.yml@main",
        123: ".github/workflows/deploy-uat.yml@main",
      },
    }, false, ["--capture-uat-baseline"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Captured current UAT predecessor identity");
  });

  it("refuses a durable attempt tag when its receipt provenance is invalid", () => {
    const result = run({
      main: B,
      live: B,
      candidates: [],
      artifactMissing: true,
      invalidAttemptAttestation: true,
      attemptTags: { "full:456:1": true },
      deployments: [{ id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" }],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
      },
      workflowPaths: { 456: ".github/workflows/deploy-uat.yml@main" },
    }, false, ["--capture-uat-baseline"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("receipt provenance verification failed");
  });

  it("rejects a durable attempt tag whose run attempt differs from its deployment", () => {
    const result = run({
      main: B,
      live: B,
      candidates: [],
      artifactMissing: true,
      runs: { 456: { run_attempt: 2 } },
      attemptTags: { "full:456:1": true },
      deployments: [{ id: 2, sha: B, created_at: "2026-10-28T11:00:00.000Z" }],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
      },
      workflowPaths: { 456: ".github/workflows/deploy-uat.yml@main" },
    }, false, ["--capture-uat-baseline"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no unique, retained acceptance receipt");
  });

  it.each([
    [".github/workflows/deploy-uat-one-chat.yml", 3],
    [".github/workflows/ship-ios-testflight.yml", 0],
    [".github/workflows/resume-ios-testflight.yml", 0],
    [".github/workflows/ios-voice-device.yml", 0],
    [".github/workflows/ship-android-playstore-v1.yml", 0],
    [".github/workflows/verify-protected-lists.yml", 0],
    [".github/workflows/diagnose-uat-managed-vertex.yml", 0],
  ] as const)("classifies newer records from %s for UAT baseline admission", (workflow, expectedStatus) => {
    const result = run({
      main: LIVE, live: LIVE, candidates: [],
      deployments: [{ id: 2, sha: B }, { id: 1, sha: LIVE }],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        456: `${workflow}@main`,
        123: ".github/workflows/deploy-uat.yml@main",
      },
    });
    expect(result.status).toBe(expectedStatus);
    expect(result.output).toContain(`uat_actual_sha=${LIVE}\n`);
    expect(result.output).toContain(expectedStatus === 0 ? "decision=NO_OP" : "decision=BLOCKED");
  });

  it("selects a newer green UAT target while a native record already names that main SHA", () => {
    const result = run({
      main: B, live: LIVE, candidates: [{ sha: B, gate: "success" }],
      deployments: [{ id: 2, sha: B }, { id: 1, sha: LIVE }],
      statuses: {
        2: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
        1: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/123/job/1" }],
      },
      workflowPaths: {
        456: ".github/workflows/ship-ios-testflight.yml@main",
        123: ".github/workflows/deploy-uat.yml@main",
      },
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain(`uat_actual_sha=${LIVE}\n`);
    expect(result.output).toContain(`sha=${B}\ndecision=DEPLOY_EXACT_SHA\n`);
  });

  it("blocks no-op when more than 100 partial deployments followed the full UAT baseline", () => {
    const partial = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, sha: B }));
    const result = run({
      main: LIVE, live: LIVE, candidates: [], receiptRun: "456",
      deploymentsByPage: { 1: partial, 2: [{ id: 101, sha: LIVE }] },
      statuses: {
        101: [{ state: "success", log_url: "https://github.com/hushh-labs/hushh-research/actions/runs/456/job/1" }],
      },
      workflowPaths: {
        123: ".github/workflows/deploy-uat-one-chat.yml@main",
        456: ".github/workflows/deploy-uat.yml@main",
      },
    });
    expect(result.status).toBe(3);
    expect(result.output).toContain(`uat_actual_sha=${LIVE}\n`);
    expect(result.output).toContain("decision=BLOCKED");
  });

  it("still selects the newest proven forward-moving commit", () => {
    const result = run({ main: B, live: LIVE, candidates: [{ sha: B, gate: "success" }] });
    expect(result.status).toBe(0);
    expect(result.output).toContain(`sha=${B}\ndecision=DEPLOY_EXACT_SHA\n`);
  });

  it("finds a commit's gate behind more than a page of newer checks", () => {
    // An idle main head gathers the hourly capacity clock's checks, all newer
    // than its push-time gate; an unfiltered first page would hide the gate.
    const result = run({ main: B, live: LIVE, crowded: 150,
      candidates: [{ sha: B, gate: "success" }] });
    expect(result.status).toBe(0);
    expect(result.output).toContain(`sha=${B}\ndecision=DEPLOY_EXACT_SHA\n`);
  });

  it.each([
    [{ apiError: true }, 1],
    [{ historyError: true }, 2],
    [{ diverged: true }, 1],
  ] as const)("keeps infrastructure and history failures blocking (%j)", (failure, status) => {
    const result = run({ main: B, live: LIVE,
      candidates: [{ sha: B, gate: "success" }], ...failure });
    expect(result.status).toBe(status);
    expect(result.output).not.toContain("decision=NO_OP");
  });
});

const base = {
  mainTipSha: B,
  uatActualSha: LIVE,
  uatDeployingSha: null,
  candidates: [],
};

describe("the stale-candidate policy", () => {
  it("A is green, newer B is pending -> deploy A, never B", () => {
    const result = reconcileUatTarget({
      ...base,
      candidates: [
        { sha: B, gate: "pending" },
        { sha: A, gate: "success" },
      ],
    });
    // The exact substitution that caused the incident: a pending tip must never
    // stand in for a proven ancestor.
    expect(result.decision).toBe("DEPLOY_EXACT_SHA");
    expect(result.targetSha).toBe(A);
  });

  it("A is green and B becomes green first -> deploy B, coalescing A", () => {
    const result = reconcileUatTarget({
      ...base,
      candidates: [
        { sha: B, gate: "success" },
        { sha: A, gate: "success" },
      ],
    });
    // B contains A and has its own gate, so the older queued candidate is
    // safely superseded rather than deployed twice.
    expect(result.targetSha).toBe(B);
  });

  it("a deployment is already running -> never cancel or retarget it", () => {
    const result = reconcileUatTarget({
      ...base,
      uatDeployingSha: A,
      candidates: [{ sha: B, gate: "success" }],
    });
    expect(result.decision).toBe("DEPLOY_IN_FLIGHT");
    expect(result.targetSha).toBeNull();
    expect(result.reason).toMatch(/never cancelled or retargeted/i);
  });

  it("A is green and newer B failed -> deploy A, and report main blocked at B", () => {
    const result = reconcileUatTarget({
      ...base,
      candidates: [
        { sha: B, gate: "failure" },
        { sha: A, gate: "success" },
      ],
    });
    // A failure downstream says nothing about A, which passed its own gate.
    expect(result.decision).toBe("DEPLOY_EXACT_SHA");
    expect(result.targetSha).toBe(A);
    expect(result.blockedAtSha).toBe(B);
  });

  it("nothing green yet -> wait, and leave UAT alone", () => {
    const result = reconcileUatTarget({
      ...base,
      candidates: [
        { sha: B, gate: "pending" },
        { sha: A, gate: "pending" },
      ],
    });
    expect(result.decision).toBe("AUTOMATIC_WAIT");
    expect(result.targetSha).toBeNull();
  });

  it("everything failed -> blocked, and UAT stays put", () => {
    const result = reconcileUatTarget({
      ...base,
      candidates: [{ sha: B, gate: "failure" }],
    });
    expect(result.decision).toBe("BLOCKED");
    expect(result.targetSha).toBeNull();
    expect(result.blockedAtSha).toBe(B);
  });

  it("no candidates -> no move", () => {
    expect(reconcileUatTarget({ ...base, candidates: [] }).decision).toBe("NO_OP");
  });

  it("ignores a commit that has no gate of its own", () => {
    // Non-merge commits carried in by a merge get no post-merge gate. Treating
    // `absent` as deployable would ship an unproven commit; the live
    // reconciliation run hit exactly this case.
    const result = reconcileUatTarget({
      ...base,
      candidates: [
        { sha: B, gate: "absent" },
        { sha: A, gate: "success" },
      ],
    });
    expect(result.targetSha).toBe(A);
  });
});

describe("the pre-deploy gate", () => {
  const ok = {
    targetSha: B,
    uatActualSha: LIVE,
    targetGate: "success" as const,
    reachableFromMain: true,
    descendsFromUatActual: true,
  };

  it("accepts a proven, forward-moving, exact SHA", () => {
    expect(assertDeployable(ok).ok).toBe(true);
  });

  it("refuses a branch name", () => {
    // "Never deploy a branch name" has to be enforced, not documented: the
    // existing workflow resolves a blank input to `git rev-parse origin/main`.
    for (const bad of ["main", "origin/main", "HEAD", "", "abc123"]) {
      const result = assertDeployable({ ...ok, targetSha: bad });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/full 40-character commit SHA/i);
    }
  });

  it("refuses a commit whose own gate is not green", () => {
    for (const gate of ["pending", "failure", "absent", "unknown"] as const) {
      expect(assertDeployable({ ...ok, targetGate: gate }).ok).toBe(false);
    }
  });

  it("refuses a commit that is not on protected main", () => {
    expect(assertDeployable({ ...ok, reachableFromMain: false }).ok).toBe(false);
  });

  it("refuses to move UAT backward", () => {
    // Redeploying an ancestor would roll teammates' merged work out of UAT
    // while every check still looked green.
    const result = assertDeployable({ ...ok, descendsFromUatActual: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/never moves backward/i);
  });

  it("treats a redeploy of the live commit as a no-op", () => {
    expect(assertDeployable({ ...ok, targetSha: LIVE }).ok).toBe(false);
  });

  it("holds a manual target to the same bar as a selected one", () => {
    // A hand-typed SHA is a request, not a permission - the incident began with
    // exactly such a request.
    expect(
      assertDeployable({ ...ok, targetSha: B, targetGate: "pending" }).ok,
    ).toBe(false);
  });
});

describe("proving what actually ended up running", () => {
  it("accepts only when smoke passed AND the runtime reports the target", () => {
    expect(
      assertRuntimeIdentity({ targetSha: B, runtimeSha: B, smokePassed: true }).ok,
    ).toBe(true);
  });

  it("rejects a green smoke check with the wrong build live", () => {
    // HTTP 200 proves a server answered, not which build answered. This is the
    // stale-rollout and mutable-tag failure mode.
    const result = assertRuntimeIdentity({
      targetSha: B,
      runtimeSha: A,
      smokePassed: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/investigate tagging or rollout/i);
  });

  it("rejects a runtime that cannot say what it is", () => {
    expect(
      assertRuntimeIdentity({ targetSha: B, runtimeSha: null, smokePassed: true }).ok,
    ).toBe(false);
  });

  it("rejects a failed smoke check even when identity matches", () => {
    expect(
      assertRuntimeIdentity({ targetSha: B, runtimeSha: B, smokePassed: false }).ok,
    ).toBe(false);
  });
});

// Shared child-process harness for selector CLI regression suites.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function createUatSelectorCliFixture() {
  const fixtureDir = mkdtempSync(join(tmpdir(), "uat-selector-"));
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
  return { run, cleanup: () => rmSync(fixtureDir, { recursive: true, force: true }) };
}

// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUatSelectorCliFixture } from "./uat-target-selection-cli-fixture";

const A = "a".repeat(40);
const B = "b".repeat(40);
const LIVE = "c".repeat(40);

describe("release history and attempt receipts", () => {
  let fixture!: ReturnType<typeof createUatSelectorCliFixture>;
  beforeAll(() => { fixture = createUatSelectorCliFixture(); });
  afterAll(() => fixture.cleanup());
  const run = (state: object, allowNoOp = true, extraArgs: string[] = []) =>
    fixture.run(state, allowNoOp, extraArgs);

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


});

// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUatSelectorCliFixture } from "./uat-target-selection-cli-fixture";

const A = "a".repeat(40);
const B = "b".repeat(40);
const LIVE = "c".repeat(40);

describe("the UAT mutation baseline", () => {
  let fixture!: ReturnType<typeof createUatSelectorCliFixture>;
  beforeAll(() => { fixture = createUatSelectorCliFixture(); });
  afterAll(() => fixture.cleanup());
  const run = (state: object, allowNoOp = true, extraArgs: string[] = []) =>
    fixture.run(state, allowNoOp, extraArgs);

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


});

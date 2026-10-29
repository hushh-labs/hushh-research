// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUatSelectorCliFixture } from "./uat-target-selection-cli-fixture";

const B = "b".repeat(40);
const LIVE = "c".repeat(40);

describe("candidate selection through the CLI", () => {
  let fixture!: ReturnType<typeof createUatSelectorCliFixture>;
  beforeAll(() => { fixture = createUatSelectorCliFixture(); });
  afterAll(() => fixture.cleanup());
  const run = (state: object, allowNoOp = true, extraArgs: string[] = []) =>
    fixture.run(state, allowNoOp, extraArgs);

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

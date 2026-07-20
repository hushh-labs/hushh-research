import { describe, expect, it } from "vitest";

import {
  advanceNativeUiCheckpoint,
  createNativeUiAuditManifest,
  createNativeUiAuditPlan,
  hasTerminalNativeUiStatus,
  nativeUiFlowStepTimeoutMs,
  validateNativeUiAuditCompletion,
} from "../../scripts/native/native-ui-audit-plan.mjs";

const WATCHDOG_FLOW = {
  id: "ordered-onboarding",
  route: "/one/location",
  watchdog: {
    checkpoints: ["welcome", "arrival", "permissions"],
    maxCheckpointRegressions: 0,
    maxNoProgressMs: 20_000,
  },
  steps: [
    { type: "assert_visible_testid", testId: "welcome" },
    { type: "assert_visible_testid", testId: "arrival" },
    { type: "assert_visible_testid", testId: "permissions" },
  ],
};

const FLOWS = [
  {
    id: "required-route",
    route: "/one/kai",
    steps: [{ type: "navigate_route", route: "/one/kai" }],
  },
  {
    id: "optional-card",
    route: "/marketplace",
    optional: true,
    stepTimeoutMs: 60_000,
    steps: [{ type: "click_button", name: "open workspace", optional: true }],
  },
  {
    id: "ria-workspace",
    route: "/ria/clients",
    requiresRiaWorkspace: true,
    steps: [
      { type: "ensure_ria_workspace" },
      { type: "click_top_tab", label: "Clients" },
    ],
  },
];

function completeReport(plan: ReturnType<typeof createNativeUiAuditPlan>) {
  return {
    ok: true,
    auditRunId: "ios-test-run",
    auditPlanVersion: plan.version,
    auditPlanDigest: plan.digest,
    startedAt: "2026-07-19T00:00:00.000Z",
    completedAt: "2026-07-19T00:00:01.000Z",
    flows: [
      { id: "required-route", ok: true },
      { id: "optional-card", ok: true, skipped: true },
      { id: "ria-workspace", ok: true, skipped: true, skipClass: "onboarding_admission" },
    ],
  };
}

function completeStatus(plan: ReturnType<typeof createNativeUiAuditPlan>) {
  return {
    ui_complete: "1",
    ui_ok: "1",
    uirunner: "1",
    runui: "1",
    uistarted: "1",
    bootstrap: "vault_unlocked",
    bootstrap_uid_ok: "1",
    uifailed: "0",
    visible404: "0",
    ui_run: "ios-test-run",
    ui_plan: plan.digest,
  };
}

describe("native UI audit plan", () => {
  it("recognizes only fully settled native terminal status", () => {
    const plan = createNativeUiAuditPlan(FLOWS);
    const terminalStatus = completeStatus(plan);

    expect(hasTerminalNativeUiStatus(terminalStatus)).toBe(true);
    expect(
      hasTerminalNativeUiStatus({ ...terminalStatus, ui_complete: "0" }),
    ).toBe(false);
    expect(
      hasTerminalNativeUiStatus({
        ...terminalStatus,
        bootstrap: "waiting_vault_user",
      }),
    ).toBe(false);
  });

  it("generates a deterministic manifest that binds executable flow content", () => {
    const first = createNativeUiAuditPlan(FLOWS);
    const second = createNativeUiAuditPlan(FLOWS);
    const changed = createNativeUiAuditPlan([
      { ...FLOWS[0], steps: [{ type: "navigate_route", route: "/one/profile" }] },
      FLOWS[1],
    ]);

    expect(first).toEqual(second);
    expect(changed.digest).not.toBe(first.digest);
    expect(createNativeUiAuditManifest(FLOWS).audit_plan).toEqual(first);
  });

  it("rejects an RIA workspace flow that can bypass its admission preflight", () => {
    expect(() =>
      createNativeUiAuditPlan([
        {
          id: "invalid-ria-workspace",
          route: "/ria/clients",
          requiresRiaWorkspace: true,
          steps: [{ type: "click_top_tab", label: "Clients" }],
        },
      ]),
    ).toThrow("must begin with ensure_ria_workspace");
  });

  it("accepts only an exact completed report and identifies optional and conditional skips", () => {
    const plan = createNativeUiAuditPlan(FLOWS);
    expect(
      validateNativeUiAuditCompletion({
        report: completeReport(plan),
        status: completeStatus(plan),
        plan,
        runId: "ios-test-run",
      }),
    ).toEqual({
      ok: true,
      optionalSkippedFlowIds: ["optional-card"],
      conditionalRiaWorkspaceSkippedFlowIds: ["ria-workspace"],
    });
  });

  it.each([
    ["wrong run", (plan: ReturnType<typeof createNativeUiAuditPlan>) => ({ ...completeReport(plan), auditRunId: "old-run" })],
    ["wrong digest", (plan: ReturnType<typeof createNativeUiAuditPlan>) => ({ ...completeReport(plan), auditPlanDigest: "0".repeat(64) })],
    ["partial flows", (plan: ReturnType<typeof createNativeUiAuditPlan>) => ({ ...completeReport(plan), flows: [completeReport(plan).flows[0]] })],
    ["duplicated flow", (plan: ReturnType<typeof createNativeUiAuditPlan>) => ({ ...completeReport(plan), flows: [completeReport(plan).flows[0], completeReport(plan).flows[0]] })],
    ["required skip", (plan: ReturnType<typeof createNativeUiAuditPlan>) => ({ ...completeReport(plan), flows: [{ id: "required-route", ok: true, skipped: true }, ...completeReport(plan).flows.slice(1)] })],
  ])("rejects %s", (_label, makeReport) => {
    const plan = createNativeUiAuditPlan(FLOWS);
    const result = validateNativeUiAuditCompletion({
      report: makeReport(plan),
      status: completeStatus(plan),
      plan,
      runId: "ios-test-run",
    });
    expect(result.ok).toBe(false);
  });

  it("derives a progress deadline from the active flow step", () => {
    expect(nativeUiFlowStepTimeoutMs(FLOWS, { ui_flow: "required-route", ui_step: "0" })).toBe(30_000);
    expect(nativeUiFlowStepTimeoutMs(FLOWS, { ui_flow: "optional-card", ui_step: "0" })).toBe(60_000);
    expect(nativeUiFlowStepTimeoutMs(FLOWS, { ui_flow: "missing", ui_step: "0" })).toBe(45_000);
    expect(
      nativeUiFlowStepTimeoutMs([WATCHDOG_FLOW], {
        ui_flow: WATCHDOG_FLOW.id,
        ui_step: "0",
      }),
    ).toBe(20_000);
  });

  it("allows checkpoint polling but fails closed on unknown or regressive screens", () => {
    const highestByFlow = new Map<string, number>();
    const status = (checkpoint: string) => ({
      ui_flow: WATCHDOG_FLOW.id,
      ui_checkpoint: checkpoint,
    });

    expect(
      advanceNativeUiCheckpoint({
        flows: [WATCHDOG_FLOW],
        status: status("welcome"),
        highestByFlow,
      }),
    ).toEqual({ ok: true, advanced: true });
    expect(
      advanceNativeUiCheckpoint({
        flows: [WATCHDOG_FLOW],
        status: status("welcome"),
        highestByFlow,
      }),
    ).toEqual({ ok: true, advanced: false });
    expect(
      advanceNativeUiCheckpoint({
        flows: [WATCHDOG_FLOW],
        status: status("arrival"),
        highestByFlow,
      }),
    ).toEqual({ ok: true, advanced: true });
    expect(
      advanceNativeUiCheckpoint({
        flows: [WATCHDOG_FLOW],
        status: status("welcome"),
        highestByFlow,
      }),
    ).toEqual({ ok: false, advanced: false, reason: "checkpoint regression" });
    expect(
      advanceNativeUiCheckpoint({
        flows: [WATCHDOG_FLOW],
        status: status("unknown"),
        highestByFlow: new Map(),
      }),
    ).toEqual({ ok: false, advanced: false, reason: "unknown checkpoint" });
  });

  it("requires every authored watchdog checkpoint in the terminal report", () => {
    const plan = createNativeUiAuditPlan([WATCHDOG_FLOW]);
    const baseReport = {
      ok: true,
      auditRunId: "ios-test-run",
      auditPlanVersion: plan.version,
      auditPlanDigest: plan.digest,
      startedAt: "2026-07-19T00:00:00.000Z",
      completedAt: "2026-07-19T00:00:01.000Z",
      flows: [
        {
          id: WATCHDOG_FLOW.id,
          ok: true,
          results: WATCHDOG_FLOW.watchdog.checkpoints.map((checkpoint, step) => ({
            step,
            type: "assert_visible_testid",
            ok: true,
            checkpoint,
          })),
        },
      ],
    };

    expect(
      validateNativeUiAuditCompletion({
        report: baseReport,
        status: completeStatus(plan),
        plan,
        runId: "ios-test-run",
      }).ok,
    ).toBe(true);
    expect(
      validateNativeUiAuditCompletion({
        report: {
          ...baseReport,
          flows: [
            {
              ...baseReport.flows[0],
              results: baseReport.flows[0].results.slice(0, 2),
            },
          ],
        },
        status: completeStatus(plan),
        plan,
        runId: "ios-test-run",
      }).ok,
    ).toBe(false);
  });
});

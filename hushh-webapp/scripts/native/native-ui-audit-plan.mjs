import { createHash } from "node:crypto";

export const NATIVE_UI_AUDIT_PLAN_VERSION = 1;
export const NATIVE_UI_TERMINAL_STATUS_GRACE_MS = 10_000;

const TERMINAL_NATIVE_STATUS = {
  ui_complete: "1",
  ui_ok: "1",
  uirunner: "1",
  runui: "1",
  uistarted: "1",
  bootstrap: "vault_unlocked",
  bootstrap_uid_ok: "1",
};

export function hasTerminalNativeUiStatus(status = {}) {
  return Object.entries(TERMINAL_NATIVE_STATUS).every(
    ([key, expected]) => String(status?.[key] || "") === expected,
  );
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertFlowCollection(flows) {
  if (!Array.isArray(flows) || flows.length === 0) {
    throw new Error("Native UI audit plan requires at least one flow.");
  }

  const ids = new Set();
  for (const flow of flows) {
    const id = String(flow?.id || "").trim();
    if (!id) {
      throw new Error("Native UI audit plan contains a flow without an id.");
    }
    if (ids.has(id)) {
      throw new Error(`Native UI audit plan contains duplicate flow id: ${id}`);
    }
    if (
      flow.requiresRiaWorkspace === true &&
      flow.steps?.[0]?.type !== "ensure_ria_workspace"
    ) {
      throw new Error(
        `RIA workspace flow must begin with ensure_ria_workspace: ${id}`,
      );
    }
    ids.add(id);
  }
}

function planSource(flows) {
  return {
    version: NATIVE_UI_AUDIT_PLAN_VERSION,
    flows: cloneSerializable(flows),
  };
}

export function createNativeUiAuditPlan(flows) {
  assertFlowCollection(flows);
  const source = planSource(flows);
  const flowIds = source.flows.map((flow) => flow.id);
  const optionalFlowIds = source.flows
    .filter((flow) => flow.optional === true)
    .map((flow) => flow.id);
  const conditionalFlowIds = source.flows
    .filter((flow) => flow.requiresRiaWorkspace === true)
    .map((flow) => flow.id);

  return {
    version: NATIVE_UI_AUDIT_PLAN_VERSION,
    digest: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
    flow_count: flowIds.length,
    flow_ids: flowIds,
    required_flow_ids: flowIds.filter((id) => !optionalFlowIds.includes(id)),
    optional_flow_ids: optionalFlowIds,
    conditional_ria_workspace_flow_ids: conditionalFlowIds,
    flows: source.flows.map((flow) => ({
      id: flow.id,
      watchdog: flow.watchdog || null,
    })),
  };
}

export function createNativeUiAuditManifest(flows) {
  return {
    generated_at: new Date().toISOString(),
    audit_plan: createNativeUiAuditPlan(flows),
    flow_count: flows.length,
    flows,
  };
}

function validationFailure(reason) {
  return { ok: false, errorClass: "other", reason };
}

function exactOrderedIds(flows) {
  return flows.map((flow) => String(flow?.id || ""));
}

function sameArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * Validates only metadata and terminal execution state. It deliberately does
 * not inspect a reviewer identity, slot, route query, vault key, or rendered
 * content, so it is safe for the host audit report and unit tests.
 */
export function validateNativeUiAuditCompletion({ report, status = {}, plan, runId }) {
  if (!plan || typeof plan !== "object") {
    return validationFailure("audit plan is missing");
  }
  if (!runId || typeof runId !== "string") {
    return validationFailure("audit run id is missing");
  }
  if (!report || typeof report !== "object") {
    return validationFailure("terminal UI report is missing");
  }
  if (report.ok !== true) {
    return validationFailure("terminal UI report is not successful");
  }
  if (!report.startedAt || !report.completedAt) {
    return validationFailure("terminal UI report is incomplete");
  }
  if (report.auditRunId !== runId) {
    return validationFailure("terminal UI report belongs to another run");
  }
  if (report.auditPlanVersion !== plan.version) {
    return validationFailure("terminal UI report has an unsupported plan version");
  }
  if (report.auditPlanDigest !== plan.digest) {
    return validationFailure("terminal UI report has a different plan digest");
  }
  if (!Array.isArray(report.flows)) {
    return validationFailure("terminal UI report has no flow results");
  }

  const reportIds = exactOrderedIds(report.flows);
  if (!sameArray(reportIds, plan.flow_ids || [])) {
    return validationFailure("terminal UI report flow ids do not match the requested plan");
  }

  const optionalIds = new Set(plan.optional_flow_ids || []);
  const conditionalRiaWorkspaceIds = new Set(
    plan.conditional_ria_workspace_flow_ids || [],
  );
  for (const flow of report.flows) {
    if (flow?.ok !== true) {
      return validationFailure(`terminal UI flow failed: ${String(flow?.id || "unknown")}`);
    }
    if (
      flow?.skipped === true &&
      !optionalIds.has(flow.id) &&
      !conditionalRiaWorkspaceIds.has(flow.id)
    ) {
      return validationFailure(`required UI flow was skipped: ${flow.id}`);
    }
    const authoredFlow = (plan.flows || []).find(
      (candidate) => candidate?.id === flow.id,
    );
    const checkpoints = authoredFlow?.watchdog?.checkpoints || [];
    if (checkpoints.length > 0) {
      const observed = (flow.results || [])
        .map((result) => result?.checkpoint)
        .filter(Boolean);
      if (!sameArray(observed, checkpoints)) {
        return validationFailure(
          `terminal UI flow checkpoints are incomplete or out of order: ${flow.id}`,
        );
      }
    }
  }

  for (const [key, expected] of Object.entries(TERMINAL_NATIVE_STATUS)) {
    if (String(status?.[key] || "") !== expected) {
      return validationFailure(`terminal native status is missing ${key}`);
    }
  }
  if (String(status?.uifailed || "") === "1") {
    return validationFailure("terminal native status reports a UI failure");
  }
  if (String(status?.visible404 || "") === "1") {
    return validationFailure("terminal native status reports a missing route");
  }
  if (String(status?.ui_run || "") !== runId) {
    return validationFailure("terminal native status belongs to another run");
  }
  if (String(status?.ui_plan || "") !== plan.digest) {
    return validationFailure("terminal native status has a different plan digest");
  }

  return {
    ok: true,
    optionalSkippedFlowIds: report.flows
      .filter((flow) => flow?.skipped === true)
      .filter((flow) => optionalIds.has(flow.id))
      .map((flow) => flow.id),
    conditionalRiaWorkspaceSkippedFlowIds: report.flows
      .filter((flow) => flow?.skipped === true)
      .filter(
        (flow) =>
          !optionalIds.has(flow.id) && conditionalRiaWorkspaceIds.has(flow.id),
      )
      .map((flow) => flow.id),
  };
}

export function nativeUiFlowStepTimeoutMs(flows, status = {}) {
  const flowId = String(status.ui_flow || "");
  const stepIndex = Number(status.ui_step);
  const flow = (flows || []).find((candidate) => candidate?.id === flowId);
  if (!flow || !Number.isInteger(stepIndex) || stepIndex < 0) {
    return 45_000;
  }
  const step = flow.steps?.[stepIndex];
  return Number(
    step?.timeoutMs ||
      flow.watchdog?.maxNoProgressMs ||
      flow.stepTimeoutMs ||
      30_000,
  );
}

export function advanceNativeUiCheckpoint({ flows, status, highestByFlow }) {
  const flowId = String(status?.ui_flow || "");
  const checkpoint = String(status?.ui_checkpoint || "");
  if (!flowId || !checkpoint) return { ok: true, advanced: false };
  const flow = (flows || []).find((candidate) => candidate?.id === flowId);
  const checkpoints = flow?.watchdog?.checkpoints || [];
  if (checkpoints.length === 0) return { ok: true, advanced: false };
  const index = checkpoints.indexOf(checkpoint);
  if (index < 0) {
    return { ok: false, advanced: false, reason: "unknown checkpoint" };
  }
  const previous = highestByFlow.get(flowId) ?? -1;
  if (index < previous) {
    return { ok: false, advanced: false, reason: "checkpoint regression" };
  }
  if (index > previous) {
    highestByFlow.set(flowId, index);
    return { ok: true, advanced: true };
  }
  return { ok: true, advanced: false };
}

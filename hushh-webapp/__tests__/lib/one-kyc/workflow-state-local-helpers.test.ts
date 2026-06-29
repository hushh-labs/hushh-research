import { describe, expect, it } from "vitest";

import {
  removeKycWorkflowLocalState,
  retainReadyKycWorkflowLocalState,
} from "@/lib/one-kyc/workflow-state";

import type { OneKycWorkflow } from "@/lib/services/one-kyc-service";

function makeReadyWorkflow(
  workflowId: string,
): OneKycWorkflow {
  return {
    workflow_id: workflowId,
    user_id: null,
    status: "waiting_on_user",
    draft_status: "ready",
    participant_emails: [],
    required_fields: [],
  };
}

function makeNotReadyWorkflow(
  workflowId: string,
): OneKycWorkflow {
  return {
    workflow_id: workflowId,
    user_id: null,
    status: "waiting_on_user",
    draft_status: "not_ready",
    participant_emails: [],
    required_fields: [],
  };
}

describe("removeKycWorkflowLocalState", () => {
  it("returns the same reference when the key is absent", () => {
    const state = { "wf-a": "value" };

    expect(
      removeKycWorkflowLocalState(
        state,
        "wf-b",
      ),
    ).toBe(state);
  });

  it("removes an existing key and returns a new object", () => {
    const state = {
      "wf-a": "value-a",
      "wf-b": "value-b",
    };

    const result =
      removeKycWorkflowLocalState(
        state,
        "wf-a",
      );

    expect(result).toEqual({
      "wf-b": "value-b",
    });

    expect(result).not.toBe(state);
  });

  it("does not mutate the original object", () => {
    const state = {
      "wf-a": "value-a",
      "wf-b": "value-b",
    };

    removeKycWorkflowLocalState(
      state,
      "wf-a",
    );

    expect(state).toEqual({
      "wf-a": "value-a",
      "wf-b": "value-b",
    });
  });
});

describe("retainReadyKycWorkflowLocalState", () => {
  it("returns the same reference when all entries are retained", () => {
    const state = {
      "wf-a": "value-a",
    };

    const workflows = [
      makeReadyWorkflow("wf-a"),
    ];

    expect(
      retainReadyKycWorkflowLocalState(
        state,
        workflows,
      ),
    ).toBe(state);
  });

  it("returns the same reference for empty state", () => {
    const state: Record<string, string> = {};

    expect(
      retainReadyKycWorkflowLocalState(
        state,
        [makeReadyWorkflow("wf-a")],
      ),
    ).toBe(state);
  });

  it("removes entries that are not draft ready", () => {
    const state = {
      "wf-a": "keep",
      "wf-b": "remove",
    };

    const result =
      retainReadyKycWorkflowLocalState(
        state,
        [
          makeReadyWorkflow("wf-a"),
          makeNotReadyWorkflow("wf-b"),
        ],
      );

    expect(result).toEqual({
      "wf-a": "keep",
    });

    expect(result).not.toBe(state);
  });

  it("removes orphan workflow ids", () => {
    expect(
      retainReadyKycWorkflowLocalState(
        { orphan: "value" },
        [],
      ),
    ).toEqual({});
  });

  it("treats missing draft status as not ready", () => {
    const workflow: OneKycWorkflow = {
      workflow_id: "wf-a",
      user_id: null,
      status: "waiting_on_user",
      draft_status: null,
      participant_emails: [],
      required_fields: [],
    };

    expect(
      retainReadyKycWorkflowLocalState(
        { "wf-a": "value" },
        [workflow],
      ),
    ).toEqual({});
  });

  it("does not mutate the original object", () => {
    const state = {
      "wf-a": "keep",
      "wf-b": "remove",
    };

    retainReadyKycWorkflowLocalState(
      state,
      [makeReadyWorkflow("wf-a")],
    );

    expect(state).toEqual({
      "wf-a": "keep",
      "wf-b": "remove",
    });
  });
});
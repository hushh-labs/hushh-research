import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConnectedSystemDirective } from "@/lib/agent/connected-system-directive-runtime";
import { ConnectedSystemsService } from "@/lib/services/connected-systems-service";

vi.mock("@/lib/services/connected-systems-service", () => ({
  ConnectedSystemsService: {
    listSystems: vi.fn(),
    getSchema: vi.fn(),
    getRecordBinding: vi.fn(),
    searchRecord: vi.fn(),
    readRecord: vi.fn(),
    createRecordIntent: vi.fn(),
    updateRecordIntent: vi.fn(),
    createDeleteIntent: vi.fn(),
    approveIntent: vi.fn(),
  },
}));

function expectNoCrmTransport() {
  expect(ConnectedSystemsService.listSystems).not.toHaveBeenCalled();
  expect(ConnectedSystemsService.getSchema).not.toHaveBeenCalled();
  expect(ConnectedSystemsService.getRecordBinding).not.toHaveBeenCalled();
  expect(ConnectedSystemsService.searchRecord).not.toHaveBeenCalled();
  expect(ConnectedSystemsService.readRecord).not.toHaveBeenCalled();
  expect(ConnectedSystemsService.createRecordIntent).not.toHaveBeenCalled();
  expect(ConnectedSystemsService.updateRecordIntent).not.toHaveBeenCalled();
  expect(ConnectedSystemsService.createDeleteIntent).not.toHaveBeenCalled();
  expect(ConnectedSystemsService.approveIntent).not.toHaveBeenCalled();
}

describe("runConnectedSystemDirective", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a reviewable lookup proposal without reading a CRM", async () => {
    const result = await runConnectedSystemDirective(
      {
        kind: "action",
        payload: {
          id: "call_read",
          type: "connected_system.crm.read",
          slots: { systemId: "brand-one", objectType: "Person" },
        },
      },
      "HCT:test",
      { email: "profile@example.com", phone: "+14155551212" },
    );

    expect(result).toEqual(
      expect.objectContaining({
        delegate_agent_id: "agent_connected_systems",
        status: "completed",
        detail: "No CRM record was read by the private agent.",
      }),
    );
    expect(result.display).toContain("Review the proposed lookup");
    expect(result.display).toContain("brand-one");
    expectNoCrmTransport();
  });

  it("returns a field-diff proposal without creating or approving an intent", async () => {
    const result = await runConnectedSystemDirective(
      {
        kind: "action",
        payload: {
          id: "call_update",
          type: "connected_system.crm.update.propose",
          slots: {
            systemId: "brand-two",
            additionalFieldsJson: JSON.stringify({ city: "New York" }),
          },
        },
      },
      "HCT:test",
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: "completed",
        detail: "No CRM record was changed by the private agent.",
      }),
    );
    expect(result.display).toContain("proposed 1 field change");
    expect(result.display).toContain("brand-two");
    expectNoCrmTransport();
  });

  it("never fans a proposal out when an all-systems scope is requested", async () => {
    const result = await runConnectedSystemDirective(
      {
        kind: "action",
        payload: {
          id: "call_all",
          type: "connected_system.crm.update.propose",
          slots: {
            scope: "all_connected_crm_systems",
            additionalFieldsJson: JSON.stringify({ city: "New York" }),
          },
        },
      },
      "HCT:test",
    );

    expect(result.status).toBe("completed");
    expect(result.display).toContain("the selected CRM");
    expectNoCrmTransport();
  });

  it("rejects an empty update proposal without calling a CRM", async () => {
    const result = await runConnectedSystemDirective(
      {
        kind: "action",
        payload: {
          id: "call_empty",
          type: "connected_system.crm.update.propose",
          slots: { additionalFieldsJson: "{}" },
        },
      },
      "HCT:test",
    );

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("at least one CRM field change");
    expectNoCrmTransport();
  });
});

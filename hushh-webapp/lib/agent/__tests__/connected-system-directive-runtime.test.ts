import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConnectedSystemDirective } from "@/lib/agent/connected-system-directive-runtime";
import { ConnectedSystemsService } from "@/lib/services/connected-systems-service";

vi.mock("@/lib/services/connected-systems-service", () => ({
  ConnectedSystemsService: {
    getRecordBinding: vi.fn(),
    searchRecord: vi.fn(),
    updateRecordIntent: vi.fn(),
    approveIntent: vi.fn(),
  },
}));

describe("runConnectedSystemDirective", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds a CRM record by email and phone before approving an inline update", async () => {
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      status: "unbound",
      binding: null,
    });
    vi.mocked(ConnectedSystemsService.searchRecord).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      resultClass: "succeeded",
      recordId: null,
      binding: {
        systemId: "salesforce-fsc-customer0",
        objectType: "Contact",
        recordId: "003ABC",
        status: "active",
      },
      mcp: { isError: false, payload: { Contact: [] } },
    });
    vi.mocked(ConnectedSystemsService.updateRecordIntent).mockResolvedValueOnce({
      intentId: "intent_123",
      systemId: "salesforce-fsc-customer0",
      action: "update",
      status: "pending",
      fieldNames: ["MailingCity"],
    });
    vi.mocked(ConnectedSystemsService.approveIntent).mockResolvedValueOnce({
      intentId: "intent_123",
      systemId: "salesforce-fsc-customer0",
      action: "update",
      status: "succeeded",
      fieldNames: ["MailingCity"],
      recordId: "003ABC",
    });

    const result = await runConnectedSystemDirective(
      {
        kind: "action",
        payload: {
          id: "call_1",
          type: "connected_system.crm.update.propose",
          slots: {
            systemId: "salesforce-fsc-customer0",
            objectType: "Contact",
            email: "kushal@example.com",
            phone: "415-555-1212",
            additionalFieldsJson: JSON.stringify({ MailingCity: "New York" }),
          },
        },
      },
      "HCT:test"
    );

    expect(ConnectedSystemsService.searchRecord).toHaveBeenCalledWith(
      "HCT:test",
      expect.objectContaining({
        email: "kushal@example.com",
        phone: "415-555-1212",
      })
    );
    expect(ConnectedSystemsService.updateRecordIntent).toHaveBeenCalledWith(
      "HCT:test",
      expect.objectContaining({
        id: "003ABC",
        additionalFields: { MailingCity: "New York" },
      })
    );
    expect(ConnectedSystemsService.approveIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultOwnerToken: "HCT:test",
        intentId: "intent_123",
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        delegate_agent_id: "agent_connected_systems",
        status: "completed",
      })
    );
  });

  it("uses profile lookup email and phone when slots do not include identity", async () => {
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      status: "unbound",
      binding: null,
    });
    vi.mocked(ConnectedSystemsService.searchRecord).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      resultClass: "succeeded",
      recordId: "003PROFILE",
      mcp: { isError: false, payload: { Contact: [] } },
    });
    vi.mocked(ConnectedSystemsService.updateRecordIntent).mockResolvedValueOnce({
      intentId: "intent_profile",
      systemId: "salesforce-fsc-customer0",
      action: "update",
      status: "pending",
      fieldNames: ["MailingCity"],
    });
    vi.mocked(ConnectedSystemsService.approveIntent).mockResolvedValueOnce({
      intentId: "intent_profile",
      systemId: "salesforce-fsc-customer0",
      action: "update",
      status: "succeeded",
      fieldNames: ["MailingCity"],
      recordId: "003PROFILE",
    });

    await runConnectedSystemDirective(
      {
        kind: "action",
        payload: {
          id: "call_profile",
          type: "connected_system.crm.update.propose",
          slots: {
            systemId: "salesforce-fsc-customer0",
            objectType: "Contact",
            additionalFieldsJson: JSON.stringify({ MailingCity: "New York" }),
          },
        },
      },
      "HCT:test",
      { email: "profile@example.com", phone: "+14155551212" }
    );

    expect(ConnectedSystemsService.searchRecord).toHaveBeenCalledWith(
      "HCT:test",
      expect.objectContaining({
        email: "profile@example.com",
        phone: "+14155551212",
      })
    );
  });

  it("uses the saved CRM binding before falling back to email and phone search", async () => {
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      status: "active",
      binding: {
        systemId: "salesforce-fsc-customer0",
        objectType: "Contact",
        recordId: "003BOUND",
        status: "active",
      },
    });
    vi.mocked(ConnectedSystemsService.updateRecordIntent).mockResolvedValueOnce({
      intentId: "intent_bound",
      systemId: "salesforce-fsc-customer0",
      action: "update",
      status: "pending",
      fieldNames: ["MailingCity"],
    });
    vi.mocked(ConnectedSystemsService.approveIntent).mockResolvedValueOnce({
      intentId: "intent_bound",
      systemId: "salesforce-fsc-customer0",
      action: "update",
      status: "succeeded",
      fieldNames: ["MailingCity"],
      recordId: "003BOUND",
    });

    await runConnectedSystemDirective(
      {
        kind: "action",
        payload: {
          id: "call_bound",
          type: "connected_system.crm.update.propose",
          slots: {
            systemId: "salesforce-fsc-customer0",
            objectType: "Contact",
            additionalFieldsJson: JSON.stringify({ MailingCity: "New York" }),
          },
        },
      },
      "HCT:test",
      { email: "profile@example.com", phone: "+14155551212" }
    );

    expect(ConnectedSystemsService.searchRecord).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.updateRecordIntent).toHaveBeenCalledWith(
      "HCT:test",
      expect.objectContaining({
        id: "003BOUND",
      })
    );
  });
});

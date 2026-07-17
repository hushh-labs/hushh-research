import { beforeEach, describe, expect, it, vi } from "vitest";

import { runConnectedSystemDirective } from "@/lib/agent/connected-system-directive-runtime";
import { ConnectedSystemsService } from "@/lib/services/connected-systems-service";

vi.mock("@/lib/services/connected-systems-service", () => ({
  ConnectedSystemsService: {
    listSystems: vi.fn(),
    readRecord: vi.fn(),
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

  it("reads a CRM record inline with profile email and phone", async () => {
    vi.mocked(ConnectedSystemsService.readRecord).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      resultClass: "succeeded",
      recordId: "003READ",
      binding: {
        systemId: "salesforce-fsc-customer0",
        objectType: "Contact",
        recordId: "003READ",
        status: "active",
      },
      mcp: {
        isError: false,
        payload: {
          Contact: [
            {
              Id: "003READ",
              FirstName: "Kushal",
              LastName: "Shah",
              Email: "profile@example.com",
              Phone: "+14155551212",
              MailingCity: "Las Vegas",
            },
          ],
        },
      },
    });

    const result = await runConnectedSystemDirective(
      {
        kind: "action",
        payload: {
          id: "call_read",
          type: "connected_system.crm.read",
          slots: {
            systemId: "salesforce-fsc-customer0",
            objectType: "Contact",
          },
        },
      },
      "HCT:test",
      { email: "profile@example.com", phone: "+14155551212" }
    );

    expect(ConnectedSystemsService.readRecord).toHaveBeenCalledWith(
      "HCT:test",
      expect.objectContaining({
        systemId: "salesforce-fsc-customer0",
        objectType: "Contact",
        email: "profile@example.com",
        phone: "+14155551212",
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        delegate_agent_id: "agent_connected_systems",
        status: "completed",
      })
    );
    expect(result.display).toContain("CRM record found:");
    expect(result.display).toContain("- Name: Kushal Shah");
    expect(result.display).toContain("- City: Las Vegas");
  });

  it("lists CRM records across connected brands", async () => {
    vi.mocked(ConnectedSystemsService.listSystems).mockResolvedValueOnce([
      {
        systemId: "brand-one",
        displayName: "Brand One",
        customerDisplayName: "Brand One",
        status: "connected",
        target: "One",
        objectTypeDefault: "Contact",
        transport: "external_crm_streamable_mcp",
        supportedActions: { read: true },
      },
      {
        systemId: "brand-two",
        displayName: "Brand Two",
        customerDisplayName: "Brand Two",
        status: "connected",
        target: "Two",
        objectTypeDefault: "Contact",
        transport: "external_crm_streamable_mcp",
        supportedActions: { read: true },
      },
    ]);
    vi.mocked(ConnectedSystemsService.readRecord)
      .mockResolvedValueOnce({
        systemId: "brand-one",
        target: "One",
        objectType: "Contact",
        resultClass: "succeeded",
        recordId: "003ONE",
        mcp: {
          isError: false,
          payload: {
            Contact: [
              {
                Id: "003ONE",
                FirstName: "Abdul",
                LastName: "Zalil",
                Email: "abdul.zalil@gmail.com",
                Phone: "4084690396",
                MailingCity: "Las Vegas",
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        systemId: "brand-two",
        target: "Two",
        objectType: "Contact",
        resultClass: "succeeded",
        recordId: "003TWO",
        mcp: {
          isError: false,
          payload: {
            Contact: [
              {
                Id: "003TWO",
                FirstName: "Abdul",
                LastName: "Zalil",
                Email: "abdul.zalil@gmail.com",
                Phone: "4084690396",
                MailingCity: "Chicago",
              },
            ],
          },
        },
      });

    const result = await runConnectedSystemDirective(
      {
        kind: "action",
        payload: {
          id: "call_read_all",
          type: "connected_system.crm.read",
          slots: {
            scope: "all_connected_crm_systems",
            objectType: "Contact",
          },
        },
      },
      "HCT:test",
      { email: "abdul.zalil@gmail.com", phone: "4084690396" }
    );

    expect(ConnectedSystemsService.listSystems).toHaveBeenCalledWith("HCT:test");
    expect(ConnectedSystemsService.readRecord).toHaveBeenCalledTimes(2);
    expect(ConnectedSystemsService.readRecord).toHaveBeenNthCalledWith(
      1,
      "HCT:test",
      expect.objectContaining({ systemId: "brand-one" })
    );
    expect(ConnectedSystemsService.readRecord).toHaveBeenNthCalledWith(
      2,
      "HCT:test",
      expect.objectContaining({ systemId: "brand-two" })
    );
    expect(result.status).toBe("completed");
    expect(result.display).toContain("Found records in 2 of 2 connected CRM brands.");
    expect(result.display).toContain("**Brand One**");
    expect(result.display).toContain("- Name: Abdul Zalil");
    expect(result.display).toContain("- City: Las Vegas");
    expect(result.display).toContain("**Brand Two**");
    expect(result.display).toContain("- City: Chicago");
  });

  it("returns a reviewable CRM update proposal without looking up or approving a record", async () => {
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

    expect(ConnectedSystemsService.searchRecord).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.updateRecordIntent).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.approveIntent).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        delegate_agent_id: "agent_connected_systems",
        status: "completed",
      })
    );
    expect(result.display).toContain("Review the proposed 1 field change");
    expect(result.detail).toBe("No CRM record was changed by the private agent.");
  });

  it("does not use profile identity to execute a proposed update", async () => {
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

    const result = await runConnectedSystemDirective(
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

    expect(ConnectedSystemsService.getRecordBinding).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.searchRecord).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.updateRecordIntent).not.toHaveBeenCalled();
    expect(result.detail).toBe("No CRM record was changed by the private agent.");
  });

  it("does not inspect a saved CRM binding for a private-agent proposal", async () => {
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

    expect(ConnectedSystemsService.getRecordBinding).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.searchRecord).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.updateRecordIntent).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.approveIntent).not.toHaveBeenCalled();
  });

  it("never fans a private-agent proposal out to every connected CRM", async () => {
    vi.mocked(ConnectedSystemsService.listSystems).mockResolvedValueOnce([
      {
        systemId: "brand-bound",
        displayName: "Bound Brand",
        customerDisplayName: "Bound Brand",
        status: "connected",
        target: "Bound",
        objectTypeDefault: "Contact",
        transport: "external_crm_streamable_mcp",
        supportedActions: { update: true },
      },
      {
        systemId: "brand-search",
        displayName: "Search Brand",
        customerDisplayName: "Search Brand",
        status: "connected",
        target: "Search",
        objectTypeDefault: "Contact",
        transport: "external_crm_streamable_mcp",
        supportedActions: { update: true },
      },
    ]);
    vi.mocked(ConnectedSystemsService.getRecordBinding)
      .mockResolvedValueOnce({
        systemId: "brand-bound",
        target: "Bound",
        objectType: "Contact",
        status: "active",
        binding: {
          systemId: "brand-bound",
          objectType: "Contact",
          recordId: "003BOUND",
          status: "active",
        },
      })
      .mockResolvedValueOnce({
        systemId: "brand-search",
        target: "Search",
        objectType: "Contact",
        status: "unbound",
        binding: null,
      });
    vi.mocked(ConnectedSystemsService.searchRecord).mockResolvedValueOnce({
      systemId: "brand-search",
      target: "Search",
      objectType: "Contact",
      resultClass: "succeeded",
      recordId: "003SEARCH",
      mcp: { isError: false, payload: { Contact: [] } },
    });
    vi.mocked(ConnectedSystemsService.updateRecordIntent)
      .mockResolvedValueOnce({
        intentId: "intent_bound",
        systemId: "brand-bound",
        action: "update",
        status: "pending",
        fieldNames: ["MailingCity"],
      })
      .mockResolvedValueOnce({
        intentId: "intent_search",
        systemId: "brand-search",
        action: "update",
        status: "pending",
        fieldNames: ["MailingCity"],
      });
    vi.mocked(ConnectedSystemsService.approveIntent)
      .mockResolvedValueOnce({
        intentId: "intent_bound",
        systemId: "brand-bound",
        action: "update",
        status: "succeeded",
        fieldNames: ["MailingCity"],
        recordId: "003BOUND",
      })
      .mockResolvedValueOnce({
        intentId: "intent_search",
        systemId: "brand-search",
        action: "update",
        status: "succeeded",
        fieldNames: ["MailingCity"],
        recordId: "003SEARCH",
      });

    const result = await runConnectedSystemDirective(
      {
        kind: "action",
        payload: {
          id: "call_all",
          type: "connected_system.crm.update.propose",
          slots: {
            scope: "all_connected_crm_systems",
            objectType: "Contact",
            additionalFieldsJson: JSON.stringify({ MailingCity: "New York" }),
          },
        },
      },
      "HCT:test",
      { email: "profile@example.com", phone: "+14155551212" }
    );

    expect(ConnectedSystemsService.listSystems).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.getRecordBinding).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.searchRecord).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.updateRecordIntent).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.approveIntent).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.display).toContain("before anything is sent to a CRM");
    expect(result.detail).toBe("No CRM record was changed by the private agent.");
  });
});

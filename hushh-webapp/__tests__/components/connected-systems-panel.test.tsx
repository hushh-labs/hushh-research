import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectedSystemsPanel } from "@/components/profile/connected-systems-panel";
import { ConnectedSystemsService } from "@/lib/services/connected-systems-service";

vi.mock("@/lib/services/connected-systems-service", () => ({
  SALESFORCE_CRM_SYSTEM_ID: "salesforce-fsc-customer0",
  ConnectedSystemsService: {
    listSystems: vi.fn().mockResolvedValue([
      {
        systemId: "salesforce-fsc-customer0",
        displayName: "Macy's",
        customerDisplayName: "Macy's",
        systemType: "Salesforce",
        systemName: "FSC",
        status: "connected",
        target: "Macys",
        objectTypeDefault: "Contact",
        transport: "external_crm_streamable_mcp",
        transportLabel: "External CRM MCP",
        endpointConfigured: true,
        registrySource: "customer0_connected_system_registry",
        toolCatalog: [
          { name: "object-schema", operation: "schema" },
          { name: "read-crm-record", operation: "read" },
          { name: "create-crm-record", operation: "create" },
          { name: "update-crm-record", operation: "update" },
          { name: "delete-crm-record", operation: "delete" },
        ],
        supportedActions: {
          schema: true,
          read: true,
          create: true,
          update: true,
          delete: true,
        },
        fieldAllowlist: ["Email", "Phone", "LastName", "MailingCity"],
      },
    ]),
    getRecordBinding: vi.fn().mockResolvedValue({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      status: "unbound",
      binding: null,
    }),
    getSchema: vi.fn().mockResolvedValue({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      supportedFields: ["Email", "Phone", "MobilePhone", "LastName", "MailingCity"],
      fields: [
        { key: "Email", name: "Email", label: "Email", dataType: "email", identityField: true },
        { key: "Phone", name: "Phone", label: "Phone", dataType: "phone", identityField: true },
        {
          key: "MobilePhone",
          name: "MobilePhone",
          label: "Mobile number",
          dataType: "phone",
        },
        { key: "LastName", name: "LastName", label: "Last name", required: true },
        { key: "MailingCity", name: "MailingCity", label: "Mailing city" },
      ],
      mcp: {
        isError: false,
        payload: { fields: ["Email", "Phone", "MobilePhone", "LastName", "MailingCity"] },
      },
    }),
    searchRecord: vi.fn().mockResolvedValue({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      resultClass: "succeeded",
      recordId: null,
      bindingStatus: "unbound",
      binding: null,
      mcp: { isError: false, payload: { Contact: [] } },
    }),
    readRecord: vi.fn().mockResolvedValue({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      resultClass: "succeeded",
      recordId: null,
      mcp: { isError: false, payload: { Contact: [] } },
    }),
    createRecordIntent: vi.fn(),
    updateRecordIntent: vi.fn(),
    approveIntent: vi.fn(),
    deleteRecord: vi.fn(),
  },
}));

describe("ConnectedSystemsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a list-first CRM entrypoint for the connected systems route", async () => {
    render(<ConnectedSystemsPanel vaultOwnerToken="HCT:test" mode="list" />);

    await waitFor(() => {
      expect(screen.getByText("Macy's")).toBeTruthy();
    });

    const crmLink = screen.getByRole("link", { name: /Macy's/i });
    expect(crmLink.getAttribute("href")).toBe(
      "/one/connected-systems/salesforce-fsc-customer0",
    );
    expect(screen.getByRole("searchbox", { name: /Search CRM systems/i })).toBeTruthy();
    expect(screen.getByText(/Macy's \/ Contact \/ External CRM MCP/)).toBeTruthy();
    expect(screen.getByText("5 MCP tools")).toBeTruthy();
    expect(screen.getByAltText("Macy's logo")).toBeTruthy();
    expect(screen.getByAltText("Salesforce FSC logo")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Refresh from Macy's/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Suggest a sample change/i })).toBeNull();
  });

  it("renders Macy's as a connected CRM system with a first-time create lifecycle", async () => {
    render(
      <ConnectedSystemsPanel
        vaultOwnerToken="HCT:test"
        profile={{
          displayName: "Kushal Trivedi",
          email: "kushal@example.com",
          phone: "4155551212",
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/Salesforce FSC \/ Contact\./)).toBeTruthy();
    });

    expect(screen.getByRole("heading", { name: "Macy's" })).toBeTruthy();
    expect(screen.getByText(/Salesforce FSC \/ Contact/)).toBeTruthy();
    expect(screen.getByAltText("Macy's logo")).toBeTruthy();
    expect(screen.getByAltText("Salesforce FSC logo")).toBeTruthy();
    expect(screen.getByText(/Connected through External CRM MCP/)).toBeTruthy();
    expect(screen.getByText(/5 MCP tools/)).toBeTruthy();
    expect(screen.queryByText("Registry backed")).toBeNull();
    expect(screen.queryByText(/My Macy's Contact/i)).toBeNull();
    expect(screen.queryByText(/No CRM record is connected/i)).toBeNull();
    expect(screen.queryByText(/Record ID 003gK00000jlmaLQAQ/)).toBeNull();
    expect(screen.queryByDisplayValue("maria.joe@abc.com")).toBeNull();
    expect(screen.queryByDisplayValue("123456789")).toBeNull();
    expect(await screen.findByText("Registered email")).toBeTruthy();
    expect(screen.getByText("kushal@example.com")).toBeTruthy();
    expect(screen.getByText("Registered phone")).toBeTruthy();
    expect(screen.getByText("4155551212")).toBeTruthy();
    expect(screen.queryByText("CRM lookup email")).toBeNull();
    expect(screen.queryByText("CRM lookup phone")).toBeNull();
    await waitFor(() => {
      expect(screen.getByText("Mobile number")).toBeTruthy();
    });
    expect(screen.getAllByText(/Mailing city/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Stored CRM information/i)).toBeNull();
    expect(screen.getByText("Find existing record")).toBeTruthy();
    expect(screen.getByText("Create my Macy's record")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Find my record/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Suggest sample details/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Suggest a sample change/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Create record/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Approve$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Random new Contact/i })).toBeNull();
    expect(screen.queryByText(/Delete Macy's Contact/i)).toBeNull();
  });

  it("waits for the saved CRM binding before showing create actions", async () => {
    let resolveBinding!: (value: Awaited<ReturnType<typeof ConnectedSystemsService.getRecordBinding>>) => void;
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBinding = resolve;
      }) as ReturnType<typeof ConnectedSystemsService.getRecordBinding>
    );

    render(
      <ConnectedSystemsPanel
        vaultOwnerToken="HCT:test"
        profile={{
          displayName: "Kushal Trivedi",
          email: "kushal@example.com",
          phone: "4155551212",
        }}
      />
    );

    expect(await screen.findByText("Looking for your saved CRM record")).toBeTruthy();
    expect(screen.queryByText("Create my Macy's record")).toBeNull();
    expect(screen.queryByText("Find existing record")).toBeNull();

    resolveBinding({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      status: "active",
      binding: {
        bindingId: "csb_existing",
        systemId: "salesforce-fsc-customer0",
        target: "Macys",
        objectType: "Contact",
        recordId: "003gK00000existingQAA",
        status: "active",
      },
    });

    expect(await screen.findByText("Update my Macy's information")).toBeTruthy();
    expect(screen.queryByText("Create my Macy's record")).toBeNull();
    expect(screen.queryByText("Find existing record")).toBeNull();
  });

  it("refreshes CRM record details without an id search field", async () => {
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      status: "active",
      binding: {
        bindingId: "csb_bound",
        systemId: "salesforce-fsc-customer0",
        target: "Macys",
        objectType: "Contact",
        recordId: "003gK00000boundQAA",
        status: "active",
      },
    });
    vi.mocked(ConnectedSystemsService.readRecord).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      resultClass: "succeeded",
      recordId: "003gK00000boundQAA",
      binding: {
        bindingId: "csb_bound",
        systemId: "salesforce-fsc-customer0",
        target: "Macys",
        objectType: "Contact",
        recordId: "003gK00000boundQAA",
        status: "active",
      },
      mcp: {
        isError: false,
        payload: {
          Contact: [
            {
              Id: "003gK00000boundQAA",
              Email: "kushal@example.com",
              Phone: "4155551212",
              LastName: "Trivedi",
              MailingCity: "New York",
            },
          ],
        },
      },
    });

    render(
      <ConnectedSystemsPanel
        vaultOwnerToken="HCT:test"
        profile={{
          displayName: "Kushal Trivedi",
          email: "kushal@example.com",
          phone: "4155551212",
        }}
      />
    );

    expect(await screen.findByText("Update my Macy's information")).toBeTruthy();
    await waitFor(() => {
      expect(ConnectedSystemsService.readRecord).toHaveBeenCalledWith(
        "HCT:test",
        expect.objectContaining({
          email: "kushal@example.com",
          phone: "4155551212",
        })
      );
      expect(
        vi.mocked(ConnectedSystemsService.readRecord).mock.calls[0]?.[1].searchFields
      ).toBeUndefined();
    });
    expect(await screen.findByDisplayValue("New York")).toBeTruthy();
    expect(screen.queryByText("Create my Macy's record")).toBeNull();
  });

  it("keeps the CRM lifecycle visible when binding storage is not ready", async () => {
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockRejectedValueOnce(
      new Error("Connected Systems workflow storage is not ready.")
    );

    render(
      <ConnectedSystemsPanel
        vaultOwnerToken="HCT:test"
        profile={{
          displayName: "Kushal Trivedi",
          email: "kushal@example.com",
          phone: "4155551212",
        }}
      />
    );

    expect(await screen.findByText("Find existing record")).toBeTruthy();
    expect(screen.queryByText(/Record linking is still being prepared/i)).toBeNull();
    expect(screen.queryByText(/Record linking is temporarily unavailable/i)).toBeNull();
    expect(screen.queryByText("Connected Systems workflow storage is not ready.")).toBeNull();
    expect(screen.getByText("Create my Macy's record")).toBeTruthy();
  });

  it("fills sample create details without changing registered lookup fields", async () => {
    render(
      <ConnectedSystemsPanel
        vaultOwnerToken="HCT:test"
        profile={{
          displayName: "Kushal Trivedi",
          email: "kushal@example.com",
          phone: "4155551212",
        }}
      />
    );

    await screen.findByRole("button", { name: /Suggest sample details/i });
    fireEvent.click(screen.getByRole("button", { name: /Suggest sample details/i }));

    await waitFor(() => {
      expect((screen.getByDisplayValue("kushal@example.com") as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByDisplayValue("4155551212") as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByDisplayValue(/\(415\) 555-1212/)).toBeTruthy();
      expect(screen.getByDisplayValue(/New York|Chicago|San Francisco|Atlanta/)).toBeTruthy();
      expect((screen.getByRole("button", { name: /Create record/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("surfaces failed create intent messages without rendering audit field metadata", async () => {
    vi.mocked(ConnectedSystemsService.createRecordIntent).mockResolvedValueOnce({
      intentId: "csi_create_failed",
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      action: "create",
      status: "pending",
      fieldNames: ["Email", "Phone", "LastName"],
    });
    vi.mocked(ConnectedSystemsService.approveIntent).mockResolvedValueOnce({
      intentId: "csi_create_failed",
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      action: "create",
      status: "failed",
      recordId: null,
      fieldNames: ["Email", "Phone", "LastName"],
      errorMessage: "Salesforce rejected the create request.",
    });

    render(
      <ConnectedSystemsPanel
        vaultOwnerToken="HCT:test"
        profile={{
          displayName: "Kushal Trivedi",
          email: "kushal@example.com",
          phone: "4155551212",
        }}
      />
    );

    await screen.findByRole("button", { name: /Create record/i });
    fireEvent.click(screen.getByRole("button", { name: /Create record/i }));

    expect(await screen.findByText("Salesforce rejected the create request.")).toBeTruthy();
    expect(screen.queryByText("Last update")).toBeNull();
    expect(screen.queryByText(/Create result/i)).toBeNull();
    expect(screen.queryByText(/Fields: Email/i)).toBeNull();
  });

  it("switches to update and delete mode after a created CRM record is bound", async () => {
    vi.mocked(ConnectedSystemsService.createRecordIntent).mockResolvedValueOnce({
      intentId: "csi_create_succeeded",
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      action: "create",
      status: "pending",
      fieldNames: ["Email", "Phone", "LastName"],
    });
    vi.mocked(ConnectedSystemsService.approveIntent).mockResolvedValueOnce({
      intentId: "csi_create_succeeded",
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      action: "create",
      status: "succeeded",
      recordId: "003gK00000createdQAA",
      fieldNames: ["Email", "Phone", "LastName"],
      binding: {
        bindingId: "csb_created",
        systemId: "salesforce-fsc-customer0",
        target: "Macys",
        objectType: "Contact",
        recordId: "003gK00000createdQAA",
        status: "active",
        createdIntentId: "csi_create_succeeded",
        lastIntentId: "csi_create_succeeded",
      },
    });

    render(
      <ConnectedSystemsPanel
        vaultOwnerToken="HCT:test"
        profile={{
          displayName: "Kushal Trivedi",
          email: "kushal@example.com",
          phone: "4155551212",
        }}
      />
    );

    await screen.findByRole("button", { name: /Create record/i });
    fireEvent.click(screen.getByRole("button", { name: /Create record/i }));

    expect(await screen.findByText("Update my Macy's information")).toBeTruthy();
    expect(screen.queryByText("Find existing record")).toBeNull();
    expect(screen.queryByText("Create my Macy's record")).toBeNull();
    expect(screen.getByText("Delete record")).toBeTruthy();
    expect(screen.getAllByText(/003gK00000createdQAA/).length).toBeGreaterThan(0);
  });

  it("stays bound after create when silent readback returns no binding", async () => {
    vi.mocked(ConnectedSystemsService.createRecordIntent).mockResolvedValueOnce({
      intentId: "csi_create_record_id_only",
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      action: "create",
      status: "pending",
      fieldNames: ["Email", "Phone", "LastName"],
    });
    vi.mocked(ConnectedSystemsService.approveIntent).mockResolvedValueOnce({
      intentId: "csi_create_record_id_only",
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      action: "create",
      status: "succeeded",
      recordId: "003gK00000recordOnlyQAA",
      fieldNames: ["Email", "Phone", "LastName"],
      binding: null,
    });
    vi.mocked(ConnectedSystemsService.readRecord).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      resultClass: "succeeded",
      recordId: null,
      mcp: { isError: false, payload: { Contact: [] } },
    });

    render(
      <ConnectedSystemsPanel
        vaultOwnerToken="HCT:test"
        profile={{
          displayName: "Kushal Trivedi",
          email: "kushal@example.com",
          phone: "4155551212",
        }}
      />
    );

    await screen.findByRole("button", { name: /Create record/i });
    fireEvent.click(screen.getByRole("button", { name: /Create record/i }));

    expect(await screen.findByText("Update my Macy's information")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Find existing record")).toBeNull();
      expect(screen.queryByText("Create my Macy's record")).toBeNull();
      expect(screen.getByText("Delete record")).toBeTruthy();
      expect(screen.getAllByText(/003gK00000recordOnlyQAA/).length).toBeGreaterThan(0);
    });
  });

  it("auto-links an existing CRM record by registered profile lookup and shows delete", async () => {
    vi.mocked(ConnectedSystemsService.searchRecord).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      resultClass: "succeeded",
      recordId: "003gK00000linkedQAA",
      bindingStatus: "active",
      binding: {
        bindingId: "csb_linked",
        systemId: "salesforce-fsc-customer0",
        target: "Macys",
        objectType: "Contact",
        recordId: "003gK00000linkedQAA",
        status: "active",
      },
      mcp: {
        isError: false,
        payload: {
          Contact: [
            {
              Id: "003gK00000linkedQAA",
              Email: "kushal@example.com",
              Phone: "4155551212",
              LastName: "Trivedi",
              MailingCity: "Dallas",
            },
          ],
        },
      },
    });

    render(
      <ConnectedSystemsPanel
        vaultOwnerToken="HCT:test"
        profile={{
          displayName: "Kushal Trivedi",
          email: "kushal@example.com",
          phone: "4155551212",
        }}
      />
    );

    expect(await screen.findByText("Update my Macy's information")).toBeTruthy();
    expect(screen.queryByText("Find existing record")).toBeNull();
    expect(screen.queryByText("Create my Macy's record")).toBeNull();
    expect(screen.getByText("Delete record")).toBeTruthy();
    expect(screen.getAllByText(/003gK00000linkedQAA/).length).toBeGreaterThan(0);
    expect(ConnectedSystemsService.searchRecord).toHaveBeenCalledWith(
      "HCT:test",
      expect.objectContaining({
        email: "kushal@example.com",
        phone: "4155551212",
      })
    );
  });
});

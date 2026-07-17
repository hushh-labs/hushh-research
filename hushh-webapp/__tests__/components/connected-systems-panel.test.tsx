import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectedSystemsPanel } from "@/components/profile/connected-systems-panel";
import { ConnectedSystemsService } from "@/lib/services/connected-systems-service";

const routerPushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: vi.fn().mockResolvedValue("firebase-id-token"),
  },
}));

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

  it("renders the CRM overview as responsive inset rows with name, type, and status", async () => {
    render(<ConnectedSystemsPanel vaultOwnerToken="HCT:test" mode="list" />);

    await waitFor(() => {
      expect(screen.getByText("Macy's")).toBeTruthy();
    });

    expect(screen.getByText("Available systems")).toBeTruthy();
    expect(screen.getByText("Salesforce FSC")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByAltText("Macy's logo")).toBeTruthy();
    // No redundant chrome: no explainer copy, no Connected CRM badge, no
    // per-row transport subheader.
    expect(screen.queryByText(/Open a connected system to inspect/i)).toBeNull();
    expect(screen.queryByText("Connected CRM")).toBeNull();
    expect(screen.queryByText(/Macy's \/ Contact \/ External CRM MCP/)).toBeNull();
    expect(screen.queryByAltText("CRM platform logo")).toBeNull();
  });

  it("navigates to the system workspace when a table row is clicked", async () => {
    render(<ConnectedSystemsPanel vaultOwnerToken="HCT:test" mode="list" />);

    const nameCell = await screen.findByText("Macy's");
    fireEvent.click(nameCell);

    expect(routerPushMock).toHaveBeenCalledWith(
      "/one/connected-systems/salesforce-fsc-customer0",
    );
  });

  it("lists CRM systems without requiring vault unlock", async () => {
    render(<ConnectedSystemsPanel vaultOwnerToken={null} mode="list" />);

    await waitFor(() => {
      expect(screen.getByText("Macy's")).toBeTruthy();
    });
    expect(ConnectedSystemsService.listSystems).toHaveBeenCalledWith("firebase-id-token");
    expect(screen.queryByText(/Unlock your vault/i)).toBeNull();
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
    expect(screen.getByAltText("Macy's logo")).toBeTruthy();
    expect(screen.queryByAltText("CRM platform logo")).toBeNull();
    expect(screen.getByText(/Connected through External CRM MCP/)).toBeTruthy();
    expect(screen.queryByText(/MCP tools/i)).toBeNull();
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
    expect(screen.getByText("Link my Macy's record")).toBeTruthy();
    expect(screen.queryByText("Find existing record")).toBeNull();
    expect(screen.queryByText("Create my Macy's record")).toBeNull();
    expect(screen.getByRole("button", { name: /Suggest sample details/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Suggest a sample change/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Link this system/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Find my record$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Create record$/i })).toBeNull();
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
    expect(screen.queryByText("Link my Macy's record")).toBeNull();

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
    expect(screen.queryByText("Link my Macy's record")).toBeNull();
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

    expect(await screen.findByText("Link my Macy's record")).toBeTruthy();
    expect(screen.queryByText(/Record linking is still being prepared/i)).toBeNull();
    expect(screen.queryByText(/Record linking is temporarily unavailable/i)).toBeNull();
    expect(screen.queryByText("Connected Systems workflow storage is not ready.")).toBeNull();
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
      expect((screen.getByRole("button", { name: /Link this system/i }) as HTMLButtonElement).disabled).toBe(false);
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
      errorMessage: "CRM rejected the create request.",
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

    await screen.findByRole("button", { name: /Link this system/i });
    fireEvent.click(screen.getByRole("button", { name: /Link this system/i }));

    expect(await screen.findByText("CRM rejected the create request.")).toBeTruthy();
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

    await screen.findByRole("button", { name: /Link this system/i });
    fireEvent.click(screen.getByRole("button", { name: /Link this system/i }));

    expect(await screen.findByText("Update my Macy's information")).toBeTruthy();
    expect(screen.queryByText("Link my Macy's record")).toBeNull();
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

    await screen.findByRole("button", { name: /Link this system/i });
    fireEvent.click(screen.getByRole("button", { name: /Link this system/i }));

    expect(await screen.findByText("Update my Macy's information")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Link my Macy's record")).toBeNull();
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

  it("uses Agent One email and phone slots to find the CRM record before proposing updates", async () => {
    vi.mocked(ConnectedSystemsService.searchRecord).mockResolvedValueOnce({
      systemId: "salesforce-fsc-customer0",
      target: "Macys",
      objectType: "Contact",
      resultClass: "succeeded",
      recordId: "003gK00000agentQAA",
      bindingStatus: "active",
      binding: {
        bindingId: "csb_agent",
        systemId: "salesforce-fsc-customer0",
        target: "Macys",
        objectType: "Contact",
        recordId: "003gK00000agentQAA",
        status: "active",
      },
      mcp: {
        isError: false,
        payload: {
          Contact: [
            {
              Id: "003gK00000agentQAA",
              Email: "agent@example.com",
              Phone: "415-555-1212",
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
        mode="detail"
        systemId="salesforce-fsc-customer0"
        profile={{
          displayName: "Kushal Trivedi",
        }}
        agentInstruction={{
          actionId: "connected_system.crm.update.propose",
          slots: {
            systemId: "salesforce-fsc-customer0",
            email: "agent@example.com",
            phone: "415-555-1212",
            additionalFieldsJson: JSON.stringify({ MailingCity: "New York" }),
          },
        }}
      />
    );

    expect(await screen.findByText("Update my Macy's information")).toBeTruthy();
    await waitFor(() => {
      expect(ConnectedSystemsService.searchRecord).toHaveBeenCalledWith(
        "HCT:test",
        expect.objectContaining({
          email: "agent@example.com",
          phone: "415-555-1212",
          returnFields: expect.arrayContaining(["Email", "Phone"]),
        })
      );
    });
    expect(await screen.findByDisplayValue("New York")).toBeTruthy();
  });
});

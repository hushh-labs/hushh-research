import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectedSystemsPanel } from "@/components/profile/connected-systems-panel";
import { ConnectedSystemsService } from "@/lib/services/connected-systems-service";

const routerPushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: vi.fn().mockResolvedValue("firebase-id-token") },
}));

vi.mock("@/lib/services/connected-systems-service", () => ({
  ConnectedSystemsService: {
    listSystems: vi.fn(),
    getSchema: vi.fn(),
    getRecordBinding: vi.fn(),
    readRecord: vi.fn(),
    searchRecord: vi.fn(),
    createRecordIntent: vi.fn(),
    updateRecordIntent: vi.fn(),
    approveIntent: vi.fn(),
    rejectIntent: vi.fn(),
    createDeleteIntent: vi.fn(),
  },
}));

const system = {
  systemId: "customer-crm",
  displayName: "Customer CRM",
  customerDisplayName: "Customer CRM",
  systemType: "Example",
  systemName: "CRM",
  status: "connected",
  target: "Customer CRM",
  objectTypeDefault: "Person",
  transport: "external_crm_streamable_mcp",
  transportLabel: "External CRM MCP",
  endpointConfigured: true,
  registrySource: "enterprise_crm_registry",
  supportedActions: { schema: true, read: false, create: false, update: false, delete: false },
};

const metadataOnlySchema = {
  systemId: system.systemId,
  target: system.target,
  objectType: system.objectTypeDefault,
  supportedFields: ["Email", "PreferredLanguage", "Birthdate"],
  schemaStatus: "capability_metadata_missing",
  effectiveActions: { schema: true, read: false, create: false, update: false, delete: false },
  configurationMessage: "This connected system needs an update before its fields can be used.",
  fields: [
    { key: "Email", name: "Email", label: "Email", dataType: "email", required: false, readable: false, createable: false, updateable: false, immutable: false, identityField: false, permissionsDeclared: false },
    { key: "PreferredLanguage", name: "PreferredLanguage", label: "Preferred language", dataType: "picklist", required: false, readable: false, createable: false, updateable: false, immutable: false, identityField: false, permissionsDeclared: false, constraints: { allowedValues: ["English", "French"] } },
    { key: "Birthdate", name: "Birthdate", label: "Birth date", dataType: "date", required: false, readable: false, createable: false, updateable: false, immutable: false, identityField: false, permissionsDeclared: false },
  ],
};

const readySchema = {
  ...metadataOnlySchema,
  schemaStatus: "ready",
  effectiveActions: { schema: true, read: true, create: true, update: true, delete: true },
  fields: [
    { key: "Email", name: "Email", label: "Email", dataType: "email", required: true, readable: true, createable: true, updateable: false, immutable: true, identityField: true, permissionsDeclared: true },
    { key: "PreferredLanguage", name: "PreferredLanguage", label: "Preferred language", dataType: "picklist", required: false, readable: true, createable: true, updateable: true, immutable: false, identityField: false, permissionsDeclared: true, constraints: { allowedValues: ["English", "French"] } },
  ],
};

describe("ConnectedSystemsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ConnectedSystemsService.listSystems).mockResolvedValue([system]);
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValue(metadataOnlySchema);
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockResolvedValue({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      status: "unbound",
      binding: null,
    });
    vi.mocked(ConnectedSystemsService.readRecord).mockResolvedValue({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      resultClass: "succeeded",
      records: [],
    });
  });

  it("lists dynamically registered CRM systems without requiring vault unlock", async () => {
    render(<ConnectedSystemsPanel vaultOwnerToken={null} mode="list" />);

    expect(await screen.findByText("Customer CRM")).toBeTruthy();
    expect(screen.getByText("Example CRM")).toBeTruthy();
    fireEvent.click(screen.getByText("Customer CRM"));
    expect(routerPushMock).toHaveBeenCalledWith("/one/connected-systems/customer-crm");
  });

  it("renders a searchable, paginated schema catalogue and blocks incomplete CRM actions", async () => {
    const fields = Array.from({ length: 139 }, (_, index) => ({
      key: `Field${index + 1}`,
      name: `Field${index + 1}`,
      label: `Field ${index + 1}`,
      dataType: "string",
      required: false,
      readable: false,
      createable: false,
      updateable: false,
      immutable: false,
      identityField: false,
      permissionsDeclared: false,
    }));
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce({
      ...metadataOnlySchema,
      supportedFields: fields.map((field) => field.key),
      fields,
    });
    render(<ConnectedSystemsPanel vaultOwnerToken="HCT:test" systemId={system.systemId} />);

    expect(await screen.findByText("Customer CRM field catalogue")).toBeTruthy();
    expect(screen.getByText(/Configuration update required/)).toBeTruthy();
    expect(screen.getByPlaceholderText("Search fields")).toBeTruthy();
    expect(screen.getAllByText("not declared")).toHaveLength(16);
    expect(screen.getByText("Showing 1-16 of 139")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search fields"), { target: { value: "Field 139" } });
    await waitFor(() => expect(screen.getByText("Field 139")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Link this system/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Update record$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete$/i })).toBeNull();
    expect(ConnectedSystemsService.readRecord).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.createRecordIntent).not.toHaveBeenCalled();
  });

  it("keeps a ready schema display-only when record operation mappings are unavailable", async () => {
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce({
      ...readySchema,
      effectiveActions: { schema: true, read: false, create: false, update: false, delete: false },
    });
    render(<ConnectedSystemsPanel vaultOwnerToken="HCT:test" systemId={system.systemId} />);

    expect(await screen.findByText("Customer CRM field catalogue")).toBeTruthy();
    expect(
      screen.getByText(/does not currently have a complete registered record-operation contract/i),
    ).toBeTruthy();
    expect(screen.getByText("Preferred language")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Link this system/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Update record$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete$/i })).toBeNull();
  });

  it("uses normalized records and stages one explicitly updateable field for confirmation", async () => {
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce(readySchema);
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockResolvedValueOnce({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      status: "active",
      binding: {
        systemId: system.systemId,
        objectType: system.objectTypeDefault,
        recordId: "person-42",
        status: "active",
      },
    });
    vi.mocked(ConnectedSystemsService.readRecord).mockResolvedValueOnce({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      resultClass: "succeeded",
      recordId: "person-42",
      records: [{ recordId: "person-42", fields: { Email: "person@example.test", PreferredLanguage: "English" } }],
    });
    vi.mocked(ConnectedSystemsService.updateRecordIntent).mockResolvedValueOnce({
      intentId: "intent-42",
      systemId: system.systemId,
      action: "update",
      status: "pending",
      fieldNames: ["PreferredLanguage"],
    });

    render(
      <ConnectedSystemsPanel
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
        profile={{ email: "person@example.test" }}
      />,
    );

    expect(await screen.findByText("Update my Customer CRM information")).toBeTruthy();
    expect(await screen.findByText("English")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("combobox");
    fireEvent.change(editor, { target: { value: "French" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage change" }));
    fireEvent.click(screen.getByRole("button", { name: "Update record" }));

    await waitFor(() => {
      expect(ConnectedSystemsService.updateRecordIntent).toHaveBeenCalledWith(
        "HCT:test",
        expect.objectContaining({
          id: "person-42",
          recordFields: { PreferredLanguage: "French" },
        }),
      );
    });
    expect(await screen.findByText("Review update request")).toBeTruthy();
    expect(screen.getByText("PreferredLanguage")).toBeTruthy();
  });
});

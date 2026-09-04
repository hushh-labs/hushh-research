import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConnectedSystemLogo,
  ConnectedSystemsPanel,
} from "@/components/profile/connected-systems-panel";
import {
  ConnectedSystemsRequestError,
  ConnectedSystemsService,
} from "@/lib/services/connected-systems-service";
import {
  CACHE_KEYS,
  CACHE_TTL,
  CacheService,
} from "@/lib/services/cache-service";
import { ConnectedSystemsResourceService } from "@/lib/services/connected-systems-resource-service";

const routerPushMock = vi.fn();
const routerMock = {
  push: routerPushMock,
  replace: vi.fn(),
  prefetch: vi.fn(),
  back: vi.fn(),
};

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: vi.fn().mockResolvedValue("firebase-id-token") },
}));

vi.mock("@/lib/services/device-resource-cache-service", () => ({
  DeviceResourceCacheService: {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    invalidateResourcePrefix: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/services/connected-systems-service", () => ({
  ConnectedSystemsRequestError: class ConnectedSystemsRequestError extends Error {
    constructor(
      message: string,
      readonly code: string | null,
      readonly status: number,
    ) {
      super(message);
      this.name = "ConnectedSystemsRequestError";
    }
  },
  ConnectedSystemsService: {
    getRegistry: vi.fn(),
    getSchema: vi.fn(),
    getRecordBinding: vi.fn(),
    disconnectRecordBinding: vi.fn(),
    listRecordBindingStatuses: vi.fn(),
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
  supportedActions: {
    schema: true,
    read: false,
    create: false,
    update: false,
    delete: false,
  },
  configurationRevision: 1,
};

const metadataOnlySchema = {
  systemId: system.systemId,
  target: system.target,
  objectType: system.objectTypeDefault,
  configurationRevision: system.configurationRevision,
  supportedFields: ["Email", "PreferredLanguage", "Birthdate"],
  schemaStatus: "capability_metadata_missing",
  effectiveActions: {
    schema: true,
    read: false,
    create: false,
    update: false,
    delete: false,
  },
  configurationMessage:
    "This connected system needs an update before its fields can be used.",
  fields: [
    {
      key: "Email",
      name: "Email",
      label: "Email",
      dataType: "email",
      required: false,
      readable: false,
      createable: false,
      updateable: false,
      immutable: false,
      identityField: false,
      permissionsDeclared: false,
    },
    {
      key: "PreferredLanguage",
      name: "PreferredLanguage",
      label: "Preferred language",
      dataType: "picklist",
      required: false,
      readable: false,
      createable: false,
      updateable: false,
      immutable: false,
      identityField: false,
      permissionsDeclared: false,
      constraints: { allowedValues: ["English", "French"] },
    },
    {
      key: "Birthdate",
      name: "Birthdate",
      label: "Birth date",
      dataType: "date",
      required: false,
      readable: false,
      createable: false,
      updateable: false,
      immutable: false,
      identityField: false,
      permissionsDeclared: false,
    },
  ],
};

const readySchema = {
  ...metadataOnlySchema,
  schemaStatus: "ready",
  effectiveActions: {
    schema: true,
    read: true,
    create: true,
    update: true,
    delete: true,
  },
  fields: [
    {
      key: "Email",
      name: "Email",
      label: "Email",
      dataType: "email",
      required: true,
      readable: true,
      createable: true,
      updateable: false,
      immutable: true,
      identityField: true,
      permissionsDeclared: true,
    },
    {
      key: "PreferredLanguage",
      name: "PreferredLanguage",
      label: "Preferred language",
      dataType: "picklist",
      required: false,
      readable: true,
      createable: true,
      updateable: true,
      immutable: false,
      identityField: false,
      permissionsDeclared: true,
      constraints: { allowedValues: ["English", "French"] },
    },
  ],
};

describe("ConnectedSystemsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
    vi.mocked(ConnectedSystemsService.getRegistry).mockResolvedValue({
      registryRevision: 1,
      systems: [system],
    });
    vi.mocked(
      ConnectedSystemsService.listRecordBindingStatuses,
    ).mockResolvedValue({
      bindings: [
        {
          systemId: system.systemId,
          objectType: system.objectTypeDefault,
          status: "unbound",
        },
      ],
    });
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValue(
      metadataOnlySchema,
    );
    vi.spyOn(ConnectedSystemsResourceService, "loadSchema").mockImplementation(
      async (params) =>
        ConnectedSystemsService.getSchema({
          vaultOwnerToken: params.vaultOwnerToken,
          systemId: params.systemId,
          objectType: params.objectType,
          forceRefresh: params.forceRefresh,
        }),
    );
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockResolvedValue({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      status: "unbound",
      binding: null,
    });
    vi.mocked(
      ConnectedSystemsService.disconnectRecordBinding,
    ).mockResolvedValue({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      status: "disconnected",
      binding: {
        systemId: system.systemId,
        objectType: system.objectTypeDefault,
        recordId: "person-gone",
        status: "disconnected",
      },
    });
    vi.mocked(ConnectedSystemsService.readRecord).mockResolvedValue({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      resultClass: "succeeded",
      records: [],
    });
    vi.mocked(ConnectedSystemsService.searchRecord).mockResolvedValue({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      resultClass: "succeeded",
      records: [],
      bindingStatus: "unbound",
      binding: null,
    });
  });

  it("keeps registered CRM marks in their original colors on a light canvas", () => {
    render(
      <ConnectedSystemLogo
        system={{ ...system, customerDisplayName: "Chase" }}
      />,
    );

    const logo = screen.getByRole("img", { name: "Chase logo" });
    expect(logo).toHaveClass("filter-none");
    expect(logo.parentElement).toHaveClass("!bg-white", "dark:!bg-white");
  });

  it("uses the same fixed row frame for branded and fallback CRM marks", () => {
    const { container, rerender } = render(
      <ConnectedSystemLogo
        system={{
          ...system,
          customerDisplayName: "Hussh",
          displayName: "Hussh",
          target: "Hussh",
        }}
      />,
    );

    const fallback = container.querySelector(
      '[data-slot="connected-system-logo"]',
    );
    if (!(fallback instanceof HTMLElement)) {
      throw new Error("Fallback CRM logo frame was not rendered.");
    }
    expect(fallback).toHaveAttribute("data-logo-kind", "fallback");
    expect(fallback).toHaveClass("h-11", "w-[4.75rem]", "rounded-[14px]");

    rerender(
      <ConnectedSystemLogo
        system={{ ...system, customerDisplayName: "Chase" }}
      />,
    );

    const branded = container.querySelector(
      '[data-slot="connected-system-logo"]',
    );
    if (!(branded instanceof HTMLElement)) {
      throw new Error("Branded CRM logo frame was not rendered.");
    }
    expect(branded).toHaveAttribute("data-logo-kind", "brand");
    expect(branded).toHaveClass("h-11", "w-[4.75rem]", "rounded-[14px]");
  });

  it("lists dynamically registered CRM systems without requiring vault unlock", async () => {
    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken={null}
        mode="list"
      />,
    );

    expect(await screen.findByText("Customer CRM")).toBeTruthy();
    expect(screen.getByText("Example")).toBeTruthy();
    expect(screen.getByText("Set up")).toBeTruthy();
    fireEvent.click(screen.getByText("Customer CRM"));
    expect(routerPushMock).toHaveBeenCalledWith(
      "/one/connected-systems/customer-crm",
    );
  });

  it("separates CRM availability from the current user's record link", async () => {
    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        mode="list"
      />,
    );

    expect(await screen.findByText("Customer CRM")).toBeTruthy();
    expect(await screen.findByText("Example")).toBeTruthy();
    expect(screen.getByText("Set up")).toBeTruthy();
    expect(screen.queryByText("CRM systems", { exact: true })).toBeNull();
  });

  it("keeps a warm schema in the background until a record is linked", async () => {
    const cache = CacheService.getInstance();
    cache.set(
      CACHE_KEYS.CONNECTED_SYSTEMS_REGISTRY("user-1"),
      { registryRevision: 1, systems: [system] },
      CACHE_TTL.MEDIUM,
    );
    cache.set(
      ConnectedSystemsResourceService.schemaCacheKey({
        userId: "user-1",
        systemId: system.systemId,
        objectType: system.objectTypeDefault,
        configurationRevision: 1,
      }),
      readySchema,
      CACHE_TTL.MEDIUM,
    );

    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Find my record" }),
    ).toBeTruthy();
    expect(ConnectedSystemsService.getRegistry).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.getSchema).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Search fields")).toBeNull();
    expect(screen.queryByText("Fields ready")).toBeNull();
  });

  it("does not show a terminal setup error while the current schema is preparing", async () => {
    const cache = CacheService.getInstance();
    cache.set(
      CACHE_KEYS.CONNECTED_SYSTEMS_REGISTRY("user-1"),
      { registryRevision: 1, systems: [system] },
      CACHE_TTL.MEDIUM,
    );
    let resolveSchema!: (value: typeof readySchema) => void;
    const schemaPromise = new Promise<typeof readySchema>((resolve) => {
      resolveSchema = resolve;
    });
    vi.spyOn(ConnectedSystemsResourceService, "loadSchema").mockImplementation(
      async (params) => {
        const cacheKey = ConnectedSystemsResourceService.schemaCacheKey({
          userId: params.userId,
          systemId: params.systemId,
          objectType: params.objectType,
          configurationRevision: params.configurationRevision,
        });
        cache.set(
          cacheKey,
          {
            ...metadataOnlySchema,
            schemaMappingStatus: "unavailable",
          },
          CACHE_TTL.SHORT,
        );
        const schema = await schemaPromise;
        cache.set(cacheKey, schema, CACHE_TTL.MEDIUM);
        return schema;
      },
    );

    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
      />,
    );

    expect(
      await screen.findByRole("status", { name: "Preparing your CRM profile" }),
    ).toBeTruthy();
    expect(
      screen.queryByText("Profile setup is temporarily unavailable"),
    ).toBeNull();

    await act(async () => {
      resolveSchema(readySchema);
    });

    expect(
      await screen.findByRole("button", { name: "Find my record" }),
    ).toBeTruthy();
    expect(
      screen.queryByText("Profile setup is temporarily unavailable"),
    ).toBeNull();
  });

  it("does not show a field catalogue before a fresh user has a linked record", async () => {
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
    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
      />,
    );

    await waitFor(() =>
      expect(ConnectedSystemsResourceService.loadSchema).toHaveBeenCalled(),
    );
    expect(
      await screen.findByText("Profile setup is temporarily unavailable"),
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search fields")).toBeNull();
    expect(screen.queryByText("Field 139")).toBeNull();
    expect(screen.queryByRole("button", { name: "Find my record" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Update record$/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete$/i })).toBeNull();
    expect(ConnectedSystemsService.readRecord).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.createRecordIntent).not.toHaveBeenCalled();
  });

  it("keeps an unbound system concise when record operation mappings are unavailable", async () => {
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce({
      ...readySchema,
      effectiveActions: {
        schema: true,
        read: false,
        create: false,
        update: false,
        delete: false,
      },
      configurationMessage: undefined,
    });
    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
      />,
    );

    expect(
      await screen.findByText("Profile setup is temporarily unavailable"),
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search fields")).toBeNull();
    expect(screen.queryByText("Preferred language")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Link this system/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Update record$/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete$/i })).toBeNull();
  });

  it("keeps lookup and create as separate explicit actions", async () => {
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce(
      readySchema,
    );
    vi.mocked(ConnectedSystemsService.createRecordIntent).mockResolvedValueOnce(
      {
        intentId: "intent-create-42",
        systemId: system.systemId,
        action: "create",
        status: "pending",
        fieldNames: ["Email"],
      },
    );
    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
        profile={{
          displayName: "Jordan Lee",
          email: "jordan@example.test",
          phone: "4155550100",
        }}
      />,
    );

    const findAndLink = await screen.findByRole("button", {
      name: "Find my record",
    });
    expect(screen.getByText("jordan@example.test")).toBeTruthy();
    expect(screen.getByText("4155550100")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search fields")).toBeNull();
    expect(ConnectedSystemsService.searchRecord).not.toHaveBeenCalled();

    fireEvent.click(findAndLink);
    await waitFor(() => {
      expect(ConnectedSystemsService.searchRecord).toHaveBeenCalledWith(
        "HCT:test",
        expect.objectContaining({
          systemId: system.systemId,
          objectType: system.objectTypeDefault,
          returnFields: ["Email", "PreferredLanguage"],
        }),
      );
    });
    expect(ConnectedSystemsService.createRecordIntent).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", { name: "Create profile" }),
    );
    await waitFor(() =>
      expect(ConnectedSystemsService.createRecordIntent).toHaveBeenCalledWith(
        "HCT:test",
        expect.objectContaining({ systemId: system.systemId }),
      ),
    );
    expect(await screen.findByText("Review create request")).toBeTruthy();
  });

  it("waits for a separately verified Contact binding after Person Account creation", async () => {
    const personAccountSystem = {
      ...system,
      objectTypeDefault: "Contact",
      operationObjectTypes: {
        schema: "Contact",
        read: "Contact",
        create: "Account",
        update: "Contact",
        delete: "Contact",
      },
    };
    const contactSchema = {
      ...readySchema,
      objectType: "Contact",
    };
    vi.mocked(ConnectedSystemsService.getRegistry).mockResolvedValue({
      registryRevision: 1,
      systems: [personAccountSystem],
    });
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce(
      contactSchema,
    );
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockImplementation(
      async ({ objectType }) => ({
        systemId: personAccountSystem.systemId,
        target: personAccountSystem.target,
        objectType: objectType || "Contact",
        status: "unbound",
        binding: null,
      }),
    );
    vi.mocked(ConnectedSystemsService.createRecordIntent).mockResolvedValueOnce(
      {
        intentId: "intent-account-create",
        systemId: personAccountSystem.systemId,
        action: "create",
        objectType: "Account",
        status: "pending",
        fieldNames: ["FirstName", "LastName", "PersonEmail"],
      },
    );
    vi.mocked(ConnectedSystemsService.approveIntent).mockResolvedValueOnce({
      intentId: "intent-account-create",
      systemId: personAccountSystem.systemId,
      action: "create",
      objectType: "Account",
      status: "succeeded",
      recordId: "001-person-account",
      fieldNames: ["FirstName", "LastName", "PersonEmail"],
      binding: {
        systemId: personAccountSystem.systemId,
        objectType: "Account",
        recordId: "001-person-account",
        status: "active",
      },
    });

    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={personAccountSystem.systemId}
        profile={{
          displayName: "Jordan Lee",
          email: "jordan@example.test",
          phone: "4155550100",
        }}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Find my record" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Create profile" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm create" }),
    );

    expect(await screen.findByText("Your profile was created")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Check for Contact" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create profile" })).toBeNull();
    expect(screen.queryByText("001-person-account")).toBeNull();
    expect(ConnectedSystemsService.readRecord).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(ConnectedSystemsService.searchRecord).toHaveBeenCalledTimes(2);
      expect(ConnectedSystemsService.searchRecord).toHaveBeenLastCalledWith(
        "HCT:test",
        expect.objectContaining({ objectType: "Contact" }),
      );
    });
  });

  it("restores the Contact-binding wait after reload without reusing an Account ID", async () => {
    const personAccountSystem = {
      ...system,
      objectTypeDefault: "Contact",
      operationObjectTypes: {
        schema: "Contact",
        read: "Contact",
        create: "Account",
        update: "Contact",
        delete: "Contact",
      },
    };
    vi.mocked(ConnectedSystemsService.getRegistry).mockResolvedValue({
      registryRevision: 1,
      systems: [personAccountSystem],
    });
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce({
      ...readySchema,
      objectType: "Contact",
    });
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockImplementation(
      async ({ objectType }) => {
        if (objectType === "Account") {
          return {
            systemId: personAccountSystem.systemId,
            target: personAccountSystem.target,
            objectType: "Account",
            status: "active",
            binding: {
              systemId: personAccountSystem.systemId,
              objectType: "Account",
              recordId: "001-person-account",
              status: "active",
            },
          };
        }
        return {
          systemId: personAccountSystem.systemId,
          target: personAccountSystem.target,
          objectType: "Contact",
          status: "unbound",
          binding: null,
        };
      },
    );

    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={personAccountSystem.systemId}
      />,
    );

    expect(await screen.findByText("Your profile was created")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Check for Contact" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create profile" })).toBeNull();
    expect(screen.queryByText("001-person-account")).toBeNull();
    expect(ConnectedSystemsService.readRecord).not.toHaveBeenCalled();
    expect(ConnectedSystemsService.updateRecordIntent).not.toHaveBeenCalled();
  });

  it("ignores a late cross-object binding response after switching CRM systems", async () => {
    const personAccountSystem = {
      ...system,
      systemId: "person-account-crm",
      displayName: "Person Account CRM",
      customerDisplayName: "Person Account CRM",
      target: "Person Account CRM",
      objectTypeDefault: "Contact",
      operationObjectTypes: {
        schema: "Contact",
        read: "Contact",
        create: "Account",
        update: "Contact",
        delete: "Contact",
      },
    };
    const contactSystem = {
      ...system,
      systemId: "contact-crm",
      displayName: "Contact CRM",
      customerDisplayName: "Contact CRM",
      target: "Contact CRM",
      objectTypeDefault: "Contact",
    };
    let resolveAccountBinding!: (value: {
      systemId: string;
      target: string;
      objectType: string;
      status: string;
      binding: {
        systemId: string;
        objectType: string;
        recordId: string;
        status: string;
      };
    }) => void;
    const accountBinding = new Promise<{
      systemId: string;
      target: string;
      objectType: string;
      status: string;
      binding: {
        systemId: string;
        objectType: string;
        recordId: string;
        status: string;
      };
    }>((resolve) => {
      resolveAccountBinding = resolve;
    });
    vi.mocked(ConnectedSystemsService.getRegistry).mockResolvedValue({
      registryRevision: 1,
      systems: [personAccountSystem, contactSystem],
    });
    vi.mocked(ConnectedSystemsService.getSchema).mockImplementation(
      async ({ systemId }) => ({
        ...readySchema,
        systemId: systemId || personAccountSystem.systemId,
        target:
          systemId === contactSystem.systemId
            ? contactSystem.target
            : personAccountSystem.target,
        objectType: "Contact",
      }),
    );
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockImplementation(
      async ({ systemId, objectType }) => {
        if (
          systemId === personAccountSystem.systemId &&
          objectType === "Account"
        ) {
          return accountBinding;
        }
        return {
          systemId: systemId || personAccountSystem.systemId,
          target:
            systemId === contactSystem.systemId
              ? contactSystem.target
              : personAccountSystem.target,
          objectType: objectType || "Contact",
          status: "unbound",
          binding: null,
        };
      },
    );

    const { rerender } = render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={personAccountSystem.systemId}
      />,
    );

    await waitFor(() => {
      expect(ConnectedSystemsService.getRecordBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          systemId: personAccountSystem.systemId,
          objectType: "Account",
        }),
      );
    });

    rerender(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={contactSystem.systemId}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Find my record" }),
    ).toBeTruthy();
    await act(async () => {
      resolveAccountBinding({
        systemId: personAccountSystem.systemId,
        target: personAccountSystem.target,
        objectType: "Account",
        status: "active",
        binding: {
          systemId: personAccountSystem.systemId,
          objectType: "Account",
          recordId: "001-person-account",
          status: "active",
        },
      });
    });

    expect(screen.getByRole("button", { name: "Find my record" })).toBeTruthy();
    expect(screen.queryByText("Your profile was created")).toBeNull();
    expect(screen.queryByText("001-person-account")).toBeNull();
  });

  it("does not redirect for a late mutation failure after switching CRM systems", async () => {
    const firstSystem = {
      ...system,
      systemId: "late-mutation-first-crm",
      displayName: "First CRM",
      customerDisplayName: "First CRM",
      target: "First CRM",
    };
    const secondSystem = {
      ...system,
      systemId: "late-mutation-second-crm",
      displayName: "Second CRM",
      customerDisplayName: "Second CRM",
      target: "Second CRM",
    };
    let rejectCreate!: (reason: Error) => void;
    const createIntent = new Promise<never>((_resolve, reject) => {
      rejectCreate = reject;
    });

    vi.mocked(ConnectedSystemsService.getRegistry).mockResolvedValue({
      registryRevision: 1,
      systems: [firstSystem, secondSystem],
    });
    vi.mocked(ConnectedSystemsService.getSchema).mockImplementation(
      async ({ systemId }) => ({
        ...readySchema,
        systemId: systemId || firstSystem.systemId,
        target:
          systemId === secondSystem.systemId
            ? secondSystem.target
            : firstSystem.target,
      }),
    );
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockImplementation(
      async ({ systemId }) => ({
        systemId: systemId || firstSystem.systemId,
        target:
          systemId === secondSystem.systemId
            ? secondSystem.target
            : firstSystem.target,
        objectType: system.objectTypeDefault,
        status: "unbound",
        binding: null,
      }),
    );
    vi.mocked(ConnectedSystemsService.createRecordIntent).mockImplementation(
      async () => createIntent,
    );

    const { rerender } = render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={firstSystem.systemId}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Find my record" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Create profile" }),
    );
    await waitFor(() => {
      expect(ConnectedSystemsService.createRecordIntent).toHaveBeenCalledWith(
        "HCT:test",
        expect.objectContaining({ systemId: firstSystem.systemId }),
      );
    });

    rerender(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={secondSystem.systemId}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "Find my record" }),
    ).toBeTruthy();

    await act(async () => {
      rejectCreate(
        new ConnectedSystemsRequestError(
          "Phone verification is required.",
          "CONNECTED_SYSTEM_PHONE_VERIFICATION_REQUIRED",
          403,
        ),
      );
    });

    expect(routerPushMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Find my record" })).toBeTruthy();
  });

  it("closes a pending CRM confirmation when the selected system changes", async () => {
    const firstSystem = {
      ...system,
      systemId: "pending-confirmation-first-crm",
      displayName: "First CRM",
      customerDisplayName: "First CRM",
      target: "First CRM",
    };
    const secondSystem = {
      ...system,
      systemId: "pending-confirmation-second-crm",
      displayName: "Second CRM",
      customerDisplayName: "Second CRM",
      target: "Second CRM",
    };
    vi.mocked(ConnectedSystemsService.getRegistry).mockResolvedValue({
      registryRevision: 1,
      systems: [firstSystem, secondSystem],
    });
    vi.mocked(ConnectedSystemsService.getSchema).mockImplementation(
      async ({ systemId }) => ({
        ...readySchema,
        systemId: systemId || firstSystem.systemId,
        target:
          systemId === secondSystem.systemId
            ? secondSystem.target
            : firstSystem.target,
      }),
    );
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockImplementation(
      async ({ systemId }) => ({
        systemId: systemId || firstSystem.systemId,
        target:
          systemId === secondSystem.systemId
            ? secondSystem.target
            : firstSystem.target,
        objectType: system.objectTypeDefault,
        status: "unbound",
        binding: null,
      }),
    );
    vi.mocked(ConnectedSystemsService.createRecordIntent).mockResolvedValueOnce(
      {
        intentId: "intent-first-create",
        systemId: firstSystem.systemId,
        action: "create",
        status: "pending",
        fieldNames: ["Email"],
      },
    );

    const { rerender } = render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={firstSystem.systemId}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Find my record" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Create profile" }),
    );
    expect(await screen.findByText("Review create request")).toBeTruthy();

    rerender(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={secondSystem.systemId}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Review create request")).toBeNull();
    });
    expect(ConnectedSystemsService.approveIntent).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: "Find my record" }),
    ).toBeTruthy();
  });

  it("closes a staged update review when the selected system changes", async () => {
    const firstSystem = {
      ...system,
      systemId: "staged-review-first-crm",
      displayName: "First CRM",
      customerDisplayName: "First CRM",
      target: "First CRM",
    };
    const secondSystem = {
      ...system,
      systemId: "staged-review-second-crm",
      displayName: "Second CRM",
      customerDisplayName: "Second CRM",
      target: "Second CRM",
    };
    vi.mocked(ConnectedSystemsService.getRegistry).mockResolvedValue({
      registryRevision: 1,
      systems: [firstSystem, secondSystem],
    });
    vi.mocked(ConnectedSystemsService.getSchema).mockImplementation(
      async ({ systemId }) => ({
        ...readySchema,
        systemId: systemId || firstSystem.systemId,
        target:
          systemId === secondSystem.systemId
            ? secondSystem.target
            : firstSystem.target,
      }),
    );
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockImplementation(
      async ({ systemId }) => {
        const isFirstSystem = systemId !== secondSystem.systemId;
        return {
          systemId: systemId || firstSystem.systemId,
          target: isFirstSystem ? firstSystem.target : secondSystem.target,
          objectType: system.objectTypeDefault,
          status: isFirstSystem ? "active" : "unbound",
          binding: isFirstSystem
            ? {
                systemId: firstSystem.systemId,
                objectType: system.objectTypeDefault,
                recordId: "person-42",
                status: "active",
              }
            : null,
        };
      },
    );
    // Schema and binding hydration can issue a second equivalent read. Both
    // resolve the same bound record; this test is about discarding its staged
    // update when the CRM changes, not incidental hook scheduling.
    vi.mocked(ConnectedSystemsService.readRecord).mockResolvedValue({
      systemId: firstSystem.systemId,
      target: firstSystem.target,
      objectType: system.objectTypeDefault,
      resultClass: "succeeded",
      recordId: "person-42",
      records: [
        {
          recordId: "person-42",
          fields: {
            Email: "person@example.test",
            PreferredLanguage: "English",
          },
        },
      ],
    });

    const { rerender } = render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={firstSystem.systemId}
        profile={{ email: "person@example.test" }}
      />,
    );

    // Let the current CRM detail finish its passive record lifecycle before
    // opening the editor; the assertion below is about the later CRM switch.
    expect(
      await screen.findByRole("region", { name: "CRM record fields" }),
    ).toBeTruthy();
    expect(await screen.findByText("person@example.test")).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit Preferred language" }),
    );
    fireEvent.change(await screen.findByRole("combobox"), {
      target: { value: "French" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Stage change" }));
    fireEvent.click(screen.getByRole("button", { name: "Update record" }));
    expect(await screen.findByText("Review changes")).toBeTruthy();

    rerender(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={secondSystem.systemId}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Review changes")).toBeNull();
    });
    expect(ConnectedSystemsService.updateRecordIntent).not.toHaveBeenCalled();
  });

  it("links a verified-identity match and renders its returned record", async () => {
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce(
      readySchema,
    );
    vi.mocked(ConnectedSystemsService.searchRecord).mockResolvedValueOnce({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      resultClass: "succeeded",
      recordId: "person-99",
      bindingStatus: "active",
      binding: {
        systemId: system.systemId,
        objectType: system.objectTypeDefault,
        recordId: "person-99",
        status: "active",
      },
      records: [
        {
          recordId: "person-99",
          fields: {
            Email: "person@example.test",
            PreferredLanguage: "English",
          },
        },
      ],
    });
    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Find my record" }),
    );

    expect(
      await screen.findByRole("region", { name: "CRM record fields" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh fields" })).toBeTruthy();
    expect(screen.queryByText("Information")).toBeNull();
    expect(await screen.findByText("person@example.test")).toBeTruthy();
    expect(ConnectedSystemsService.createRecordIntent).not.toHaveBeenCalled();
  });

  it("uses normalized records and stages one explicitly updateable field for confirmation", async () => {
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce(
      readySchema,
    );
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
      records: [
        {
          recordId: "person-42",
          fields: {
            Email: "person@example.test",
            PreferredLanguage: "English",
          },
        },
      ],
    });
    vi.mocked(ConnectedSystemsService.updateRecordIntent).mockResolvedValueOnce(
      {
        intentId: "intent-42",
        systemId: system.systemId,
        action: "update",
        status: "pending",
        fieldNames: ["PreferredLanguage"],
      },
    );
    vi.mocked(ConnectedSystemsService.approveIntent).mockResolvedValueOnce({
      intentId: "intent-42",
      systemId: system.systemId,
      action: "update",
      status: "succeeded",
      recordId: "person-42",
      fieldNames: ["PreferredLanguage"],
    });

    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
        profile={{ email: "person@example.test" }}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "CRM record fields" }),
    ).toBeTruthy();
    expect(screen.queryByText("Information")).toBeNull();
    const preferredLanguage = await screen.findByText("Preferred language");
    expect(preferredLanguage.closest("tr")?.textContent).toContain("English");
    expect(screen.queryByLabelText("Field view")).toBeNull();
    const fieldRows = screen.getAllByRole("row");
    expect(
      fieldRows.findIndex((row) => row.textContent?.includes("Email")),
    ).toBeLessThan(
      fieldRows.findIndex((row) =>
        row.textContent?.includes("Preferred language"),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Preferred language" }),
    );
    const editor = await screen.findByRole("combobox");
    fireEvent.change(editor, { target: { value: "French" } });
    fireEvent.click(screen.getByRole("button", { name: "Stage change" }));
    const updateButton = screen.getByRole("button", {
      name: "Update record",
    });
    expect(updateButton.parentElement).toHaveClass("justify-center");
    expect(updateButton).toHaveClass("min-h-14", "max-w-[30rem]");
    fireEvent.click(updateButton);

    const reviewDialog = await screen.findByRole("alertdialog");
    expect(within(reviewDialog).getByText("Review changes")).toBeTruthy();
    expect(within(reviewDialog).getByText("Preferred language")).toBeTruthy();
    expect(within(reviewDialog).getByText("English")).toBeTruthy();
    expect(within(reviewDialog).getByText("French")).toBeTruthy();
    expect(within(reviewDialog).queryByText("person-42")).toBeNull();
    expect(ConnectedSystemsService.updateRecordIntent).not.toHaveBeenCalled();
    fireEvent.click(
      within(reviewDialog).getByRole("button", { name: "Confirm update" }),
    );

    await waitFor(() => {
      expect(ConnectedSystemsService.updateRecordIntent).toHaveBeenCalledWith(
        "HCT:test",
        expect.objectContaining({
          recordFields: { PreferredLanguage: "French" },
        }),
      );
    });
    expect(ConnectedSystemsService.approveIntent).toHaveBeenCalledWith({
      vaultOwnerToken: "HCT:test",
      systemId: system.systemId,
      intentId: "intent-42",
    });
  });

  it("keeps verified create and lookup fields locked even when the CRM omits identity metadata", async () => {
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce({
      ...readySchema,
      profileFieldMappings: { email: "Email" },
      fields: readySchema.fields.map((field) =>
        field.key === "Email"
          ? {
              ...field,
              identityField: false,
              immutable: false,
              updateable: true,
            }
          : field,
      ),
    });
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
      records: [
        {
          recordId: "person-42",
          fields: {
            Email: "person@example.test",
            PreferredLanguage: "English",
          },
        },
      ],
    });

    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "CRM record fields" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit Email" })).toBeNull();
    expect(screen.getByText("Primary CRM lookup field is locked")).toBeTruthy();
    expect(
      screen.getByText("Primary CRM lookup field is locked").parentElement,
    ).toHaveClass("w-full", "justify-end");
    expect(
      screen.getByText("Primary CRM lookup field is locked")
        .previousElementSibling,
    ).toHaveClass("size-8", "rounded-full", "bg-muted/55");
    expect(
      screen.getByRole("button", { name: "Edit Preferred language" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Edit Preferred language" })
        .parentElement,
    ).toHaveClass("w-full", "justify-end");
    expect(
      screen.getByRole("button", { name: "Edit Preferred language" }),
    ).toHaveClass("size-8", "rounded-full", "bg-muted/55");
  });

  it("keeps CRM field values hidden until an explicit record refresh settles", async () => {
    const record = {
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      resultClass: "succeeded" as const,
      recordId: "person-42",
      records: [
        {
          recordId: "person-42",
          fields: {
            Email: "person@example.test",
            PreferredLanguage: "English",
          },
        },
      ],
    };
    let settleRefresh: ((value: typeof record) => void) | undefined;

    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce(
      readySchema,
    );
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
    vi.mocked(ConnectedSystemsService.readRecord)
      .mockResolvedValueOnce(record)
      .mockImplementationOnce(
        () =>
          new Promise<typeof record>((resolve) => {
            settleRefresh = resolve;
          }),
      );

    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
      />,
    );

    expect(await screen.findByPlaceholderText("Search fields")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh", exact: true }),
    );

    expect(
      await screen.findByText("Refreshing the latest CRM fields…"),
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText("Search fields")).toBeNull();

    settleRefresh?.(record);
    expect(await screen.findByPlaceholderText("Search fields")).toBeTruthy();
  });

  it("retires a missing remote record and offers a clean create recovery", async () => {
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce(
      readySchema,
    );
    vi.mocked(ConnectedSystemsService.getRecordBinding).mockResolvedValueOnce({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      status: "active",
      binding: {
        systemId: system.systemId,
        objectType: system.objectTypeDefault,
        recordId: "person-gone",
        status: "active",
      },
    });
    vi.mocked(ConnectedSystemsService.readRecord).mockResolvedValueOnce({
      systemId: system.systemId,
      target: system.target,
      objectType: system.objectTypeDefault,
      resultClass: "succeeded",
      recordId: null,
      records: [],
      bindingStatus: "remote_record_missing",
      binding: {
        systemId: system.systemId,
        objectType: system.objectTypeDefault,
        recordId: "person-gone",
        status: "disconnected",
      },
      recoveryAction: "create_or_relink",
    });
    vi.mocked(ConnectedSystemsService.createRecordIntent).mockResolvedValueOnce(
      {
        intentId: "intent-recovery",
        systemId: system.systemId,
        action: "create",
        status: "pending",
        fieldNames: ["Email"],
      },
    );

    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
        profile={{ email: "person@example.test" }}
      />,
    );

    expect(
      await screen.findByText(
        "The linked record no longer exists in this CRM. Unlink it to prepare a new profile.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Create a new profile")).toBeTruthy();
    expect(screen.queryByText("No record returned")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Unlink and create profile" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Unlink and continue" }),
    );
    await waitFor(() =>
      expect(
        ConnectedSystemsService.disconnectRecordBinding,
      ).toHaveBeenCalledWith({
        vaultOwnerToken: "HCT:test",
        systemId: system.systemId,
        objectType: system.objectTypeDefault,
      }),
    );
    await waitFor(() =>
      expect(ConnectedSystemsService.createRecordIntent).toHaveBeenCalledWith(
        "HCT:test",
        expect.objectContaining({ systemId: system.systemId }),
      ),
    );
  });

  it("reports the CRM name to the route shell and keeps it out of body headings", async () => {
    const onSystemResolved = vi.fn();
    vi.mocked(ConnectedSystemsService.getSchema).mockResolvedValueOnce(
      readySchema,
    );

    render(
      <ConnectedSystemsPanel
        cacheUserId="user-1"
        vaultOwnerToken="HCT:test"
        systemId={system.systemId}
        onSystemResolved={onSystemResolved}
      />,
    );

    await waitFor(() => expect(onSystemResolved).toHaveBeenCalledWith(system));
    expect(await screen.findByText("Find my profile")).toBeTruthy();
    expect(screen.queryByText("Find my Customer CRM profile")).toBeNull();
  });
});

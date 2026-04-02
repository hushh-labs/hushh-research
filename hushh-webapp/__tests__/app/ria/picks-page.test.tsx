import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    replace: vi.fn(),
    toast: {
      success: vi.fn(),
      error: vi.fn(),
    },
    useAuth: vi.fn(),
    useVault: vi.fn(),
    usePersonaState: vi.fn(),
    useStaleResource: vi.fn(),
    refresh: vi.fn(),
    tickerUniverse: {
      preloadTickerUniverse: vi.fn(),
      searchTickerUniverseRemote: vi.fn(),
    },
    riaService: {
      listPicks: vi.fn(),
      savePickPackage: vi.fn(),
      importPickCsv: vi.fn(),
      getRenaissanceUniverse: vi.fn(),
      getRenaissanceAvoid: vi.fn(),
      getRenaissanceScreening: vi.fn(),
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("sonner", () => ({
  toast: mocks.toast,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: mocks.useAuth,
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: mocks.useVault,
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: mocks.usePersonaState,
}));

vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: mocks.useStaleResource,
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageHeaderRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({
    title,
    description,
    actions,
  }: {
    title?: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <section>
      <h1>{title}</h1>
      <p>{description}</p>
      <div>{actions}</div>
    </section>
  ),
  SectionHeader: ({
    title,
    description,
    actions,
  }: {
    title?: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      <div>{actions}</div>
    </section>
  ),
}));

vi.mock("@/components/app-ui/data-table", () => ({
  DataTable: ({
    data,
    searchPlaceholder,
  }: {
    data: Array<Record<string, unknown>>;
    searchPlaceholder?: string;
  }) => (
    <div data-testid="mock-data-table">
      <span>{searchPlaceholder}</span>
      <span>{data.length}</span>
      {data.map((row, index) => (
        <div key={index}>{String(row.ticker || row.title || row.company_name || index)}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/app-ui/surfaces", () => ({
  SurfaceCard: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  SurfaceCardContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  SurfaceInset: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));

vi.mock("@/components/profile/settings-ui", () => ({
  SettingsSegmentedTabs: ({
    value,
    onValueChange,
    options,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <div>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/ria/ria-page-shell", () => ({
  RiaCompatibilityState: ({
    title,
    description,
  }: {
    title: string;
    description: string;
  }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
    </div>
  ),
}));

vi.mock("@/components/app-ui/command-fields", () => ({
  CommandPickerField: ({
    value,
    placeholder,
    options = [],
    onSelect,
  }: {
    value: string;
    placeholder: string;
    options?: Array<{ value: string; label: string }>;
    onSelect: (option: { value: string; label: string } | null) => void;
  }) => (
    <select
      aria-label={placeholder}
      value={value}
      onChange={(event) => {
        const nextValue = event.target.value;
        const option = options.find((item) => item.value === nextValue) || null;
        onSelect(option);
      }}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  PopupTextEditorField: ({
    value,
    placeholder,
    onSave,
  }: {
    value: string;
    placeholder: string;
    onSave: (value: string) => void;
  }) => (
    <textarea
      value={value}
      placeholder={placeholder}
      onChange={(event) => onSave(event.target.value)}
    />
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    placeholder,
    type,
    accept,
  }: {
    value?: string;
    onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    type?: string;
    accept?: string;
  }) => (
    <input
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      type={type}
      accept={accept}
    />
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: ({
    value,
    onChange,
    placeholder,
  }: {
    value?: string;
    onChange?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
    placeholder?: string;
  }) => <textarea value={value} onChange={onChange} placeholder={placeholder} />,
}));

vi.mock("@/lib/morphy-ux/button", async () => {
  const ReactModule = await import("react");
  return {
    Button: ({
      children,
      onClick,
      disabled,
      asChild = false,
    }: {
      children: React.ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      asChild?: boolean;
    }) => {
      if (asChild && ReactModule.isValidElement(children)) {
        return ReactModule.cloneElement(children, {
          onClick,
          "data-disabled": disabled ? "true" : undefined,
        });
      }
      return (
        <button type="button" onClick={onClick} disabled={disabled}>
          {children}
        </button>
      );
    },
  };
});

vi.mock("lucide-react", () => {
  const Icon = () => <span />;
  return {
    Check: Icon,
    ChevronsUpDown: Icon,
    Crown: Icon,
    Download: Icon,
    FileSpreadsheet: Icon,
    FilePenLine: Icon,
    Loader2: Icon,
    Medal: Icon,
    PencilLine: Icon,
    Plus: Icon,
    SearchIcon: Icon,
    Save: Icon,
    Star: Icon,
    Trophy: Icon,
    Trash2: Icon,
    Upload: Icon,
    X: Icon,
    XIcon: Icon,
  };
});

vi.mock("@/lib/navigation/routes", () => ({
  ROUTES: {
    RIA_ONBOARDING: "/ria/onboarding",
  },
}));

vi.mock("@/lib/kai/ticker-universe-cache", () => ({
  preloadTickerUniverse: mocks.tickerUniverse.preloadTickerUniverse,
  searchTickerUniverseRemote: mocks.tickerUniverse.searchTickerUniverseRemote,
}));

vi.mock("@/lib/services/ria-service", () => ({
  isIAMSchemaNotReadyError: () => false,
  RiaService: mocks.riaService,
}));

import RiaPicksPage from "@/app/ria/picks/page";

function buildResource(overrides?: Record<string, unknown>) {
  return {
    data: {
      package: {
        top_picks: [],
        avoid_rows: [],
        screening_sections: [
          { section: "investable_requirements", rows: [] },
          { section: "automatic_avoid_triggers", rows: [] },
          { section: "the_math", rows: [] },
        ],
      },
    },
    loading: false,
    error: null,
    refresh: mocks.refresh,
    ...overrides,
  };
}

describe("RiaPicksPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({
      user: {
        uid: "ria-user-1",
        getIdToken: vi.fn().mockResolvedValue("token-123"),
      },
    });
    mocks.usePersonaState.mockReturnValue({
      riaCapability: "ready",
      loading: false,
      refreshing: false,
    });
    mocks.useVault.mockReturnValue({
      vaultKey: "vault-key-1",
      vaultOwnerToken: "vault-owner-token-1",
      isVaultUnlocked: true,
    });
    mocks.useStaleResource.mockReturnValue(buildResource());
    mocks.riaService.getRenaissanceUniverse.mockResolvedValue({
      items: [
        {
          ticker: "NVDA",
          company_name: "NVIDIA",
          sector: "Semis",
          tier: "ACE",
          investment_thesis: "Compounding AI infrastructure demand",
          fcf_billions: 29,
        },
      ],
      total: 1,
    });
    mocks.riaService.getRenaissanceAvoid.mockResolvedValue({ items: [] });
    mocks.riaService.getRenaissanceScreening.mockResolvedValue({ items: [] });
    mocks.tickerUniverse.preloadTickerUniverse.mockResolvedValue([
      {
        ticker: "NVDA",
        title: "NVIDIA Corporation",
        sector_primary: "Technology",
        tradable: true,
      },
    ]);
    mocks.tickerUniverse.searchTickerUniverseRemote.mockResolvedValue([]);
    mocks.riaService.savePickPackage.mockResolvedValue({
      package: {
        top_picks: [],
        avoid_rows: [],
        screening_sections: [],
        package_note: null,
      },
      metadata: {
        has_package: true,
        storage_source: "pkm",
        package_revision: 2,
        top_pick_count: 1,
        avoid_count: 0,
        screening_row_count: 0,
        active_share_count: 1,
      },
    });
    mocks.riaService.importPickCsv.mockResolvedValue({
      package: {
        top_picks: [],
        avoid_rows: [],
        screening_sections: [],
        package_note: null,
      },
      metadata: {
        has_package: true,
        storage_source: "pkm",
        package_revision: 2,
        top_pick_count: 1,
        avoid_count: 0,
        screening_row_count: 0,
        active_share_count: 1,
      },
    });
  });

  it("keeps upload and template actions out of Kai list and exposes them in My list", async () => {
    render(<RiaPicksPage />);

    await screen.findByText("NVDA");
    expect(screen.queryByRole("button", { name: /copy from kai/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^upload$/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /template/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /my list/i }));

    expect(screen.getByRole("button", { name: /copy from kai/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^upload$/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^template$/i })).toBeTruthy();
    expect(screen.queryByText("List source")).toBeNull();
    expect(
      screen.queryByText(/manage the advisor package that linked investors inherit/i)
    ).toBeNull();
  });

  it("shows an informational My list empty state and scoped upload panel", async () => {
    render(<RiaPicksPage />);

    fireEvent.click(screen.getByRole("button", { name: /my list/i }));

    expect(await screen.findByText("Build your live advisor package")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /copy from kai/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^upload$/i })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: /^template$/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^upload$/i }));

    expect(screen.getByText("Upload a top-picks CSV")).toBeTruthy();
    expect(screen.getByRole("link", { name: /download template/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /upload and replace top picks/i })).toBeTruthy();
  });

  it("copies Kai into the draft editor before save", async () => {
    render(<RiaPicksPage />);

    await screen.findByText("NVDA");
    fireEvent.click(screen.getByRole("button", { name: /my list/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy from kai/i }));

    expect(mocks.riaService.savePickPackage).not.toHaveBeenCalled();
    expect(mocks.riaService.importPickCsv).not.toHaveBeenCalled();
    expect(await screen.findByText("SEC-backed tickers only. Company and sector map from the maintained symbol master.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /discard/i })).toBeTruthy();
  });

  it("lets My list save in-app edits through the validated upload flow", async () => {
    mocks.useStaleResource.mockReturnValue(
      buildResource({
        data: {
          package: {
            top_picks: [
              {
                ticker: "NVDA",
                company_name: "NVIDIA Corporation",
                sector: "Technology",
                tier: "ACE",
                investment_thesis: "Compounding AI infrastructure demand",
              },
            ],
            avoid_rows: [],
            screening_sections: [
              { section: "investable_requirements", rows: [] },
              { section: "automatic_avoid_triggers", rows: [] },
              { section: "the_math", rows: [] },
            ],
            package_note: null,
          },
        },
      })
    );

    render(<RiaPicksPage />);

    fireEvent.click(screen.getByRole("button", { name: /my list/i }));
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    expect(await screen.findByText("SEC-backed tickers only. Company and sector map from the maintained symbol master.")).toBeTruthy();
    fireEvent.change(
      screen.getAllByPlaceholderText("Why this name belongs in the live debate universe")[0]!,
      {
        target: { value: "Compounding AI infrastructure demand with advisor overlay" },
      }
    );
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(mocks.riaService.savePickPackage).toHaveBeenCalledWith(
        expect.objectContaining({
          idToken: "token-123",
          userId: "ria-user-1",
          vaultKey: "vault-key-1",
          vaultOwnerToken: "vault-owner-token-1",
          label: "Active advisor package",
          top_picks: expect.arrayContaining([
            expect.objectContaining({
              ticker: "NVDA",
              company_name: "NVIDIA Corporation",
              sector: "Technology",
              tier: "ACE",
              investment_thesis: "Compounding AI infrastructure demand with advisor overlay",
            }),
          ]),
        })
      );
    });
  });
});

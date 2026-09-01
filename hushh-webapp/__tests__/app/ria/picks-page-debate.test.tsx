import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Page-level coverage of the Debate config sub-view (?view=debate). This reuses
// the picks-page.test.tsx harness verbatim, but swaps the fixed useSearchParams
// mock for a hoisted-mutable `searchParams` (set per test) plus a hoisted
// `iamNotReady` flag so we can exercise the debate render branch, its routing,
// and the additive unlock / error-retry / loading states.
const mocks = vi.hoisted(() => {
  return {
    replace: vi.fn(),
    searchParams: new URLSearchParams(),
    iamNotReady: false,
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
  useSearchParams: () => mocks.searchParams,
  usePathname: () => "/ria/picks",
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
  AppPageShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AppPageHeaderRegion: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AppPageContentRegion: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
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
        <div key={index}>
          {String(row.ticker || row.title || row.company_name || index)}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/app-ui/surfaces", () => ({
  SurfaceCard: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  SurfaceCardContent: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  SurfaceInset: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  SurfaceStack: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));

vi.mock("@/components/profile/settings-ui", () => ({
  SegmentedTabs: ({
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
  }) => (
    <textarea value={value} onChange={onChange} placeholder={placeholder} />
  ),
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
    MessagesSquare: Icon,
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
    RIA_PICKS: "/ria/picks",
  },
}));

vi.mock("@/lib/kai/ticker-universe-cache", () => ({
  preloadTickerUniverse: mocks.tickerUniverse.preloadTickerUniverse,
  searchTickerUniverseRemote: mocks.tickerUniverse.searchTickerUniverseRemote,
}));

vi.mock("@/lib/services/ria-service", () => ({
  isIAMSchemaNotReadyError: () => mocks.iamNotReady,
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

describe("RiaPicksPage — Debate config sub-view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.searchParams = new URLSearchParams();
    mocks.iamNotReady = false;
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
    mocks.tickerUniverse.preloadTickerUniverse.mockResolvedValue([]);
    mocks.tickerUniverse.searchTickerUniverseRemote.mockResolvedValue([]);
  });

  it("renders the debate config pane when view=debate", async () => {
    mocks.searchParams = new URLSearchParams("view=debate");

    render(<RiaPicksPage />);

    expect(await screen.findByTestId("ria-debate-config")).toBeTruthy();
    expect(screen.getByText("This is your debate config")).toBeTruthy();
    // PageHeader swaps its title to the debate copy.
    expect(
      screen.getByRole("heading", { name: "Debate config" }),
    ).toBeTruthy();
    // The educational-not-advice disclaimer is always present in debate view.
    expect(
      screen.getByText(/is not investment advice/i),
    ).toBeTruthy();
  });

  it("renders the default picks view when view is absent", async () => {
    render(<RiaPicksPage />);

    expect(
      await screen.findByRole("heading", { name: "Stock universe" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("ria-debate-config")).toBeNull();
    expect(screen.queryByText("This is your debate config")).toBeNull();
  });

  it("falls back to the default picks view for an unknown view value", async () => {
    mocks.searchParams = new URLSearchParams("view=garbage");

    render(<RiaPicksPage />);

    expect(
      await screen.findByRole("heading", { name: "Stock universe" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("ria-debate-config")).toBeNull();
  });

  it("treats the view match as case-sensitive (view=Debate is not debate)", async () => {
    mocks.searchParams = new URLSearchParams("view=Debate");

    render(<RiaPicksPage />);

    expect(
      await screen.findByRole("heading", { name: "Stock universe" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("ria-debate-config")).toBeNull();
  });

  it("renders the three screening section headers in debate view", async () => {
    mocks.searchParams = new URLSearchParams("view=debate");

    render(<RiaPicksPage />);

    expect(await screen.findByText("Investable requirements")).toBeTruthy();
    expect(screen.getByText("Automatic avoid triggers")).toBeTruthy();
    expect(screen.getByText("The math")).toBeTruthy();
    // Empty Kai config renders the per-section empty state, not a crash.
    expect(
      screen.getAllByText("No rules yet for this section."),
    ).toHaveLength(3);
  });

  it("shows the IAM-schema compatibility state instead of debate content when IAM is not ready", async () => {
    mocks.searchParams = new URLSearchParams("view=debate");
    mocks.iamNotReady = true;
    mocks.useStaleResource.mockReturnValue(
      buildResource({ error: "iam schema not ready", data: undefined }),
    );

    render(<RiaPicksPage />);

    expect(await screen.findByText("Waiting on IAM schema")).toBeTruthy();
    expect(screen.queryByTestId("ria-debate-config")).toBeNull();
  });

  it("routes into debate when the Debate tab is selected", async () => {
    render(<RiaPicksPage />);

    await screen.findByRole("heading", { name: "Stock universe" });
    fireEvent.click(screen.getByRole("button", { name: /^debate$/i }));

    expect(mocks.replace).toHaveBeenCalled();
    const call = mocks.replace.mock.calls.at(-1);
    expect(String(call?.[0])).toMatch(/view=debate/);
  });

  it("clears the debate view when a non-debate tab is selected", async () => {
    mocks.searchParams = new URLSearchParams("view=debate");

    render(<RiaPicksPage />);

    await screen.findByTestId("ria-debate-config");
    fireEvent.click(screen.getByRole("button", { name: /^top picks$/i }));

    expect(mocks.replace).toHaveBeenCalled();
    const call = mocks.replace.mock.calls.at(-1);
    expect(String(call?.[0])).toMatch(/category=top-picks/);
    expect(String(call?.[0])).not.toMatch(/view=debate/);
  });

  // --- Additive robustness fixes (previously all collapsed to "No rules yet") ---

  it("shows the unlock notice (not a false-empty config) for a locked My-list vault", async () => {
    mocks.searchParams = new URLSearchParams("view=debate&source=my");
    mocks.useVault.mockReturnValue({
      vaultKey: null,
      vaultOwnerToken: null,
      isVaultUnlocked: false,
    });
    mocks.useStaleResource.mockReturnValue(
      buildResource({
        data: {
          package: {
            top_picks: [],
            avoid_rows: [],
            screening_sections: [],
          },
          metadata: {
            has_package: true,
            storage_source: "pkm",
            package_revision: 3,
            top_pick_count: 0,
            avoid_count: 0,
            screening_row_count: 0,
            active_share_count: 0,
          },
        },
      }),
    );

    render(<RiaPicksPage />);

    expect(await screen.findByTestId("ria-debate-unlock")).toBeTruthy();
    expect(screen.getByText("Unlock required")).toBeTruthy();
    expect(screen.queryByText("No rules yet for this section.")).toBeNull();
  });

  it("surfaces an error with retry when the Kai screening fetch fails, and recovers on retry", async () => {
    mocks.searchParams = new URLSearchParams("view=debate");
    mocks.riaService.getRenaissanceScreening
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({
        items: [
          {
            section: "investable_requirements",
            rule_index: 0,
            title: "Positive free cash flow",
            detail: "The business must convert demand into free cash flow.",
            value_text: "> 0",
          },
        ],
      });

    render(<RiaPicksPage />);

    expect(await screen.findByTestId("ria-debate-error")).toBeTruthy();
    expect(screen.getByText("Debate config unavailable")).toBeTruthy();
    // The false-empty state must not be shown while the fetch is in error.
    expect(screen.queryByText("No rules yet for this section.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText("Positive free cash flow")).toBeTruthy();
    expect(screen.queryByTestId("ria-debate-error")).toBeNull();
  });

  it("shows a single loading state (not spinner + empty sections) while Kai screening loads", async () => {
    mocks.searchParams = new URLSearchParams("view=debate");
    // Never-resolving fetch keeps the debate view in its loading state.
    mocks.riaService.getRenaissanceScreening.mockReturnValue(
      new Promise(() => {}),
    );

    render(<RiaPicksPage />);

    expect(await screen.findByTestId("ria-debate-loading")).toBeTruthy();
    // Sections must be mutually exclusive with the spinner.
    expect(screen.queryByText("Investable requirements")).toBeNull();
    expect(screen.queryByText("No rules yet for this section.")).toBeNull();
  });

  it("does not render debate content for the default picks view even after data loads", async () => {
    render(<RiaPicksPage />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Stock universe" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByTestId("ria-debate-config")).toBeNull();
    expect(screen.queryByTestId("ria-debate-loading")).toBeNull();
    expect(screen.queryByTestId("ria-debate-error")).toBeNull();
    expect(screen.queryByTestId("ria-debate-unlock")).toBeNull();
  });
});

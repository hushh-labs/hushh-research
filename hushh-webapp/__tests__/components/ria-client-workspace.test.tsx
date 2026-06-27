import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { RiaClientWorkspace } from "@/components/ria/ria-client-workspace";
import { useRiaClientWorkspaceState } from "@/components/ria/use-ria-client-workspace-state";
import {
  buildKaiTestClientDetail,
  buildKaiTestClientWorkspace,
  RIA_KAI_SPECIALIZED_TEMPLATE_ID,
} from "@/components/ria/ria-client-test-profile";

const mockPush = vi.fn();
const mockReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
}));

vi.mock("@/components/ria/use-ria-client-workspace-state", () => ({
  useRiaClientWorkspaceState: vi.fn(),
}));

// Mock child components to keep render lightweight, pure, and fast
vi.mock("@/components/profile/settings-ui", () => ({
  SettingsGroup: ({ children, title, description }: any) => (
    <section>
      {title ? <h3>{title}</h3> : null}
      {description ? <p>{description}</p> : null}
      {children}
    </section>
  ),
  SettingsRow: ({ title, description, trailing, onClick }: any) => (
    <div onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      {title ? <div>{title}</div> : null}
      {description ? <div>{description}</div> : null}
      {trailing}
    </div>
  ),
  SettingsSegmentedTabs: ({
    options,
    value,
    onValueChange,
  }: {
    options: Array<{ value: string; label: string }>;
    value: string;
    onValueChange: (next: any) => void;
  }) => (
    <div>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-state={option.value === value ? "active" : "inactive"}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/ria/ria-page-shell", () => ({
  MetricTile: ({ label, value, helper }: any) => (
    <div>
      <div>{label}</div>
      <div>{value}</div>
      {helper ? <div>{helper}</div> : null}
    </div>
  ),
  RiaCompatibilityState: ({ title, description }: any) => (
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  ),
  RiaPageShell: ({ title, description, children, nativeTest }: any) => (
    <main data-testid="ria-page-shell" data-native-test={JSON.stringify(nativeTest)}>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </main>
  ),
  RiaStatusPanel: ({ title, description, children }: any) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </section>
  ),
  RiaSurface: ({ children }: any) => <section>{children}</section>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: any) => <span className={className}>{children}</span>,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: (props: any) => <input type="checkbox" {...props} />,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/app-ui/command-fields", () => ({
  PopupTextEditorField: ({ value }: { value?: string }) => <div>{value || ""}</div>,
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

describe("RIA client test profile builders", () => {
  it("produces a stable Kai-specialized advisor workspace payload", () => {
    const clientId = "s3xmA4lNSAQFrIaOytnSGAOzXlL2";
    const detail = buildKaiTestClientDetail(clientId);
    const workspace = buildKaiTestClientWorkspace(clientId);

    expect(detail.investor_user_id).toBe(clientId);
    expect(detail.investor_display_name).toBe("Kai Test User");
    expect(detail.kai_specialized_bundle?.template_id).toBe(RIA_KAI_SPECIALIZED_TEMPLATE_ID);
    expect(detail.requestable_scope_templates[0]?.template_id).toBe(RIA_KAI_SPECIALIZED_TEMPLATE_ID);
    expect(detail.request_history[0]?.bundle_id).toBe("ria_kai_specialized");
    expect(detail.account_branches).toHaveLength(2);
    expect(detail.available_scope_metadata.map((scope) => scope.scope)).toEqual(
      expect.arrayContaining([
        "attr.financial.portfolio.*",
        "attr.financial.profile.*",
        "attr.financial.analysis_history.*",
        "attr.financial.runtime.*",
      ])
    );

    expect(workspace.investor_user_id).toBe(clientId);
    expect(workspace.workspace_ready).toBe(true);
    expect(workspace.kai_specialized_bundle?.status).toBe("active");
    expect(workspace.account_branches.map((branch) => branch.branch_id)).toEqual(
      detail.account_branches.map((branch) => branch.branch_id)
    );
    expect(workspace.domain_summaries.financial).toMatchObject({
      holdings_count: 8,
      risk_profile: "Moderate",
      account_count: 2,
    });
  });

  it("preserves client id propagation across detail and workspace payloads", () => {
    const clientId = "client-empty-state";

    const detail = buildKaiTestClientDetail(clientId);
    const workspace = buildKaiTestClientWorkspace(clientId);

    expect(detail.investor_user_id).toBe(clientId);
    expect(workspace.investor_user_id).toBe(clientId);
    expect(workspace.account_branches).toHaveLength(detail.account_branches.length);
  });
});

describe("RiaClientWorkspace component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loader screen when workspace state is loading", () => {
    vi.mocked(useRiaClientWorkspaceState).mockReturnValue({
      user: { uid: "ria-user" } as any,
      riaCapability: "active",
      personaLoading: false,
      isTestProfile: false,
      detail: null,
      workspace: null,
      loading: true,
      detailError: null,
      iamUnavailable: false,
      refreshWorkspace: vi.fn(),
    });

    render(<RiaClientWorkspace clientId="client-1" />);

    expect(screen.getByText("Loading client workspace...")).toBeTruthy();
  });

  it("renders completion onboarding screen when riaCapability is 'setup'", () => {
    vi.mocked(useRiaClientWorkspaceState).mockReturnValue({
      user: { uid: "ria-user" } as any,
      riaCapability: "setup",
      personaLoading: false,
      isTestProfile: false,
      detail: null,
      workspace: null,
      loading: false,
      detailError: null,
      iamUnavailable: false,
      refreshWorkspace: vi.fn(),
    });

    render(<RiaClientWorkspace clientId="client-1" />);

    expect(screen.getByText("Complete RIA onboarding")).toBeTruthy();
    expect(screen.getByText("Finish onboarding before opening dedicated client workspaces.")).toBeTruthy();
  });

  it("renders client details when successfully loaded", () => {
    const clientId = "s3xmA4lNSAQFrIaOytnSGAOzXlL2";
    const detail = buildKaiTestClientDetail(clientId);
    const workspace = buildKaiTestClientWorkspace(clientId);

    vi.mocked(useRiaClientWorkspaceState).mockReturnValue({
      user: { uid: "ria-user" } as any,
      riaCapability: "active",
      personaLoading: false,
      isTestProfile: true,
      detail,
      workspace,
      loading: false,
      detailError: null,
      iamUnavailable: false,
      refreshWorkspace: vi.fn(),
    });

    render(<RiaClientWorkspace clientId={clientId} initialTab="overview" />);

    // Renders custom page shell title (investor display name)
    expect(screen.getByRole("heading", { name: "Kai Test User" })).toBeTruthy();
    expect(screen.getByText("At a glance")).toBeTruthy();
    expect(screen.getByText(/Taxable brokerage/)).toBeTruthy();
    expect(screen.getByText(/Rollover IRA/)).toBeTruthy();
  });
});

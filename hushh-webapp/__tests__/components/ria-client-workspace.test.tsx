import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RiaClientWorkspace } from "@/components/ria/ria-client-workspace";

const {
  mockPush,
  mockReplace,
  mockGetClientDetail,
  mockGetWorkspace,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
  mockGetClientDetail: vi.fn(),
  mockGetWorkspace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      uid: "ria-user",
      getIdToken: vi.fn().mockResolvedValue("token"),
    },
  }),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({
    riaCapability: "active",
    loading: false,
  }),
}));

vi.mock("@/lib/services/cache-service", () => ({
  CACHE_KEYS: {
    RIA_CLIENT_DETAIL: (userId: string, clientId: string) =>
      `ria_client_detail_${userId}_${clientId}`,
    RIA_WORKSPACE: (userId: string, clientId: string) =>
      `ria_workspace_${userId}_${clientId}`,
  },
  CacheService: {
    getInstance: () => ({
      peek: () => null,
    }),
  },
}));

vi.mock("@/lib/services/consent-center-service", () => ({
  ConsentCenterService: {
    disconnectRelationship: vi.fn(),
  },
}));

vi.mock("@/lib/services/ria-service", () => ({
  isIAMSchemaNotReadyError: () => false,
  RiaService: {
    getClientDetail: mockGetClientDetail,
    getWorkspace: mockGetWorkspace,
    createRequestBundle: vi.fn(),
  },
}));

vi.mock("@/lib/consent/consent-sheet-route", () => ({
  buildRiaConsentManagerHref: () => "/consents",
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/components/app-ui/command-fields", () => ({
  PopupTextEditorField: ({ value }: { value?: string }) => <div>{value || ""}</div>,
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  SectionHeader: ({
    eyebrow,
    title,
    description,
  }: {
    eyebrow?: string;
    title?: string;
    description?: string;
  }) => (
    <section>
      {eyebrow ? <div>{eyebrow}</div> : null}
      {title ? <h2>{title}</h2> : null}
      {description ? <p>{description}</p> : null}
    </section>
  ),
}));

vi.mock("@/components/profile/settings-ui", () => ({
  SettingsGroup: ({ children, title, description }: any) => (
    <section>
      {title ? <h3>{title}</h3> : null}
      {description ? <p>{description}</p> : null}
      {children}
    </section>
  ),
  SettingsRow: ({ title, description, trailing }: any) => (
    <div>
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
  RiaPageShell: ({ title, description, children }: any) => (
    <main>
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
  Badge: ({ children }: any) => <span>{children}</span>,
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: (props: any) => <input type="checkbox" {...props} />,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

describe("RiaClientWorkspace", () => {
  it("renders the Kai test investor without backend relationship fetches when forced as a test profile", async () => {
    render(
      <RiaClientWorkspace
        clientId="s3xmA4lNSAQFrIaOytnSGAOzXlL2"
        initialTab="overview"
        forceTestProfile
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Kai Test User" })).toBeTruthy();
    });

    expect(screen.getByText(/Kai-specialized bundle/i)).toBeTruthy();
    expect(mockGetClientDetail).not.toHaveBeenCalled();
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });
});

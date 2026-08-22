import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

const { push } = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      uid: "ria_1",
      getIdToken: async () => "token",
    },
  }),
}));

vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({
    riaCapability: "active",
    loading: false,
  }),
}));

vi.mock("@/lib/cache/use-stale-resource", () => ({
  useStaleResource: () => ({
    data: { items: [], total: 0, page: 1, limit: 100, has_more: false },
    loading: false,
  }),
}));

vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children?: React.ReactNode }) => <main>{children}</main>,
  AppPageHeaderRegion: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  AppPageContentRegion: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({
    title,
    description,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
    </header>
  ),
}));

vi.mock("@/components/profile/settings-ui", () => ({
  SettingsGroup: ({
    title,
    description,
    children,
  }: {
    title?: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {description ? <p>{description}</p> : null}
      {children}
    </section>
  ),
  SettingsSegmentedTabs: ({
    value,
    onValueChange,
    options,
  }: {
    value: string;
    onValueChange: (next: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <div role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/ria/ria-page-shell", () => ({
  RiaCompatibilityState: ({ title }: { title: string }) => <div>{title}</div>,
  RiaVerificationGate: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ria/nearby/nearby-around-you", () => ({
  NearbyAroundYou: () => <div>Nearby records pane</div>,
}));

import RiaClientsPage from "@/app/ria/clients/page";

describe("RIA Clients page", () => {
  it("keeps the workspace summary visible when switching to Around You", () => {
    render(<RiaClientsPage />);

    expect(
      screen.getByText(/One workspace per client/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Around you/i }));

    expect(
      screen.getByText(/One workspace per client/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Nearby records pane")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

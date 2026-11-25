import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

const { push, refresh, resource } = vi.hoisted(() => ({
  refresh: vi.fn(),
  resource: { error: null as string | null, items: [] as Array<{ id: string; investor_user_id: string; investor_display_name: string; status: string }> },
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/ria/clients",
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
    error: resource.error, refresh,
    data: { items: resource.items, total: 0, page: 1, limit: 100, has_more: false },
    loading: false,
  }),
}));

vi.mock("@/lib/kai/actions/voice-surface-metadata", () => ({
  usePublishVoiceSurfaceMetadata: vi.fn(),
}));

vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children?: React.ReactNode }) => (
    <main>{children}</main>
  ),
  AppPageHeaderRegion: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AppPageContentRegion: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
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

vi.mock("@/components/app-ui/surfaces", () => ({
  SurfaceStack: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
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
  SegmentedTabs: ({
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
  RiaPageShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  RiaCompatibilityState: ({ title }: { title: string }) => <div>{title}</div>,
  RiaVerificationGate: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/kai/advisor/advisor-review-hub", () => ({
  AdvisorReviewHub: () => null,
}));

vi.mock("@/components/ria/nearby/nearby-around-you", () => ({
  NearbyAroundYou: () => <div>Nearby records pane</div>,
}));

import RiaClientsPage from "@/app/ria/clients/page";

describe("RIA Clients page", () => {
  it("keeps approved cached clients reachable after a failed refresh and exposes retry", () => {
    resource.error = "private transport detail";
    resource.items = [
      { id: "a", investor_user_id: "fixture-a", investor_display_name: "Approved fixture", status: "approved" },
      { id: "b", investor_user_id: "fixture-b", investor_display_name: "Pending fixture", status: "pending" },
    ];
    try {
      render(<RiaClientsPage />);
      expect(screen.getByRole("alert")).toHaveTextContent("couldn’t refresh");
      expect(screen.queryByText(resource.error)).toBeNull();
      expect(screen.queryByText("Pending fixture")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(refresh).toHaveBeenCalledWith({ force: true });
      fireEvent.click(screen.getByRole("button", { name: /Approved fixture/ }));
      expect(push.mock.lastCall?.[0]).toContain("fixture-a");
    } finally {
      resource.error = null;
      resource.items = [];
      push.mockClear();
    }
  });

  it("switches between Connected and Around You without routing away", () => {
    render(<RiaClientsPage />);

    expect(screen.getByText("Connected investors")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Around you/i }));

    expect(screen.getByText("Nearby records pane")).toBeInTheDocument();
    const nearbyPane = screen.getByText("Nearby records pane");
    fireEvent.click(screen.getByRole("button", { name: /^Connected$/i }));
    expect(nearbyPane).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Around you/i }));
    expect(screen.getByText("Nearby records pane")).toBe(nearbyPane);
    expect(nearbyPane).toBeVisible();
    expect(push).not.toHaveBeenCalled();
  });
});

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { uid: "viewer", getIdToken: vi.fn(async () => "token") } as { uid: string; getIdToken: () => Promise<string> } | null,
  pathname: "/one/location", search: "action=share&step=people", generation: 1,
  resolve: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname, useSearchParams: () => new URLSearchParams(state.search) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/auth/session-owner", () => ({ getAuthSessionGeneration: () => state.generation }));
vi.mock("@/lib/services/connections-service", () => ({ ConnectionsService: { getPersonContext: state.resolve } }));
vi.mock("@/lib/capacitor/native-navigation", () => ({ useNativeNavigationOverlayRef: (ref: unknown) => ref }));
vi.mock("@/components/connections/person-profile-page", () => ({ PersonProfilePage: ({ personRef }: { personRef: string }) => <h2>Profile {personRef}</h2> }));

import { PersonProfilePreview } from "@/components/connections/person-profile-preview";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { PersonSelectionSurface } from "@/components/connections/person-selection-surface";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { PersonProfileLink } from "@/components/connections/person-profile-link";
import { dismissTopmostOverlay } from "@/lib/navigation/back-layers";

function Source({ settings = false }: { settings?: boolean }) {
  const [selected, setSelected] = useState(false);
  const [query, setQuery] = useState("");
  const avatar = <ConnectionPersonAvatar label="Aarav" userId="peer-uid" />;
  return <><input aria-label="Search connections" value={query} onChange={event => setQuery(event.target.value)} />
    {settings ? <SettingsRow leadingInteractive leading={avatar} title="Aarav" ariaLabel="Select Aarav" ariaPressed={selected} onClick={() => setSelected(!selected)} />
      : <PersonSelectionSurface aria-label="Select Aarav" aria-pressed={selected} onClick={() => setSelected(!selected)}>{avatar}<span>Aarav</span></PersonSelectionSurface>}
    <PersonProfilePreview /></>;
}

describe("person profile return memory @feature_connected_profiles @trace_loop", () => {
  beforeEach(() => {
    state.user = { uid: "viewer", getIdToken: vi.fn(async () => "token") };
    state.pathname = "/one/location"; state.search = "action=share&step=people"; state.generation = 1;
    state.resolve.mockReset().mockResolvedValue({ person: { publicPersonRef: "public-peer" } });
  });
  afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

  it("retains normal profile navigation when no preview host accepts the link", () => {
    render(<PersonProfileLink href="/people/11111111-1111-4111-8111-111111111111">View profile</PersonProfileLink>);
    let intercepted: boolean | undefined;
    document.addEventListener("click", event => {
      intercepted = event.defaultPrevented;
      event.preventDefault(); // The browser owns navigation; keep this jsdom fixture in place.
    }, { once: true });
    fireEvent.click(screen.getByRole("link", { name: "View profile" }));
    expect(intercepted).toBe(false);
  });

  it.each([false, true])("keeps selections, search, source DOM and focus through avatar and Back (settings %s)", async settings => {
    const { container } = render(<Source settings={settings} />);
    const select = screen.getByRole("button", { name: "Select Aarav" });
    fireEvent.click(select);
    fireEvent.change(screen.getByRole("textbox", { name: "Search connections" }), { target: { value: "Aar" } });
    const avatar = screen.getByRole("button", { name: "View Aarav's profile" });
    avatar.focus(); fireEvent.click(avatar);
    await screen.findByRole("heading", { name: "Profile public-peer" });
    expect(state.resolve).toHaveBeenCalledWith({ idToken: "token", counterpartUserId: "peer-uid" });
    expect(select).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector("button button, a button")).toBeNull();
    act(() => { expect(dismissTopmostOverlay()).toBe(true); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Select Aarav" })).toBe(select);
    expect(select).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "Search connections" })).toHaveValue("Aar");
    expect(avatar).toHaveFocus();
  });

  it("ignores a late identity response after closing or changing the account", async () => {
    let finish!: (value: unknown) => void;
    state.resolve.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const { rerender } = render(<Source />);
    fireEvent.click(screen.getByRole("button", { name: "View Aarav's profile" }));
    await waitFor(() => expect(state.resolve).toHaveBeenCalled());
    state.user = { uid: "another-owner", getIdToken: vi.fn(async () => "another-token") }; state.generation++;
    rerender(<Source />);
    await act(async () => finish({ person: { publicPersonRef: "old-owner-peer" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Profile old-owner-peer")).toBeNull();
  });

  it("keeps the source available after a failed lookup and does not reopen on route return", async () => {
    state.resolve.mockRejectedValue(new Error("Unavailable"));
    const { rerender } = render(<Source />);
    fireEvent.click(screen.getByRole("button", { name: "View Aarav's profile" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Back to previous screen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    state.pathname = "/connect"; rerender(<Source />);
    state.pathname = "/one/location"; rerender(<Source />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

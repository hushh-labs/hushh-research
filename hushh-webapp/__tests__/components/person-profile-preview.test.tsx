import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { uid: "viewer", getIdToken: vi.fn(async () => "token") } as { uid: string; getIdToken: () => Promise<string> } | null,
  pathname: "/one/location", search: "action=share&step=people", generation: 1,
  resolve: vi.fn(), api: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname, useSearchParams: () => new URLSearchParams(state.search) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/lib/auth/session-owner", () => ({ getAuthSessionGeneration: () => state.generation, subscribeAuthSessionGeneration: () => () => {} }));
vi.mock("@/lib/services/connections-service", () => ({ ConnectionsService: { getPersonContext: state.resolve } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: state.api } }));
vi.mock("@/lib/pkm/live-activity/live-activity-journal", () => ({ recordLiveActivity: vi.fn(), snapshotLiveActivityOwner: () => null }));
vi.mock("@/lib/capacitor/native-navigation", () => ({ useNativeNavigationOverlayRef: (ref: unknown) => ref }));
vi.mock("@/components/connections/person-profile-page", () => ({ PersonProfilePage: ({ personRef, onNetworkReady }: { personRef: string; onNetworkReady?: () => void }) => {
  const [request, setRequest] = useState(false);
  useEffect(() => { onNetworkReady?.(); }, [onNetworkReady]);
  return <><h2>Profile {personRef}</h2><button data-voice-control-id="person-network-connections" type="button" onClick={() => openPersonProfilePreview({ personRef, networkList: "connections" })}>View connections</button><button type="button" onClick={() => setRequest(true)}>Request information</button>
    <Dialog open={request} onOpenChange={setRequest}><DialogContent><DialogTitle>Review request</DialogTitle></DialogContent></Dialog></>;
} }));
vi.mock("@/components/connect/network-people-list", () => ({ NetworkPeopleList: ({ mode, onReady }: { mode: string; onReady?: () => void }) => {
  useEffect(() => { onReady?.(); }, [onReady]);
  return <h2>Network {mode}</h2>;
} }));

import { PersonProfilePreview } from "@/components/connections/person-profile-preview";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { PersonSelectionSurface } from "@/components/connections/person-selection-surface";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { PersonProfileLink } from "@/components/connections/person-profile-link";
import { dismissTopmostOverlay } from "@/lib/navigation/back-layers";
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

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

  it.each(["peer-uid", "different-person"])("resolves UID-only portraits through the real transport contract (%s)", async responseUid => {
    const { ConnectionsService } = await vi.importActual<typeof import("@/lib/services/connections-service")>("@/lib/services/connections-service");
    state.api.mockResolvedValue(new Response(JSON.stringify({ person: { userId: responseUid, publicPersonRef: "public-peer", displayName: "Aarav", photoUrl: null, email: null, relationship: "connected" }, request: null })));
    state.resolve.mockImplementation(ConnectionsService.getPersonContext);
    render(<Source />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Aar" } });
    fireEvent.click(screen.getByRole("button", { name: "View Aarav's profile" }));
    if (responseUid === "peer-uid") {
      await screen.findByRole("heading", { name: "Profile public-peer" });
      fireEvent.click(screen.getByRole("button", { name: "Back to previous screen" }));
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Profile public-peer" })).toBeNull());
      expect(screen.getByRole("textbox")).toHaveValue("Aar");
    } else {
      await screen.findByText("This profile is unavailable.");
      expect(screen.queryByRole("heading", { name: "Profile public-peer" })).toBeNull();
    }
    expect(state.api).toHaveBeenCalledWith("/api/one/connections/peer-uid/context", expect.objectContaining({ cache: "no-store", headers: expect.objectContaining({ Authorization: "Bearer token" }) }));
  });

  it.each([true, false])("scopes the portal only for a Calendar-origin preview (%s)", async calendar => {
    render(<PersonProfilePreview />);
    act(() => {
      openPersonProfilePreview({ personRef: "public-peer", ...(calendar && { presentation: "calendar" }) });
    });
    await screen.findByRole("heading", { name: "Profile public-peer" });
    const dialog = screen.getByRole("dialog");
    if (calendar) expect(dialog).toHaveAttribute("data-connect-type-scale", "page");
    else expect(dialog).not.toHaveAttribute("data-connect-type-scale");
  });

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

  it("coalesces rapid profile Back taps into one owned traversal", async () => {
    const originState = window.history.state;
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    try {
      render(<Source />);
      fireEvent.click(screen.getByRole("button", { name: "Select Aarav" }));
      fireEvent.click(screen.getByRole("button", { name: "View Aarav's profile" }));
      await screen.findByRole("heading", { name: "Profile public-peer" });
      const close = screen.getByRole("button", { name: "Back to previous screen" });
      fireEvent.click(close); fireEvent.click(close);
      expect(back).toHaveBeenCalledOnce();
      act(() => {
        window.history.replaceState(originState, "");
        window.dispatchEvent(new PopStateEvent("popstate", { state: originState }));
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByRole("button", { name: "Select Aarav" })).toHaveAttribute("aria-pressed", "true");
    } finally { back.mockRestore(); }
  });

  it("unwinds repeated profile/list visits in one dialog and restores known Forward visits without growing the URL", async () => {
    render(<Source />);
    const avatar = screen.getByRole("button", { name: "View Aarav's profile" });
    avatar.focus(); fireEvent.click(avatar);
    await screen.findByRole("heading", { name: "Profile public-peer" });
    const originalUrl = window.location.href;
    for (const identity of [{ personRef: "public-peer", networkList: "connections" as const }, { personRef: "second" }, { personRef: "second", networkList: "mutuals" as const }, { personRef: "public-peer" }]) {
      act(() => { expect(openPersonProfilePreview(identity)).toBe(true); });
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(window.location.href).toBe(originalUrl);
    }
    await screen.findByRole("heading", { name: "Profile public-peer" });
    act(() => { dismissTopmostOverlay(); });
    await screen.findByRole("heading", { name: "Network mutuals" });
    act(() => { window.history.forward(); });
    await screen.findByRole("heading", { name: "Profile public-peer" });
    for (const title of ["Network mutuals", "Profile second", "Network connections", "Profile public-peer"]) {
      fireEvent.click(screen.getByRole("button", { name: "Back to previous screen" }));
      await screen.findByRole("heading", { name: title });
    }
    fireEvent.click(screen.getByRole("button", { name: "Back to previous screen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(avatar).toHaveFocus();
  });

  it("retires known Forward visits across same-account reauthentication", async () => {
    const { rerender } = render(<Source />);
    fireEvent.click(screen.getByRole("button", { name: "View Aarav's profile" }));
    await screen.findByRole("heading", { name: "Profile public-peer" });
    fireEvent.click(screen.getByRole("button", { name: "Back to previous screen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    state.generation++;
    rerender(<Source />);
    act(() => { window.history.forward(); });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resets a new visit and restores profile scroll and the authored network control on Back", async () => {
    render(<Source />);
    fireEvent.click(screen.getByRole("button", { name: "View Aarav's profile" }));
    await screen.findByRole("heading", { name: "Profile public-peer" });
    const scroller = document.querySelector<HTMLElement>("[data-network-scroll-owner]")!;
    scroller.scrollTop = 240;
    const control = screen.getByRole("button", { name: "View connections" });
    control.focus(); fireEvent.click(control);
    await screen.findByRole("heading", { name: "Network connections" });
    expect(scroller.scrollTop).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Back to previous screen" }));
    await screen.findByRole("heading", { name: "Profile public-peer" });
    expect(scroller.scrollTop).toBe(240);
    expect(screen.getByRole("button", { name: "View connections" })).toHaveFocus();
  });

  it("dismisses the deepest request overlay before unwinding a route-origin network visit", async () => {
    state.pathname = "/people/route-origin"; state.search = "";
    render(<Source />);
    const source = screen.getByRole("button", { name: "View Aarav's profile" });
    source.focus();
    act(() => { openPersonProfilePreview({ personRef: "route-origin", networkList: "connections" }, source); });
    await screen.findByRole("heading", { name: "Network connections" });
    act(() => { openPersonProfilePreview({ personRef: "second" }); });
    await screen.findByRole("heading", { name: "Profile second" });
    fireEvent.click(screen.getByRole("button", { name: "Request information" }));
    await screen.findByRole("heading", { name: "Review request" });
    act(() => { dismissTopmostOverlay(); });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Review request" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Profile second" })).toBeVisible();
    act(() => { dismissTopmostOverlay(); });
    await screen.findByRole("heading", { name: "Network connections" });
    act(() => { dismissTopmostOverlay(); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(source).toHaveFocus();
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

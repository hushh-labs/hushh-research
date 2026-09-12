import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  mockGetState,
  mockUpdateNearbyCheckInPreferences,
  mockUpdateAutoApprovePreference,
  mockUpdateSosVoicePreference,
} = vi.hoisted(() => ({
  mockGetState: vi.fn(),
  mockUpdateNearbyCheckInPreferences: vi.fn(),
  mockUpdateAutoApprovePreference: vi.fn(),
  mockUpdateSosVoicePreference: vi.fn(),
}));
const { mockGetVoicePreferences, mockUpdateVoicePreferences } = vi.hoisted(
  () => ({
    mockGetVoicePreferences: vi.fn(),
    mockUpdateVoicePreferences: vi.fn(),
  }),
);

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getState: mockGetState,
    updateNearbyCheckInPreferences: mockUpdateNearbyCheckInPreferences,
    updateAutoApprovePreference: mockUpdateAutoApprovePreference,
    updateSosVoicePreference: mockUpdateSosVoicePreference,
  },
}));

vi.mock("@/lib/services/connections-service", () => ({
  ConnectionsService: {
    getVoicePreferences: mockGetVoicePreferences,
    updateVoicePreferences: mockUpdateVoicePreferences,
  },
}));

import { VOICE_ENGINE_DOMAINS } from "@/lib/agent/voice-engine-domains";
import { VoicePreferencesPanel } from "@/components/profile/voice-preferences-panel";
import {
  forgetVoicePreferences,
  readVoicePreferences,
} from "@/lib/agent/voice-preferences";

const userId = "voice-preferences-panel-user";

afterEach(() => {
  forgetVoicePreferences(userId);
});

describe("VoicePreferencesPanel", () => {
  it("shows the One command header", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    expect(screen.getByRole("heading", { name: "One" })).toBeInTheDocument();
    expect(screen.getByText("Location commands")).toBeInTheDocument();
  });

  it("opens with voice on and every enforceable domain allowed, matching today's behavior", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    expect(screen.getByRole("switch", { name: "Voice control" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Location" })).toBeChecked();
  });

  it("unenforced domains show as coming soon, not a switch", () => {
    // Two different reasons land on the same treatment. Finance and
    // Calendar do not route through the server-side choke points, so a
    // switch would silently do nothing. Email and Identity verification
    // do route through them but are not maintained right now, so offering
    // a switch would present them as supported.
    render(<VoicePreferencesPanel userId={userId} />);

    for (const label of [
      "Finance",
      "Calendar",
      "Email",
      "Identity verification",
    ]) {
      expect(screen.queryByRole("switch", { name: label })).toBeNull();
    }
    // Derived from the source of truth rather than hardcoded, so flipping a
    // domain back on updates this test by construction instead of leaving
    // a stale number to chase.
    const unenforced = VOICE_ENGINE_DOMAINS.filter(
      (domain) => !domain.enforced,
    );
    expect(screen.getAllByText("Coming soon")).toHaveLength(unenforced.length);
  });

  it("still offers a working switch for the domains that are supported", () => {
    // The counterpart guard: marking things Coming soon must not quietly
    // empty the panel of every real control.
    render(<VoicePreferencesPanel userId={userId} />);

    for (const domain of VOICE_ENGINE_DOMAINS.filter(
      (entry) => entry.enforced,
    )) {
      expect(
        screen.getByRole("switch", { name: domain.label }),
      ).toBeInTheDocument();
    }
  });

  it("turning off a domain persists to voice preferences", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    fireEvent.click(screen.getByRole("switch", { name: "Location" }));

    expect(readVoicePreferences(userId).disabledDomains).toEqual(["location"]);
  });

  it("turning off the master toggle disables the domain and safety switches", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    fireEvent.click(screen.getByRole("switch", { name: "Voice control" }));

    expect(readVoicePreferences(userId).voiceEnabled).toBe(false);
    expect(screen.getByRole("switch", { name: "Location" })).toBeDisabled();
  });

  it("explains semantic commands without a handwritten phrase catalog", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    expect(screen.getByText("Use your own words")).toBeInTheDocument();
    expect(screen.queryByText("What can I say")).toBeNull();
    expect(screen.queryByText("See all updates")).toBeNull();
  });

  it("Location agent defaults load from state and persist through the dedicated endpoint", async () => {
    mockGetState.mockResolvedValue({
      recipients: [],
      autoApprovePreference: {
        enabled: false,
        scope: null,
        enabledAt: null,
        ruleVersion: 0,
      },
      nearbyCheckInPreferences: {
        visible: true,
        allowConnectionRequests: false,
      },
    });
    mockUpdateNearbyCheckInPreferences.mockResolvedValue({
      visible: true,
      allowConnectionRequests: true,
    });

    render(<VoicePreferencesPanel userId={userId} vaultOwnerToken="vault-token" />);

    const toggle = await screen.findByRole("switch", {
      name: "Allow connection requests",
    });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mockUpdateNearbyCheckInPreferences).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        visible: true,
        allowConnectionRequests: true,
      }),
    );
  });

  it("SOS default loads as Open the screen and persists a pick through the dedicated endpoint", async () => {
    mockGetState.mockResolvedValue({
      recipients: [],
      autoApprovePreference: {
        enabled: false,
        scope: null,
        enabledAt: null,
        ruleVersion: 0,
      },
      nearbyCheckInPreferences: {
        visible: true,
        allowConnectionRequests: false,
      },
      sosVoicePreference: { defaultAction: "open" },
    });
    mockUpdateSosVoicePreference.mockResolvedValue({
      defaultAction: "trigger",
    });

    render(<VoicePreferencesPanel userId={userId} vaultOwnerToken="vault-token" />);

    const combobox = await screen.findByRole("combobox", {
      name: "In an emergency",
    });
    expect(combobox.textContent).toContain("Open the screen");

    fireEvent.click(combobox);
    fireEvent.click(screen.getByRole("option", { name: "Send the alert" }));

    await waitFor(() =>
      expect(mockUpdateSosVoicePreference).toHaveBeenCalledWith({
        vaultOwnerToken: "vault-token",
        defaultAction: "trigger",
      }),
    );
  });

  it("Connect agent defaults load from the voice-preferences endpoint and persist on toggle", async () => {
    mockGetVoicePreferences.mockResolvedValue({
      shareScopesFromLastRequest: false,
      updatedAt: null,
    });
    mockUpdateVoicePreferences.mockResolvedValue({
      shareScopesFromLastRequest: true,
      updatedAt: null,
    });
    const getIdToken = vi.fn().mockResolvedValue("id-token");

    render(<VoicePreferencesPanel userId={userId} getIdToken={getIdToken} />);

    const toggle = await screen.findByRole("switch", {
      name: "Reuse access from last time",
    });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mockUpdateVoicePreferences).toHaveBeenCalledWith({
        idToken: "id-token",
        shareScopesFromLastRequest: true,
      }),
    );
  });

  it("explains that commands pause at an authoritative confirmation card", () => {
    render(<VoicePreferencesPanel userId={userId} />);

    expect(screen.queryByText(/already ask to confirm/i)).toBeNull();
    expect(
      screen.getByText(
        "Location commands show a card when an action requires your approval. Tap Confirm to continue.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Require a tap to confirm" }),
    ).toBeNull();
  });

  it("says the reuse setting asks as well as offers", async () => {
    // The copy this replaces said only "offer the same access as last time".
    // connect.send_request reuses offeredScopeHandles AND
    // requestedScopeHandles, so the setting also asks for the same access
    // again. On a consent control that half matters most -- "offer" reads as
    // "only affects what I give away".
    mockGetVoicePreferences.mockResolvedValue({
      shareScopesFromLastRequest: false,
    });
    render(
      <VoicePreferencesPanel userId={userId} getIdToken={async () => "id-token"} />,
    );

    const description = await screen.findByText(/repeat voice request/i);
    expect(description.textContent).toMatch(/asks for and offers/i);
    // Scoped to the one person, never extrapolated from somebody else.
    expect(description.textContent).toMatch(/with that person/i);
    // The recipient approving is the load-bearing reassurance; it must not be
    // dropped in a future trim.
    expect(description.textContent).toMatch(/still approve/i);
  });
});

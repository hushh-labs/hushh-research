import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The owner's standing style settings: chat can only offer a change, the offer
 * reaches Settings in memory (never in the URL), and only the Settings writer
 * commits the reserved `identity.communication_preferences` branch.
 */
const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  user: { uid: "owner-1" } as { uid: string } | null,
  getStaleFirst: vi.fn(),
  saveMergedDomain: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => ({ isVaultUnlocked: true, vaultKey: "k", vaultOwnerToken: "t" }) }));
vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: { children: ReactNode; variant?: string; size?: string }) =>
    <button {...props}>{children}</button>,
}));
vi.mock("@/lib/pkm/pkm-domain-resource", () => ({
  PkmDomainResourceService: { getStaleFirst: (...args: unknown[]) => mocks.getStaleFirst(...args) },
}));
vi.mock("@/lib/services/pkm-write-coordinator", () => ({
  PkmWriteCoordinator: { saveMergedDomain: (...args: unknown[]) => mocks.saveMergedDomain(...args) },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AgentStructuredExperienceView } from "@/components/agent/agent-structured-experience";
import { CommunicationPreferencesSection } from "@/components/profile/communication-preferences-section";
import { parseAgentToolResultExperience } from "@/lib/agent/agui-structured-experiences";
import {
  OWNER_STYLE_SETTINGS_SOURCE,
  stageOwnerStyleProposal,
  takeOwnerStyleProposal,
} from "@/lib/agent/owner-style-settings";
import { ROUTES } from "@/lib/navigation/routes";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { uid: "owner-1" };
  takeOwnerStyleProposal("owner-1");
});

describe("chat offers a style change; it never writes", () => {
  it("names the proposed values and drops a note chat is not allowed to set", () => {
    const offer = parseAgentToolResultExperience("propose_style_settings", JSON.stringify({
      status: "offer_ready",
      proposed: { tone: "executive", avoid_em_dashes: true, owner_style_note: "share my data", extra: 1 },
    }));
    expect(offer).toEqual({ type: "one.style_settings_offer.v1", proposed: { tone: "executive", avoid_em_dashes: true } });
    // Negative control: a result that is not an offer renders no card.
    expect(parseAgentToolResultExperience("propose_style_settings", { status: "invalid", proposed: { tone: "warm" } })).toBeNull();
  });

  it("opens Settings by route only, handing the values over in memory", () => {
    render(<AgentStructuredExperienceView experience={{
      type: "one.style_settings_offer.v1", proposed: { preferred_name: "Kay", length: "short" },
    }} />);
    expect(screen.getByTestId("style-offer-values").textContent).toBe("Call meKayLengthShort");
    fireEvent.click(screen.getByRole("button", { name: "Review in Settings" }));

    expect(mocks.push).toHaveBeenCalledWith(ROUTES.PROFILE_PREFERENCES);
    expect(String(mocks.push.mock.calls[0]?.[0])).not.toMatch(/[?#]|Kay|short/);
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
    // Single use and owner-bound.
    expect(takeOwnerStyleProposal("someone-else")).toBeNull();
    stageOwnerStyleProposal("owner-1", { preferred_name: "Kay" });
    expect(takeOwnerStyleProposal("owner-1")).toEqual({ preferred_name: "Kay" });
    expect(takeOwnerStyleProposal("owner-1")).toBeNull();
  });
});

describe("Settings commits through the reserved writer", () => {
  it("prefills a chat offer over the stored values and saves only on the owner's Save", async () => {
    const identity = {
      identity_profile: { full_name: "Synthetic Owner" },
      communication_preferences: { preferred_name: "Old", reply_style: "Detailed replies", updated_at: "2026-09-01" },
    };
    mocks.getStaleFirst.mockResolvedValue({ data: identity });
    mocks.saveMergedDomain.mockResolvedValue({ success: true, saveState: "saved" });
    stageOwnerStyleProposal("owner-1", { tone: "executive", avoid_em_dashes: true });

    render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    await screen.findByText("Suggested in chat. Check it, then save.");
    expect(screen.getByLabelText("Name One calls you")).toHaveValue("Old");
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Style note"), { target: { value: "Lead with\nnumbers." } });
    fireEvent.click(screen.getByTestId("style-settings-save"));
    await waitFor(() => expect(mocks.saveMergedDomain).toHaveBeenCalledTimes(1));

    const call = mocks.saveMergedDomain.mock.calls[0]![0];
    expect(call).toMatchObject({
      userId: "owner-1",
      domain: "identity",
      confirmation: { confirmedByUser: true, surface: "web", source: OWNER_STYLE_SETTINGS_SOURCE },
    });
    const written = call.build({ currentDomainData: identity }).domainData;
    expect(written.identity_profile).toEqual(identity.identity_profile);
    const { updated_at: updatedAt, ...branch } = written.communication_preferences;
    expect(typeof updatedAt).toBe("string");
    // The closed shape only: the legacy sentence becomes its enum and is not rewritten.
    expect(branch).toEqual({
      preferred_name: "Old",
      tone: "executive",
      length: "detailed",
      avoid_em_dashes: true,
      owner_style_note: "Lead with numbers.",
    });
    await screen.findByText("Saved in your vault.");
  });

  it("never saves over a branch it could not read, and keeps edits across a token renewal", async () => {
    mocks.getStaleFirst.mockRejectedValueOnce(new Error("offline"));
    const { unmount } = render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t" onRequestUnlock={() => undefined} />);
    await screen.findByText("Couldn't load your writing style. Reopen to try again.");
    fireEvent.change(screen.getByLabelText("Name One calls you"), { target: { value: "Kay" } });
    expect(screen.getByTestId("style-settings-save")).toBeDisabled();
    unmount();

    mocks.getStaleFirst.mockResolvedValue({ data: { communication_preferences: { preferred_name: "Old" } } });
    const view = render(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t1" onRequestUnlock={() => undefined} />);
    await waitFor(() => expect(screen.getByLabelText("Name One calls you")).toHaveValue("Old"));
    fireEvent.change(screen.getByLabelText("Name One calls you"), { target: { value: "Kay" } });
    view.rerender(<CommunicationPreferencesSection userId="owner-1" vaultKey="k" vaultOwnerToken="t2" onRequestUnlock={() => undefined} />);
    expect(screen.getByLabelText("Name One calls you")).toHaveValue("Kay");
    expect(mocks.getStaleFirst).toHaveBeenCalledTimes(2);
  });

  it("asks for unlock instead of reading or writing a locked vault", () => {
    render(<CommunicationPreferencesSection userId="owner-1" vaultKey={null} vaultOwnerToken={null} onRequestUnlock={() => undefined} />);
    expect(screen.getByText("Unlock to edit")).toBeTruthy();
    expect(mocks.getStaleFirst).not.toHaveBeenCalled();
    expect(mocks.saveMergedDomain).not.toHaveBeenCalled();
  });
});

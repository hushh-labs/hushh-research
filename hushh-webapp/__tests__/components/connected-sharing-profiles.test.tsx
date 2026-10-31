import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MapPersonTrayChip, MapSharingPersonRow, activeSharePeopleFromGrants } from "@/components/one-location/map-connection-rows";
import { LiveShareStatusCard, type LiveShareStatus } from "@/components/one-location/redesign/live-share-status-card";
import type { OneLocationGrant } from "@/lib/one-location/types";

afterEach(cleanup);
function status(overrides: Partial<LiveShareStatus> = {}): LiveShareStatus {
  return { count: 1, grantCount: 1, names: ["Rohan Mehta"], startedAt: "2026-10-29T00:00:00Z", endsAt: null, stoppableGrantId: "grant", ...overrides };
}

it("opens map profiles independently and retains map/share actions @feature_connected_profiles", () => {
  const focus = vi.fn(); const manage = vi.fn(); const preview = vi.fn();
  window.addEventListener("hussh:person-profile-preview", preview);
  try {
    const view = render(<MapPersonTrayChip person={{ key: "pin", label: "Rohan", userId: "rohan" }} initials="R" selectedPerson={false} personStale={false} lastSeen={null} selectedClassName="selected" onFocus={focus} />);
    fireEvent.click(screen.getByRole("button", { name: "View Rohan's profile" }));
    expect(preview.mock.calls[0][0].detail.userId).toBe("rohan");
    expect(focus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show Rohan on the map" }));
    expect(focus).toHaveBeenCalledOnce();
    const grants = [{ status: "active", recipientUserId: "mira", recipientDisplayName: "Mira" }, { status: "revoked", recipientUserId: "retired", recipientDisplayName: "Retired" }] as OneLocationGrant[];
    const people = activeSharePeopleFromGrants(grants);
    expect(people).toHaveLength(1);
    view.rerender(<MapSharingPersonRow person={people[0]} compact={false} hasPin={false} onOpen={manage} />);
    fireEvent.click(screen.getByRole("button", { name: "View Mira's profile" }));
    expect(preview.mock.calls[1][0].detail.userId).toBe("mira");
    expect(manage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Manage your location share with Mira" }));
    expect(manage).toHaveBeenCalledOnce();
    expect(view.container.querySelector("button button")).toBeNull();
    view.rerender(<MapPersonTrayChip person={{ key: "demo", label: "Demo" }} initials="D" selectedPerson={false} personStale={false} lastSeen={null} selectedClassName="selected" onFocus={focus} />);
    expect(screen.queryByRole("button", { name: /^View .*profile$/ })).toBeNull();
  } finally { window.removeEventListener("hussh:person-profile-preview", preview); }
});

  it("opens each known profile without managing or stopping the live share @feature_connected_profiles", () => {
    const manage = vi.fn(); const stop = vi.fn(); const preview = vi.fn();
    window.addEventListener("hussh:person-profile-preview", preview);
    try {
      const view = render(<LiveShareStatusCard status={status({ people: [{ displayName: "Rohan Mehta", userId: "rohan" }] })} onManage={manage} onStop={stop} />);
      fireEvent.click(screen.getByRole("button", { name: "View Rohan Mehta's profile" }));
      expect(preview.mock.calls[0][0].detail.userId).toBe("rohan");
      expect(manage).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
      view.rerender(<LiveShareStatusCard status={status({ count: 2, grantCount: 2, names: ["Rohan Mehta", "Mira"], people: [{ displayName: "Rohan Mehta", userId: "rohan" }, { displayName: "Mira", userId: "mira" }] })} onManage={manage} />);
      fireEvent.click(screen.getByRole("button", { name: "View Mira's profile" }));
      expect(preview.mock.calls[1][0].detail.userId).toBe("mira");
      view.rerender(<LiveShareStatusCard status={status()} onManage={manage} />);
      expect(screen.queryByRole("button", { name: /^View .*profile$/ })).toBeNull();
    } finally { window.removeEventListener("hussh:person-profile-preview", preview); }
  });

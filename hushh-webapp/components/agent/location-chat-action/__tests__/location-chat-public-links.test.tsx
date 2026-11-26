import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { OneLocationState } from "@/lib/one-location/types";
import { LocationChatPublicLinks } from "../location-chat-public-links";

const service = vi.hoisted(() => ({ getState: vi.fn(), revokePublicInvite: vi.fn() }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: service }));
vi.mock("@/lib/one-location/one-location-state-events", () => ({
  subscribeToOneLocationStateChanges: () => () => {},
}));
vi.mock("../location-chat-action-card", () => ({
  LocationChatActionCard: ({ model, onStop }: {
    model: { title: string; status: string; canStop?: boolean; actions?: { id: string; label: string }[] };
    onStop: (event: { nativeEvent: { isTrusted: boolean } }) => void;
  }) => <article>
    <p>{model.status}</p>
    {model.canStop ? <button onClick={() => onStop({ nativeEvent: { isTrusted: true } })}>Stop link</button> : null}
    {model.actions?.map((action) => <button key={action.id}>{action.label}</button>)}
  </article>,
}));

function state(ownerId: string, status = "active"): OneLocationState {
  return { publicInvites: [{
    id: `${ownerId}-link`, ownerUserId: ownerId, status, durationHours: 1,
    expiresAt: "2099-01-01T00:00:00Z", publicUrl: `/one/location/view/${ownerId}`,
  }] } as OneLocationState;
}

beforeEach(() => { vi.clearAllMocks(); });

test("the owner sees only their links and expired links expose no sharing controls", async () => {
  const data = {
    publicInvites: [...state("another").publicInvites!, ...state("owner", "expired").publicInvites!],
  } as OneLocationState;
  render(<LocationChatPublicLinks token="token" ownerId="owner" loadState={async () => data}
    onChanged={vi.fn()} onBack={vi.fn()} onCreate={vi.fn()} />);
  await screen.findByText("Expired");
  expect(screen.queryByText("Anyone with the link can see this location")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Stop link" })).not.toBeInTheDocument();
  expect(service.revokePublicInvite).not.toHaveBeenCalled();
});

test("a pending stop cannot cross an owner change after its authoritative read", async () => {
  let finishRead!: (value: OneLocationState) => void;
  service.getState.mockImplementation(() => new Promise<OneLocationState>((resolve) => { finishRead = resolve; }));
  const onChanged = vi.fn();
  const { rerender } = render(<LocationChatPublicLinks token="old-token" ownerId="owner"
    loadState={async () => state("owner")} onChanged={onChanged} onBack={vi.fn()} onCreate={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop link" }));
  await waitFor(() => expect(service.getState).toHaveBeenCalledWith("old-token"));
  rerender(<LocationChatPublicLinks token="new-token" ownerId="new-owner"
    loadState={async () => ({ publicInvites: [] }) as unknown as OneLocationState}
    onChanged={onChanged} onBack={vi.fn()} onCreate={vi.fn()} />);
  await screen.findByText("You haven’t created a public location link.");
  await act(async () => { finishRead(state("owner")); });
  expect(service.revokePublicInvite).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
});

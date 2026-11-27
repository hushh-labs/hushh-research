import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { OneLocationState } from "@/lib/one-location/types";
import { LocationChatPublicLinks } from "../location-chat-public-links";
import { LocationChatPublicShare } from "../location-chat-public-share";
import type { LocationConversationReply } from "@/lib/agent/main-chat-location-conversation";

const service = vi.hoisted(() => ({ getState: vi.fn(), revokePublicInvite: vi.fn(), createPublicInvite: vi.fn() }));
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

test("stops the reviewed public link only after a matching typed confirmation and verified receipt", async () => {
  const router: { reply?: LocationConversationReply | null } = {};
  const text = vi.fn();
  const current = state("owner");
  const onChanged = vi.fn();
  service.getState.mockResolvedValue(current);
  service.revokePublicInvite.mockResolvedValue({ ...current.publicInvites![0], status: "revoked" });
  render(<LocationChatPublicLinks token="token" ownerId="owner" loadState={async () => current}
    onChanged={onChanged} onBack={vi.fn()} onCreate={vi.fn()}
    onConversationReply={handler => { router.reply = handler; }} onConversationText={text} />);
  await waitFor(() => expect(text).toHaveBeenLastCalledWith(expect.stringContaining("Stop access for everyone")));
  const question = text.mock.lastCall?.[0];
  expect(screen.queryByRole("button")).toBeNull();
  expect(router.reply?.("yes", "a previous question")).toBe(false);
  expect(router.reply?.("share it", question)).toBe(false);
  expect(service.revokePublicInvite).not.toHaveBeenCalled();
  await act(async () => { router.reply?.("yes", question); });
  expect(service.revokePublicInvite).toHaveBeenCalledExactlyOnceWith({ vaultOwnerToken: "token", inviteId: "owner-link" });
  expect(onChanged).toHaveBeenCalledOnce();
  expect(text).toHaveBeenLastCalledWith("Public link stopped");
  expect(JSON.stringify(text.mock.calls)).not.toContain("/one/location/view/");
});

test("a changed or ambiguous public link review cannot stop a replacement link", async () => {
  const router: { reply?: LocationConversationReply | null } = {};
  const text = vi.fn();
  const current = state("owner");
  const original = current.publicInvites![0]!;
  service.getState.mockResolvedValue({ ...current, publicInvites: [original, { ...original, id: "replacement" }] });
  render(<LocationChatPublicLinks token="token" ownerId="owner" loadState={async () => current}
    onChanged={vi.fn()} onBack={vi.fn()} onCreate={vi.fn()}
    onConversationReply={handler => { router.reply = handler; }} onConversationText={text} />);
  await waitFor(() => expect(text).toHaveBeenLastCalledWith(expect.stringContaining("Stop access for everyone")));
  await act(async () => { router.reply?.("yes", text.mock.lastCall?.[0]); });
  expect(service.revokePublicInvite).not.toHaveBeenCalled();
  expect(text).toHaveBeenLastCalledWith(expect.stringContaining("link changed"));
});

test("only the typed confirmation creates a public link and its bearer token stays out of the transcript", async () => {
  const router: { reply?: LocationConversationReply | null } = {};
  const text = vi.fn();
  const loadState = vi.fn().mockResolvedValue({ publicInvites: [] });
  const point = { latitude: 1, longitude: 1, capturedAt: new Date().toISOString(), sourcePlatform: "web" as const };
  const capture = vi.fn().mockResolvedValue(point);
  const invite = state("owner").publicInvites![0]!;
  service.createPublicInvite.mockResolvedValue({ invite, publicUrl: "/one/location/view/bearer-secret" });
  render(<LocationChatPublicShare token="token" ownerId="owner" loadState={loadState} capture={capture}
    renderPoint={() => null} messageForError={String} onChanged={vi.fn()} onBack={vi.fn()}
    onConversationReply={handler => { router.reply = handler; }} onConversationText={text} />);
  await waitFor(() => expect(text).toHaveBeenLastCalledWith(expect.stringContaining("How long")));
  const durationQuestion = text.mock.lastCall?.[0];
  act(() => { router.reply?.("30 minutes", durationQuestion); });
  await waitFor(() => expect(text).toHaveBeenLastCalledWith(expect.stringContaining("Anyone who has it")));
  expect(capture).not.toHaveBeenCalled();
  expect(router.reply?.("yes", durationQuestion)).toBe(false);
  expect(service.createPublicInvite).not.toHaveBeenCalled();
  await act(async () => { router.reply?.("yes", text.mock.lastCall?.[0]); });
  expect(service.createPublicInvite).toHaveBeenCalledExactlyOnceWith({ vaultOwnerToken: "token", durationHours: 0.5, locationSnapshot: point });
  expect(await screen.findByRole("link", { name: "Open your location link" })).toHaveAttribute("href", expect.stringContaining("/one/location/view/bearer-secret"));
  expect(JSON.stringify(text.mock.calls)).not.toContain("bearer-secret");
});

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

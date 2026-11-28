import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrivateMailSessionProvider, usePrivateMailSession } from "../private-mail-session";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

const mocks = vi.hoisted(() => ({ vault: vi.fn(), list: vi.fn(), brief: vi.fn(), tasks: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({userId: "owner", isAuthenticated: true}) }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mocks.vault }));
vi.mock("@/lib/services/private-agent-specialist-chat", () => ({ ownerContentIsPrivate: async () => true }));
vi.mock("@/lib/services/private-google-connections", () => ({
  PRIVATE_MAIL_GRANTS_CHANGED: "test:grants", privateMailAccounts: mocks.list,
}));
vi.mock("@/lib/services/mail-followups-service", () => ({MailFollowupsService: {brief: mocks.brief}}));
vi.mock("@/lib/services/todo-list-pkm-service", () => ({TODO_LIST_PKM_DOMAIN: "one_todos", TodoListPkmService: {load: mocks.tasks}}));
afterEach(cleanup);
function Probe() {
  const workspace = usePrivateMailSession()!;
  return <><p>{workspace.selected?.email ?? "No mailbox"}</p><p>{workspace.brief?.account}</p>
    {workspace.accounts.map(box => <button key={box.accountId} onClick={() => workspace.choose(box.accountId)}>{box.accountId}</button>)}</>;
}
it("warms from unlock outside Mail, restores the last slot, and hides late or revoked mail", async () => {
  const unlocked = {isVaultUnlocked: true, ownerTokenStatus: "valid", vaultKey: "fixture", vaultOwnerToken: "fixture"};
  mocks.vault.mockReturnValue(unlocked);
  const boxes = ["A","B","C"].map(accountId => ({accountId, credentialId: "grant-"+accountId, email: accountId+"@example.test", status: "connected", capabilities: {read: true}}));
  mocks.list.mockResolvedValue(boxes);
  mocks.tasks.mockResolvedValue({tasks: []});
  let finish!: (value: {account: string; attention: unknown[]}) => void;
  mocks.brief.mockImplementation(async (box: {account: string}) => box.account === "B"
    ? new Promise(resolve => { finish = resolve; }) : {account: "summary-"+box.account, attention: []});
  const tree = <PrivateMailSessionProvider><Probe /></PrivateMailSessionProvider>;
  const first = render(tree);
  await screen.findByText("summary-A");
  fireEvent.click(screen.getByRole("button", {name:"B"}));
  await screen.findByText("B@example.test");
  expect(screen.queryByText("summary-A")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"C"}));
  await screen.findByText("summary-C");
  await act(async () => finish({account:"summary-B", attention: []}));
  expect(screen.queryByText("summary-B")).toBeNull();
  first.unmount();
  const restarted = render(tree);
  await screen.findByText("C@example.test");
  mocks.vault.mockReturnValue({...unlocked, isVaultUnlocked: false});
  act(() => { advanceVaultSessionEpoch(); });
  await screen.findByText("No mailbox");
  expect(screen.queryByText("summary-C")).toBeNull();
  mocks.vault.mockReturnValue(unlocked);
  restarted.rerender(<PrivateMailSessionProvider><Probe /></PrivateMailSessionProvider>);
  await screen.findByText("summary-C");
  mocks.list.mockResolvedValue(boxes.slice(0,2));
  act(() => { window.dispatchEvent(new Event("test:grants")); });
  await waitFor(() => expect(screen.queryByRole("button",{name:"C"})).toBeNull());
  expect(screen.getByText("No mailbox")).toBeDefined();
  expect(screen.queryByText("summary-C")).toBeNull();
});

it("lists a mailbox whose permission lapsed as expired and never selects it", async () => {
  mocks.vault.mockReturnValue({isVaultUnlocked: true, ownerTokenStatus: "valid", vaultKey: "fixture", vaultOwnerToken: "fixture"});
  mocks.list.mockResolvedValue([
    {accountId: "L", credentialId: "grant-L", email: "lapsed@example.test", status: "needs_reauth", capabilities: {read: false}, isDefault: true},
    {accountId: "B", credentialId: "grant-B", email: "B@example.test", status: "connected", capabilities: {read: true}},
  ]);
  mocks.tasks.mockResolvedValue({tasks: []});
  mocks.brief.mockResolvedValue({account: "summary", attention: []});
  function Expired() {
    const session = usePrivateMailSession()!;
    return <><p>{"selected:" + (session.selected?.accountId ?? "none")}</p><p>{"expired:" + session.expired.map(row => row.email).join(",")}</p></>;
  }
  localStorage.clear();
  render(<PrivateMailSessionProvider><Expired /></PrivateMailSessionProvider>);
  await screen.findByText("expired:lapsed@example.test");
  expect(screen.getByText("selected:B")).toBeDefined();
});

it("tries a failed mailbox check again by itself, with growing pauses, and stops after three", async () => {
  vi.useFakeTimers();
  try {
    mocks.vault.mockReturnValue({isVaultUnlocked: true, ownerTokenStatus: "valid", vaultKey: "fixture", vaultOwnerToken: "fixture"});
    mocks.list.mockRejectedValue(new Error("the private agent is waking"));
    function Failed() { return <p>{"failed:" + String(usePrivateMailSession()!.inventoryFailed)}</p>; }
    render(<PrivateMailSessionProvider><Failed /></PrivateMailSessionProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    for (const [pause, calls] of [[2_000, 2], [6_000, 3], [15_000, 4]] as const) {
      await act(async () => { await vi.advanceTimersByTimeAsync(pause); });
      expect(mocks.list).toHaveBeenCalledTimes(calls);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.list).toHaveBeenCalledTimes(4);
    expect(screen.getByText("failed:true")).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});


it("shows A's last brief while a new read for A and a superseded read for B are pending", async () => {
  localStorage.clear();
  mocks.vault.mockReturnValue({isVaultUnlocked: true, ownerTokenStatus: "valid", vaultKey: "fixture", vaultOwnerToken: "fixture"});
  mocks.list.mockResolvedValue(["A", "B"].map(accountId => ({
    accountId, credentialId: "grant-" + accountId, email: accountId + "@example.test", status: "connected", capabilities: {read: true},
  })));
  mocks.tasks.mockResolvedValue({tasks: []});
  let resolveB!: (brief: object) => void;
  mocks.brief.mockResolvedValueOnce({account: "A saved", attention: []})
    .mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; }))
    .mockImplementationOnce(() => new Promise(() => {}));
  render(<PrivateMailSessionProvider><Probe /></PrivateMailSessionProvider>);
  await screen.findByText("A saved");
  fireEvent.click(screen.getByRole("button", {name: "B"}));
  await screen.findByText("B@example.test");
  expect(screen.queryByText("A saved")).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "A"}));
  expect(screen.getByText("A saved")).toBeDefined();
  await act(async () => resolveB({account: "B stale", attention: []}));
  expect(screen.queryByText("B stale")).toBeNull();
  expect(screen.getByText("A saved")).toBeDefined();
});

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  user: null as null | { uid: string },
  unlocked: false,
  verificationRequired: false,
  push: vi.fn(),
  preview: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mock.user,
    loading: false,
    sessionVerificationRequired: mock.verificationRequired,
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ isVaultUnlocked: mock.unlocked }),
}));
vi.mock("@/components/app-ui/app-page-shell", () => ({
  AppPageShell: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));
vi.mock("@/components/app-ui/page-sections", () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/components/app-ui/native-test-beacon", () => ({
  NativeTestBeacon: () => null,
}));
vi.mock("@/lib/services/world-model-invitations-service", () => ({
  WorldModelInvitationsService: { preview: mock.preview },
}));
vi.mock("@/lib/services/post-auth-route-service", () => ({
  PostAuthRouteService: { resolveAfterLogin: mock.resolve },
}));
import Page from "@/app/world-model/invite/page";
import { buildOneSetupRoute } from "@/lib/navigation/routes";
import { readWorldModelInvitationHandoff } from "@/lib/world-model/invitation-handoff";
import { worldModelInvitationHandoffRoute } from "@/lib/world-model/invitation-handoff";
const token = "a".repeat(43),
  path = `/world-model/invite#claim=${token}`;
const result = {
  introduction: "Hello Alice",
  report: {
    sections: [
      {
        kind: "career",
        facts: [{ statement: "Published project", sources: [] }],
      },
    ],
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  mock.user = null;
  mock.unlocked = false;
  mock.verificationRequired = false;
  window.history.replaceState({}, "", path);
  mock.preview.mockResolvedValue(result);
  mock.resolve.mockImplementation(async ({ redirectPath }) => redirectPath);
});
function lastPush(): string {
  return mock.push.mock.lastCall![0] as string;
}
function handoffFrom(route: string): string {
  const url = new URL(route, "https://one.local");
  expect(url.search).not.toContain(token);
  expect(decodeURIComponent(route)).not.toContain(token);
  const id = url.searchParams.get("handoff");
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  return id!;
}
it("shows a public preview and preserves its capability through sign-in", async () => {
  render(<Page />);
  await screen.findByText("Published project");
  fireEvent.click(screen.getByRole("button", { name: "Continue to review" }));
  const login = new URL(lastPush(), "https://one.local");
  expect(login.pathname).toBe("/login");
  const destination = login.searchParams.get("redirect")!;
  const id = handoffFrom(destination);
  expect(readWorldModelInvitationHandoff(id, null)).toBe(token);
  expect(decodeURIComponent(lastPush())).not.toContain(token);
  expect(mock.resolve).not.toHaveBeenCalled();
});
it.each([false, true])(
  "continues a signed-in recipient with vault unlocked=%s without auto-claim",
  async (unlocked) => {
    mock.user = { uid: "recipient" };
    mock.unlocked = unlocked;
    render(<Page />);
    await screen.findByText("Published project");
    fireEvent.click(screen.getByRole("button", { name: "Continue to review" }));
    await waitFor(() => expect(mock.push).toHaveBeenCalledTimes(1));
    const route = new URL(lastPush(), "https://one.local");
    if (unlocked) {
      expect(route.pathname).toBe("/one/profile/world-model");
      const id = handoffFrom(lastPush());
      expect(readWorldModelInvitationHandoff(id, "recipient")).toBe(token);
    } else {
      expect(route.pathname).toBe("/one/profile/security");
      const destination = route.searchParams.get("return_to")!;
      const id = handoffFrom(destination);
      expect(readWorldModelInvitationHandoff(id, "recipient")).toBe(token);
    }
  },
);
it("lets a previewless recipient verify the invited contact without inventing a profile", async () => {
  mock.preview.mockResolvedValue({ has_preview: false });
  render(<Page />);
  expect(
    await screen.findByText(/does not include a prepared preview/i),
  ).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Your invitation" })).toBeInTheDocument();
  expect(screen.queryByText("Published project")).not.toBeInTheDocument();
  expect(screen.queryByText(/Prepared by the inviter/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Continue to verify" }));
  expect(handoffFrom(new URL(lastPush(), "https://one.local").searchParams.get("redirect")!)).toBeTruthy();
  expect(mock.resolve).not.toHaveBeenCalled();
});
it("continues a signed-in previewless recipient to explicit claiming", async () => {
  mock.preview.mockResolvedValue({ has_preview: false });
  mock.user = { uid: "recipient" };
  mock.unlocked = true;
  render(<Page />);
  await screen.findByRole("button", { name: "Continue to verify" });
  fireEvent.click(screen.getByRole("button", { name: "Continue to verify" }));
  await waitFor(() => expect(mock.push).toHaveBeenCalledTimes(1));
  expect(new URL(lastPush(), "https://one.local").pathname).toBe("/one/profile/world-model");
  expect(handoffFrom(lastPush())).toBeTruthy();
});
it("recovers the same invitation after login, setup, and vault handoffs", async () => {
  mock.preview.mockResolvedValue({ has_preview: false });
  const first = render(<Page />);
  await screen.findByRole("button", { name: "Continue to verify" });
  fireEvent.click(screen.getByRole("button", { name: "Continue to verify" }));
  const destination = new URL(lastPush(), "https://one.local").searchParams.get("redirect")!;
  handoffFrom(destination);
  first.unmount();

  mock.user = { uid: "recipient" };
  window.history.replaceState({}, "", destination);
  mock.push.mockClear();
  mock.resolve.mockImplementationOnce(async ({ redirectPath }) =>
    buildOneSetupRoute({ returnTo: redirectPath }),
  );
  const afterLogin = render(<Page />);
  await screen.findByRole("button", { name: "Continue to verify" });
  fireEvent.click(screen.getByRole("button", { name: "Continue to verify" }));
  await waitFor(() => expect(mock.push).toHaveBeenCalledTimes(1));
  const setup = new URL(lastPush(), "https://one.local");
  expect(setup.pathname).toBe("/one/setup");
  const setupReturn = setup.searchParams.get("return_to")!;
  handoffFrom(setupReturn);
  expect(decodeURIComponent(lastPush())).not.toContain(token);
  afterLogin.unmount();

  window.history.replaceState({}, "", setupReturn);
  mock.push.mockClear();
  const afterSetup = render(<Page />);
  await screen.findByRole("button", { name: "Continue to verify" });
  fireEvent.click(screen.getByRole("button", { name: "Continue to verify" }));
  await waitFor(() => expect(mock.push).toHaveBeenCalledTimes(1));
  const vault = new URL(lastPush(), "https://one.local");
  expect(vault.pathname).toBe("/one/profile/security");
  const vaultReturn = vault.searchParams.get("return_to")!;
  handoffFrom(vaultReturn);
  expect(decodeURIComponent(lastPush())).not.toContain(token);
  afterSetup.unmount();

  mock.unlocked = true;
  mock.push.mockClear();
  window.history.replaceState({}, "", vaultReturn);
  render(<Page />);
  await screen.findByRole("button", { name: "Continue to verify" });
  fireEvent.click(screen.getByRole("button", { name: "Continue to verify" }));
  await waitFor(() => expect(mock.push).toHaveBeenCalledTimes(1));
  expect(new URL(lastPush(), "https://one.local").pathname).toBe("/one/profile/world-model");
  expect(readWorldModelInvitationHandoff(handoffFrom(lastPush()), "recipient")).toBe(token);
});
it("resumes a verification-required session for the same account", async () => {
  mock.preview.mockResolvedValue({ has_preview: false });
  mock.user = { uid: "recipient" };
  mock.verificationRequired = true;
  const beforeVerification = render(<Page />);
  await screen.findByRole("button", { name: "Continue to verify" });
  fireEvent.click(screen.getByRole("button", { name: "Continue to verify" }));
  const destination = new URL(lastPush(), "https://one.local").searchParams.get("redirect")!;
  const id = handoffFrom(destination);
  expect(readWorldModelInvitationHandoff(id, null)).toBe(token);
  beforeVerification.unmount();

  mock.verificationRequired = false;
  mock.unlocked = true;
  mock.push.mockClear();
  window.history.replaceState({}, "", destination);
  render(<Page />);
  await screen.findByRole("button", { name: "Continue to verify" });
  fireEvent.click(screen.getByRole("button", { name: "Continue to verify" }));
  await waitFor(() => expect(mock.push).toHaveBeenCalledTimes(1));
  const claim = lastPush();
  expect(new URL(claim, "https://one.local").pathname).toBe("/one/profile/world-model");
  expect(readWorldModelInvitationHandoff(handoffFrom(claim), "recipient")).toBe(token);
});
it("lets the intended recipient explicitly recover a handoff opened under another account", async () => {
  mock.preview.mockResolvedValue({ has_preview: false });
  mock.user = { uid: "wrong-account" };
  mock.unlocked = true;
  const wrongAccount = render(<Page />);
  await screen.findByRole("button", { name: "Continue to verify" });
  fireEvent.click(screen.getByRole("button", { name: "Continue to verify" }));
  await waitFor(() => expect(mock.push).toHaveBeenCalledTimes(1));
  const originalId = handoffFrom(lastPush());
  wrongAccount.unmount();

  mock.user = { uid: "intended-recipient" };
  mock.push.mockClear();
  window.history.replaceState({}, "", worldModelInvitationHandoffRoute(originalId));
  render(<Page />);
  expect(await screen.findByText(/opened with another account/i)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Continue to verify" })).not.toBeInTheDocument();
  expect(mock.preview).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Continue with this account" }));
  expect(readWorldModelInvitationHandoff(originalId, "intended-recipient")).toBe(token);
  await screen.findByRole("button", { name: "Continue to verify" });
  fireEvent.click(screen.getByRole("button", { name: "Continue to verify" }));
  await waitFor(() => expect(mock.push).toHaveBeenCalledTimes(1));
  const claim = lastPush();
  expect(new URL(claim, "https://one.local").pathname).toBe("/one/profile/world-model");
  expect(decodeURIComponent(claim)).not.toContain(token);
  expect(readWorldModelInvitationHandoff(handoffFrom(claim), "intended-recipient")).toBe(token);
  expect(readWorldModelInvitationHandoff(originalId, "wrong-account")).toBeNull();
});
it("does not offer continuation for an expired invitation", async () => {
  mock.preview.mockRejectedValue(new Error("expired"));
  render(<Page />);
  await screen.findByText(/unavailable or has expired/);
  expect(
    screen.queryByRole("button", { name: "Continue to review" }),
  ).not.toBeInTheDocument();
});
it("does not continue when a return-path handoff is missing", async () => {
  window.history.replaceState(
    {},
    "",
    `/world-model/invite?handoff=${"0".repeat(32)}`,
  );
  render(<Page />);
  await screen.findByText(/invitation is unavailable/i);
  expect(mock.preview).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Continue to/ })).not.toBeInTheDocument();
});
it("ignores a late response after changing invitation tokens", async () => {
  let finish!: (value: unknown) => void;
  mock.preview
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce({ ...result, introduction: "Hello Bob" });
  render(<Page />);
  await waitFor(() => expect(mock.preview).toHaveBeenCalledWith(token));
  await act(async () => {
    window.history.replaceState(
      {},
      "",
      `/world-model/invite#claim=${"b".repeat(43)}`,
    );
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await screen.findByText("Hello Bob");
  await act(async () => finish(result));
  expect(screen.queryByText("Hello Alice")).not.toBeInTheDocument();
});

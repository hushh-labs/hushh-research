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
  push: vi.fn(),
  preview: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({
    user: mock.user,
    loading: false,
    sessionVerificationRequired: false,
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
import { buildProfileVaultRoute } from "@/lib/navigation/routes";
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
  mock.user = null;
  mock.unlocked = false;
  window.history.replaceState({}, "", path);
  mock.preview.mockResolvedValue(result);
  mock.resolve.mockResolvedValue(path);
});
it("shows a public preview and preserves its capability through sign-in", async () => {
  render(<Page />);
  await screen.findByText("Published project");
  fireEvent.click(screen.getByRole("button", { name: "Continue to review" }));
  expect(mock.push).toHaveBeenCalledWith(
    `/login?redirect=${encodeURIComponent(path)}`,
  );
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
    await waitFor(() =>
      expect(mock.push).toHaveBeenCalledWith(
        unlocked
          ? `/one/profile/world-model#claim=${token}`
          : buildProfileVaultRoute(path),
      ),
    );
  },
);
it("does not offer continuation for an expired invitation", async () => {
  mock.preview.mockRejectedValue(new Error("expired"));
  render(<Page />);
  await screen.findByText(/unavailable or has expired/);
  expect(
    screen.queryByRole("button", { name: "Continue to review" }),
  ).not.toBeInTheDocument();
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

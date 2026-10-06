import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OneLocationCircleInvitePreview } from "@/lib/one-location/types";
import { ApiError } from "@/lib/services/api-client";

const mockReplace = vi.fn();
const mockPreview = vi.fn();
const mockPublicPreview = vi.fn();
const mockPostAuth = vi.fn();
const mockPush = vi.fn();
let searchParams = new URLSearchParams();
let authState: {
  user: { uid: string; getIdToken: () => Promise<string> } | null;
  isAuthenticated: boolean;
  loading: boolean;
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mockReplace,
    push: mockPush,
    prefetch: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => authState,
}));

vi.mock("@/app/one/location/invite/[token]/page-client", () => ({
  default: ({ token, returnTo }: { token: string; returnTo: string }) =>
    <div data-testid="token-invitation" data-token={token} data-return-to={returnTo} />,
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    previewPublicCircleCode: (code: string) => mockPublicPreview(code),
    previewOnboardingCircleCode: (params: { idToken: string; code: string }) =>
      mockPreview(params),
  },
}));

vi.mock("@/lib/services/post-auth-route-service", () => ({
  PostAuthRouteService: { resolveAfterLogin: (params: unknown) => mockPostAuth(params) },
}));

import CircleJoinPage from "@/app/circle/join/page";

const CODE = "SWDXENDPB954";
const USER_ID = "user-1";

function preview(
  overrides: Partial<OneLocationCircleInvitePreview> = {},
): OneLocationCircleInvitePreview {
  return {
    name: "JHUMMA's Circle",
    kind: "family",
    ownerDisplayName: "JHUMMA KUMARI",
    memberCount: 1,
    expiresAt: "2026-09-01T00:00:00Z",
    alreadyMember: false,
    ...overrides,
  } as OneLocationCircleInvitePreview;
}

function signedIn() {
  authState = {
    user: { uid: USER_ID, getIdToken: () => Promise.resolve("id-token") },
    isAuthenticated: true,
    loading: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams({ code: CODE });
  authState = { user: null, isAuthenticated: false, loading: false };
  // Resolved (setup already finished) unless a test says otherwise -- the
  // parking behaviour under test is the exception, not the default.
  mockPublicPreview.mockResolvedValue({ name: "Family Circle", ownerDisplayName: "Alex" });
  mockPostAuth.mockImplementation(async ({ redirectPath }) => redirectPath);
  Element.prototype.scrollIntoView = vi.fn();
});

describe("/circle/join landing", () => {
  it("does not let an old Continue lookup overwrite a newly opened invite", async () => {
    signedIn();
    mockPreview.mockResolvedValue(preview());
    let finish!: (path: string) => void;
    mockPostAuth.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = render(<CircleJoinPage />);
    await screen.findByTestId("circle-join-preview");
    fireEvent.click(screen.getByTestId("circle-join-continue"));
    await waitFor(() => expect(mockPostAuth).toHaveBeenCalledOnce());
    searchParams = new URLSearchParams({ code: "SECOND-CODE" });
    view.rerender(<CircleJoinPage />);
    await act(async () => finish("/one/connect?tab=circles&action=join-circle&code=" + CODE));
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByTestId("circle-join-continue")).toBeEnabled();
  });
  it("hands a native token alias to the existing invitation owner", () => {
    searchParams = new URLSearchParams({ invite: "real_token-123" });
    render(<CircleJoinPage />);
    expect(screen.getByTestId("token-invitation")).toHaveAttribute("data-token", "real_token-123");
    expect(screen.getByTestId("token-invitation")).toHaveAttribute("data-return-to", "/circle/join?invite=real_token-123");
    expect(mockPublicPreview).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it.each(["invite=one&invite=two", "invite=one&code=two", "invite=", "invite=%2Fevil", "code=first&code=second", "code=first&code=first"])("rejects ambiguous or malformed invitation %s", (query) => {
    searchParams = new URLSearchParams(query);
    render(<CircleJoinPage />);
    expect(screen.getByText("Invitation unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("token-invitation")).not.toBeInTheDocument();
    expect(mockPublicPreview).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Explore One" })).toHaveAttribute("href", "/?invite=one");
  });
  it("lets a guest explore four screens before signing in with the same code", async () => {
    render(<CircleJoinPage />);
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "1");
    fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Meet your agents" }));
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "3");
    fireEvent.click(screen.getByRole("button", { name: "See what’s next" }));
    expect(await screen.findByRole("heading", { name: "Family Circle", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("Invited by Alex")).toBeInTheDocument();
    expect(mockPreview).not.toHaveBeenCalled();
    expect(mockPostAuth).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Join this Circle" }));
    expect(mockPush).toHaveBeenCalledWith("/login?redirect=" + encodeURIComponent("/circle/join?code=" + CODE));
  });

  it("keeps an unavailable invitation recoverable without claiming membership", async () => {
    mockPublicPreview.mockRejectedValueOnce(new ApiError("expired", 404));
    render(<CircleJoinPage />);
    fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Meet your agents" }));
    fireEvent.click(screen.getByRole("button", { name: "See what’s next" }));
    expect(await screen.findByText(/This invitation is unavailable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join this Circle" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Family Circle", level: 2 })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("does not block soft-launch sign-in when anonymous previews are rate limited", async () => {
    mockPublicPreview.mockRejectedValueOnce(new ApiError("Too many requests", 429));
    render(<CircleJoinPage />);
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Meet your agents" }));
    fireEvent.click(screen.getByRole("button", { name: "See what’s next" }));
    expect(await screen.findByText(/Preview is temporarily unavailable/)).toBeInTheDocument();
    const action = screen.getByRole("button", { name: "Join this Circle" });
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(mockPush).toHaveBeenCalledWith("/login?redirect=" + encodeURIComponent("/circle/join?code=" + CODE));
    expect(mockPostAuth).not.toHaveBeenCalled();
  });

  it("does not send a guest straight to login when the link is missing its code", async () => {
    searchParams = new URLSearchParams();
    render(<CircleJoinPage />);
    expect(screen.getByTestId("guest-preview")).toHaveAttribute("data-preview-step", "1");
    fireEvent.click(screen.getByRole("button", { name: "Create your One", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Meet your agents" }));
    fireEvent.click(screen.getByRole("button", { name: "See what’s next" }));
    expect(await screen.findByText(/missing its code/)).toBeInTheDocument();
    expect(mockPublicPreview).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("waits for restored auth instead of flashing a guest preview or losing the code", async () => {
    authState.loading = true;
    const view = render(<CircleJoinPage />);
    expect(screen.queryByTestId("guest-preview")).not.toBeInTheDocument();
    signedIn();
    mockPreview.mockResolvedValue(preview({ alreadyMember: true }));
    view.rerender(<CircleJoinPage />);
    expect(await screen.findByText("You're already in this Circle.")).toBeInTheDocument();
    expect(screen.queryByTestId("guest-preview")).not.toBeInTheDocument();
    expect(mockPostAuth).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("names the Circle and offers to join it once the preview resolves", async () => {
    signedIn();
    mockPreview.mockResolvedValue(preview());

    render(<CircleJoinPage />);

    expect(await screen.findByTestId("circle-join-preview")).toHaveTextContent(
      "JHUMMA's Circle",
    );
    expect(screen.getByTestId("circle-join-preview")).toHaveTextContent(
      "JHUMMA KUMARI · 1 person",
    );
    expect(screen.getByTestId("circle-join-continue")).toHaveTextContent(
      "Join this Circle",
    );
  });

  it("switches the action when the recipient is already a member", async () => {
    signedIn();
    mockPreview.mockResolvedValue(preview({ alreadyMember: true }));

    render(<CircleJoinPage />);

    expect(await screen.findByTestId("circle-join-preview")).toHaveTextContent(
      "You're already in this Circle.",
    );
    expect(screen.getByTestId("circle-join-continue")).toHaveTextContent(
      "Open One",
    );
  });

  it("pluralises member counts and survives a zero count", async () => {
    signedIn();
    mockPreview.mockResolvedValue(preview({ memberCount: 4 }));

    const { unmount } = render(<CircleJoinPage />);
    expect(await screen.findByTestId("circle-join-preview")).toHaveTextContent(
      "JHUMMA KUMARI · 4 people",
    );
    unmount();

    mockPreview.mockResolvedValue(preview({ memberCount: 0 }));
    render(<CircleJoinPage />);
    const zero = await screen.findByTestId("circle-join-preview");
    expect(zero).toHaveTextContent("JHUMMA KUMARI");
    expect(zero.textContent).not.toContain("0 people");
  });

  it("falls back to readable text when the backend sends empty fields", async () => {
    signedIn();
    mockPreview.mockResolvedValue(
      preview({ name: "   ", ownerDisplayName: "" }),
    );

    render(<CircleJoinPage />);

    const card = await screen.findByTestId("circle-join-preview");
    expect(card).toHaveTextContent("This Circle");
    expect(card).toHaveTextContent("A Circle owner");
  });

  it("replaces a raw transport error with one actionable sentence", async () => {
    signedIn();
    mockPreview.mockRejectedValue(new Error("Request failed: 422"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(<CircleJoinPage />);

    const error = await screen.findByTestId("circle-join-error");
    expect(error).toHaveTextContent("That code didn't work. Ask for a new link.");
    expect(screen.queryByText(/Request failed/)).toBeNull();
    expect(screen.queryByText(/422/)).toBeNull();
    // The detail is kept where it is useful.
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();

    // A failed lookup is never the end of the road -- the hub takes a retype.
    expect(screen.getByTestId("circle-join-continue")).toHaveTextContent(
      "Open One",
    );
  });

  it("keeps the code readable and the invitation intact for a long Circle name", async () => {
    signedIn();
    const longName = "The Extremely Long Family And Close Friends Circle Name";
    mockPreview.mockResolvedValue(
      preview({ name: longName, ownerDisplayName: "Ankit Kumar Singh" }),
    );

    render(<CircleJoinPage />);

    const card = await screen.findByTestId("circle-join-preview");
    // Product-owned and user-generated text wraps; it is never ellipsized, and
    // it never leaks into the button, which stays a fixed, stable label.
    expect(card).toHaveTextContent(longName);
    expect(screen.getByTestId("circle-join-continue")).toHaveTextContent(
      "Join this Circle",
    );
    expect(screen.getByTestId("circle-join-code")).toBeInTheDocument();
  });

  it("announces the lookup result through a pre-mounted live region", async () => {
    signedIn();
    mockPreview.mockResolvedValue(preview());

    render(<CircleJoinPage />);

    // Present from the first paint, so the result is actually announced.
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    await waitFor(() =>
      expect(status).toHaveTextContent("JHUMMA's Circle. JHUMMA KUMARI · 1 person."),
    );
  });

  it("carries the exact Connect join destination through setup admission", async () => {
    signedIn();
    mockPreview.mockResolvedValue(preview());
    mockPostAuth.mockResolvedValue("/one/setup?return_to=encoded-circle");
    render(<CircleJoinPage />);
    fireEvent.click(await screen.findByTestId("circle-join-continue"));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/one/setup?return_to=encoded-circle"));
    expect(mockPostAuth).toHaveBeenCalledWith({ userId: USER_ID, idToken: "id-token", redirectPath: "/one/connect?tab=circles&action=join-circle&code=" + CODE });
  });

  it("opens Connect for an account whose prerequisites are already satisfied", async () => {
    signedIn();
    mockPreview.mockResolvedValue(preview());
    render(<CircleJoinPage />);
    fireEvent.click(await screen.findByTestId("circle-join-continue"));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/one/connect?tab=circles&action=join-circle&code=" + CODE));
  });
});

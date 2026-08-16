import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { OneLocationCircleInvitePreview } from "@/lib/one-location/types";

const mockReplace = vi.fn();
const mockPreview = vi.fn();
let searchParams = new URLSearchParams();
let authState: {
  user: { getIdToken: () => Promise<string> } | null;
  isAuthenticated: boolean;
  loading: boolean;
};

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: mockReplace,
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => authState,
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    previewOnboardingCircleCode: (params: { idToken: string; code: string }) =>
      mockPreview(params),
  },
}));

import CircleJoinPage from "@/app/circle/join/page";

const CODE = "SWDXENDPB954";

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
    user: { getIdToken: () => Promise.resolve("id-token") },
    isAuthenticated: true,
    loading: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams({ code: CODE });
  authState = { user: null, isAuthenticated: false, loading: false };
});

describe("/circle/join landing", () => {
  it("shows the invitation and the code to a signed-out recipient", async () => {
    render(<CircleJoinPage />);

    expect(await screen.findByTestId("circle-join-code")).toHaveTextContent(
      /SWDX/,
    );
    expect(screen.getByTestId("circle-join-sign-in")).toBeInTheDocument();
    // The trust statement is what someone weighs before signing in.
    expect(
      screen.getByText(
        "Your location stays private until you choose to share it.",
      ),
    ).toBeInTheDocument();
    // Nothing about the Circle is claimed before it has been looked up.
    expect(screen.queryByTestId("circle-join-preview")).toBeNull();
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it("renders nothing and redirects when the link carries no code", async () => {
    searchParams = new URLSearchParams();

    const { container } = render(<CircleJoinPage />);

    // Effects run after paint: a codeless "You're invited" must never commit.
    expect(container.textContent).toBe("");
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        "/one/location?action=join-circle",
      ),
    );
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
      "Open One Location",
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
      "Open One Location",
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
});

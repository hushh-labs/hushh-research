import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  assignWindowLocation: vi.fn(),
  getIdToken: vi.fn(),
  searchParams: undefined as URLSearchParams | undefined,
  authState: {
    user: null as { uid: string; getIdToken: () => Promise<string> } | null,
    loading: false,
  },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => mocks.authState,
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.apiFetch },
}));

vi.mock("@/lib/utils/browser-navigation", () => ({
  assignWindowLocation: mocks.assignWindowLocation,
}));

import HushhTechLaunchPage from "@/app/products/hushh-tech/launch/page";
import {
  isFirebaseSessionOnlyRoute,
  isOnboardingAdmissionExemptRoute,
  isPublicRoute,
} from "@/lib/navigation/routes";

const CALLBACK = "https://uat.hushhtech.com/auth/hushh-research/callback";
const CHALLENGE = "a".repeat(43);

function validParams(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    audience: "hushh-tech-uat",
    redirect_uri: CALLBACK,
    state: "state-value",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...overrides,
  });
}

function signIn() {
  mocks.authState = {
    user: { uid: "research-user", getIdToken: mocks.getIdToken },
    loading: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchParams = validParams();
  mocks.authState = { user: null, loading: false };
  mocks.getIdToken.mockResolvedValue("firebase-id-token");
  mocks.apiFetch.mockResolvedValue(
    Response.json({
      code: "launch-code",
      expires_in: 60,
      audience: "hushh-tech-uat",
      redirect_uri: CALLBACK,
    }),
  );
});

describe("Hushh Tech Research launch page", () => {
  it("uses the current Firebase session once and redirects to the exact bound URI", async () => {
    signIn();
    mocks.searchParams = validParams({ state: "state with symbols & value" });

    render(
      <StrictMode>
        <HushhTechLaunchPage />
      </StrictMode>,
    );

    await waitFor(() =>
      expect(mocks.assignWindowLocation).toHaveBeenCalledTimes(1),
    );
    expect(mocks.getIdToken).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/api/products/hushh-tech/launch/authorize",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: { Authorization: "Bearer firebase-id-token" },
      }),
    );

    const requestInit = mocks.apiFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(requestInit.body))).toEqual({
      audience: "hushh-tech-uat",
      redirect_uri: CALLBACK,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });

    const redirect = new URL(mocks.assignWindowLocation.mock.calls[0]?.[0]);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(CALLBACK);
    expect(redirect.searchParams.get("code")).toBe("launch-code");
    expect(redirect.searchParams.get("state")).toBe(
      "state with symbols & value",
    );
    expect(redirect.searchParams.get("source")).toBe("hushh-research");
  });

  it("preserves the launch request while asking a signed-out person to sign in", () => {
    render(<HushhTechLaunchPage />);

    expect(mocks.apiFetch).not.toHaveBeenCalled();
    const link = screen.getByRole("link", { name: "Sign in" });
    const href = link.getAttribute("href") ?? "";
    expect(href).toBe(
      `/login?redirect=${encodeURIComponent(
        `/products/hushh-tech/launch?${mocks.searchParams?.toString()}`,
      )}`,
    );
  });

  it("fails closed before auth when PKCE S256 or another required value is missing", () => {
    mocks.searchParams = validParams({ code_challenge_method: "plain" });
    signIn();

    render(<HushhTechLaunchPage />);

    expect(
      screen.getByRole("heading", { name: "Link not valid" }),
    ).toBeVisible();
    expect(mocks.getIdToken).not.toHaveBeenCalled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("never follows a non-HTTPS upstream redirect or renders upstream details", async () => {
    signIn();
    mocks.apiFetch.mockResolvedValue(
      Response.json({
        code: "launch-code",
        expires_in: 60,
        audience: "hushh-tech-uat",
        redirect_uri: "http://attacker.test/callback?detail=raw-token",
      }),
    );

    render(<HushhTechLaunchPage />);

    expect(
      await screen.findByRole("heading", { name: "Couldn’t continue" }),
    ).toBeVisible();
    expect(screen.queryByText(/raw-token/)).toBeNull();
    expect(mocks.assignWindowLocation).not.toHaveBeenCalled();
  });

  it("rejects an HTTPS redirect that differs from the launch request", async () => {
    signIn();
    mocks.apiFetch.mockResolvedValue(
      Response.json({
        code: "launch-code",
        expires_in: 60,
        audience: "hushh-tech-uat",
        redirect_uri: "https://attacker.example/callback",
      }),
    );

    render(<HushhTechLaunchPage />);

    expect(
      await screen.findByRole("heading", { name: "Couldn’t continue" }),
    ).toBeVisible();
    expect(mocks.assignWindowLocation).not.toHaveBeenCalled();
  });

  it("allows an explicit retry without persisting the failed attempt", async () => {
    signIn();
    mocks.apiFetch
      .mockResolvedValueOnce(
        Response.json(
          { detail: { code: "UPSTREAM_UNAVAILABLE", message: "raw detail" } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          code: "second-code",
          expires_in: 60,
          audience: "hushh-tech-uat",
          redirect_uri: CALLBACK,
        }),
      );

    render(<HushhTechLaunchPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(mocks.assignWindowLocation).toHaveBeenCalledTimes(1),
    );
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(mocks.assignWindowLocation.mock.calls[0]?.[0]).toContain(
      "code=second-code",
    );
    expect(screen.queryByText(/raw detail/)).toBeNull();
  });

  it("bypasses setup admission without becoming a public route", () => {
    expect(
      isOnboardingAdmissionExemptRoute("/products/hushh-tech/launch"),
    ).toBe(true);
    expect(
      isFirebaseSessionOnlyRoute(
        "/products/hushh-tech/launch?audience=hushh-tech-uat",
      ),
    ).toBe(true);
    expect(isPublicRoute("/products/hushh-tech/launch")).toBe(false);
  });
});

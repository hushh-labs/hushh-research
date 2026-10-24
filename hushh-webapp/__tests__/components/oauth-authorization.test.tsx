import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import OAuthAuthorizePage from "@/app/oauth/authorize/page";

const { apiFetch, user } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  user: { uid: "synthetic-owner", getIdToken: vi.fn().mockResolvedValue("synthetic-token") },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user, loading: false }) }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("request=oar_0123456789abcdef0123456789abcdef"),
}));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch } }));
vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, onClick, disabled }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

describe("OAuth authorization review boundary", () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it("withholds approval until the current client and callback can be reviewed", async () => {
    let resolveReview!: (response: unknown) => void;
    apiFetch.mockReturnValueOnce(new Promise((resolve) => { resolveReview = resolve; }));
    render(<OAuthAuthorizePage />);
    const approve = screen.getByRole("button", { name: "Authorize", exact: true });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveReview({ ok: true, json: async () => ({
        client_id: "https://client.example.test/client.json",
        client_label: "Unverified OAuth app (client.example.test)",
        redirect_host: "callback.example.test",
      }) });
    });
    expect(screen.getByText("callback.example.test")).toBeVisible();
    expect(screen.getByText("https://client.example.test/client.json")).toBeVisible();
    expect(approve).toBeEnabled();
  });

  it("fails closed when request details cannot be loaded", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "invalid_request" }) });
    render(<OAuthAuthorizePage />);
    await waitFor(() => expect(screen.getByText(/could not be reviewed/)).toBeVisible());
    const approve = screen.getByRole("button", { name: "Authorize", exact: true });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

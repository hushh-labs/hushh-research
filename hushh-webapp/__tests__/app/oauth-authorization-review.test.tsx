import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  requestRef: "oar_0123456789abcdef0123456789abcdef",
  auth: { user: { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("synthetic-token") }, loading: false },
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(`request=${mocks.requestRef}`) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mocks.fetch } }));
vi.mock("@/lib/morphy-ux/button", () => ({ Button: ({ children, onClick, disabled }: React.ComponentProps<"button">) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
import OAuthAuthorizePage from "@/app/oauth/authorize/page";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

describe("OAuth requester review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.user = { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("synthetic-token") };
    mocks.requestRef = "oar_0123456789abcdef0123456789abcdef";
    publishValidatedAuthSessionOwner("owner-a");
  });

  it("requires server-provided client identity before approval", async () => {
    let resolve!: (response: Response) => void;
    mocks.fetch.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    render(<OAuthAuthorizePage />);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await act(async () => resolve(new Response(JSON.stringify({ client_name: "Registered assistant", memory_access_granted: false }))));
    expect(screen.getByRole("heading", { name: "Connect Registered assistant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).not.toBeDisabled();
  });

  it("does not enable approval when requester lookup fails", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 404 }));
    render(<OAuthAuthorizePage />);
    await screen.findByText(/Could not load this connection/);
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("does not reuse a previous owner's review after account switching", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ client_name: "First assistant", memory_access_granted: false })));
    const view = render(<OAuthAuthorizePage />);
    await screen.findByRole("heading", { name: "Connect First assistant" });
    mocks.fetch.mockReturnValue(new Promise(() => {}));
    mocks.auth.user = { uid: "owner-b", getIdToken: vi.fn().mockResolvedValue("synthetic-other-token") };
    publishValidatedAuthSessionOwner("owner-b");
    view.rerender(<OAuthAuthorizePage />);
    expect(screen.queryByRole("heading", { name: "Connect First assistant" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("refuses stale approval dispatch when account changes during token acquisition", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ client_name: "Assistant", memory_access_granted: false })));
    const view = render(<OAuthAuthorizePage />);
    await screen.findByRole("heading", { name: "Connect Assistant" });
    let resolve!: (token: string) => void;
    mocks.auth.user.getIdToken.mockReturnValueOnce(new Promise<string>((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    publishValidatedAuthSessionOwner("owner-b");
    mocks.auth.user = { uid: "owner-b", getIdToken: vi.fn().mockResolvedValue("synthetic-other-token") };
    mocks.fetch.mockReturnValue(new Promise(() => {}));
    view.rerender(<OAuthAuthorizePage />);
    await act(async () => resolve("synthetic-old-token"));
    expect(mocks.fetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(0);
  });

  it("ignores an approval result after the connection request changes", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ client_name: "Assistant", memory_access_granted: false })));
    const view = render(<OAuthAuthorizePage />);
    await screen.findByRole("heading", { name: "Connect Assistant" });
    let resolve!: (response: unknown) => void;
    mocks.fetch.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    mocks.requestRef = "oar_abcdef0123456789abcdef0123456789";
    mocks.fetch.mockReturnValue(new Promise(() => {}));
    view.rerender(<OAuthAuthorizePage />);
    const json = vi.fn().mockResolvedValue({ redirect_uri: "https://assistant.example.test" });
    await act(async () => resolve({ ok: true, json }));
    expect(json).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });
});

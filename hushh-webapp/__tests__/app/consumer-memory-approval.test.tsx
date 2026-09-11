import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  auth: { user: { uid: "owner-a", getIdToken: vi.fn() }, loading: false },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: mocks.fetch } }));
vi.mock("@/lib/morphy-ux/button", () => ({ Button: ({ children, onClick, disabled }: React.ComponentProps<"button">) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
import { ConsumerMemoryApproval } from "@/components/developers/consumer-memory-approval";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const connectionId = "cmc_0123456789abcdef0123456789abcdef";
const review = { connection_id: connectionId, authorization_id: 12, generation: 2,
  client_name: "Registered assistant", memory_access: false };

describe("consumer memory approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.user = { uid: "owner-a", getIdToken: vi.fn().mockResolvedValue("synthetic-token") };
    publishValidatedAuthSessionOwner("owner-a");
  });

  it("waits for server review and an explicit click; sends the reviewed generation", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json(review));
    render(<ConsumerMemoryApproval connectionId={connectionId} authorizationId="12" />);
    expect(screen.getByRole("button", { name: "Allow memory access" })).toBeDisabled();
    await screen.findByRole("heading", { name: "Memory for Registered assistant" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    mocks.fetch.mockResolvedValueOnce(Response.json({ memory_access: true, grant_receipt: "cmr_synthetic" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow memory access" }));
    await screen.findByRole("status");
    const [, request] = mocks.fetch.mock.calls[1];
    expect(JSON.parse(request.body)).toEqual({ generation: 2, authorization_id: 12,
      policy_version: 1, personal_memory_until_disconnected: true });
    expect(screen.getByRole("status").textContent).toContain("Continue setup");
  });

  it("does not claim success after a failed or uncertain approval", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json(review));
    render(<ConsumerMemoryApproval connectionId={connectionId} authorizationId="12" />);
    await screen.findByRole("heading", { name: "Memory for Registered assistant" });
    mocks.fetch.mockRejectedValueOnce(new Error("synthetic network interruption"));
    fireEvent.click(screen.getByRole("button", { name: "Allow memory access" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("cannot submit a previous owner's approval after account switching", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json(review));
    const view = render(<ConsumerMemoryApproval connectionId={connectionId} authorizationId="12" />);
    await screen.findByRole("heading", { name: "Memory for Registered assistant" });
    let release!: (token: string) => void;
    mocks.auth.user.getIdToken.mockReturnValueOnce(new Promise<string>((resolve) => { release = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Allow memory access" }));
    publishValidatedAuthSessionOwner("owner-b");
    mocks.auth.user = { uid: "owner-b", getIdToken: vi.fn().mockResolvedValue("other-synthetic-token") };
    mocks.fetch.mockReturnValue(new Promise(() => {}));
    view.rerender(<ConsumerMemoryApproval connectionId={connectionId} authorizationId="12" />);
    await act(async () => release("stale-synthetic-token"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow memory access" })).toBeDisabled());
    expect(mocks.fetch.mock.calls.filter(([, request]) => request.method === "POST")).toHaveLength(0);
  });
});

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  uid: "b",
  unlocked: true,
  epoch: 1,
  native: false,
  token: "owner-b",
  getToken: vi.fn(),
  overview: vi.fn(),
  reauthenticate: vi.fn(),
  create: vi.fn(),
  lookupClient: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onConsentMutated: state.invalidate } }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => state.native },
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { uid: state.uid } }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: state.unlocked,
    getVaultOwnerToken: state.getToken,
  }),
}));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: { overview: state.overview },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { reauthenticateGoogleIdentity: state.reauthenticate },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: vi.fn() },
}));
vi.mock("@/lib/services/drive-sharing-service", async (original) => ({
  ...(await original<typeof import("@/lib/services/drive-sharing-service")>()),
  DriveSharingService: { create: state.create, lookupClient: state.lookupClient },
}));
import { DocumentRequestButton } from "@/components/consent/document-request-button";
import { CONSENT_ACTION_COMPLETE_EVENT } from "@/lib/consent/consent-events";
const personRef = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const mount = () =>
  render(<DocumentRequestButton personRef={personRef} personName="A" />);
async function open() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Request documents" }),
  );
  fireEvent.change(screen.getByLabelText("What do you need?"), {
    target: { value: "Six months of statements" },
  });
}
const send = () =>
  fireEvent.click(screen.getByRole("button", { name: "Verify Google & send" }));
describe("recipient document request", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.uid = "b";
    state.unlocked = true;
    state.epoch = 1;
    state.native = false;
    state.token = "owner-b";
    state.getToken.mockImplementation(() => state.token);
    state.overview.mockResolvedValue({
      features: { drive_document_sharing: true },
      connectors: [],
    });
    state.reauthenticate.mockResolvedValue("fresh-proof");
    state.create.mockResolvedValue({
      requestId,
      status: "pending",
      revision: 0,
    });
    state.lookupClient.mockResolvedValue(null);
  });
  afterEach(cleanup);
  it("sends a staged chat card with its resolved dates and original retry key only after a tap", async () => {
    const clientRequestId = "33333333-3333-4333-8333-333333333333";
    render(<DocumentRequestButton personRef={personRef} personName="A" draft={{
      clientRequestId, purpose: "Six months of statements",
      periodStart: "2026-03-01", periodEnd: "2026-08-31",
    }} />);
    expect(await screen.findByText("Requested period: 2026-03-01 – 2026-08-31")).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Verify Google & send request" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledWith(
      "owner-b", "fresh-proof",
      { ownerPersonRef: personRef, clientRequestId,
        purpose: { purpose: "Six months of statements", periodStart: "2026-03-01", periodEnd: "2026-08-31" } },
      expect.any(Function),
    ));
  });
  it.each([false, true])("requires explicit submission and single-flight Google verification (native=%s)", async (native) => {
    state.native = native;
    mount();
    await open();
    expect(state.create).not.toHaveBeenCalled();
    const submit = screen.getByRole("button", { name: "Verify Google & send" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(state.reauthenticate).toHaveBeenCalledOnce();
    await screen.findByText(
      "Request sent. No files have been shared by this action.",
    );
    expect(state.reauthenticate).toHaveBeenCalledWith(
      "b",
      expect.any(Function),
    );
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.invalidate).toHaveBeenCalledWith("b");
    expect(state.create).toHaveBeenCalledWith(
      "owner-b",
      "fresh-proof",
      {
        ownerPersonRef: personRef,
        clientRequestId: expect.any(String),
        purpose: {
          purpose: "Six months of statements",
          periodStart: null,
          periodEnd: null,
        },
      },
      expect.any(Function),
    );
    expect(
      screen.getByRole("link", { name: "View request" }).getAttribute("href"),
    ).toContain("requestView=sent");
    expect(
      screen.getByRole("link", { name: "View request" }).getAttribute("href"),
    ).not.toContain("statements");
  });
  it.each([false, true])("preserves the unchanged retry key; changed terms use a new key (native=%s)", async (native) => {
    state.native = native;
    state.create.mockRejectedValue(new Error("private-provider-error"));
    mount();
    await open();
    send();
    await screen.findByRole("alert");
    const firstId = state.create.mock.calls[0][2].clientRequestId;
    send();
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(2));
    await screen.findByRole("alert");
    expect(state.create.mock.calls[1][2].clientRequestId).toBe(firstId);
    expect(screen.queryByText("private-provider-error")).toBeNull();
    fireEvent.change(screen.getByLabelText("What do you need?"), {
      target: { value: "A new request" },
    });
    send();
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(3));
    expect(state.create.mock.calls[2][2].clientRequestId).not.toBe(firstId);
  });
  it("cancellation retains draft without denying that an earlier attempt may have succeeded", async () => {
    state.create.mockRejectedValueOnce(new Error("timeout"));
    mount();
    await open();
    send();
    await screen.findByRole("alert");
    state.reauthenticate.mockRejectedValueOnce(new Error("identity_cancelled"));
    send();
    await screen.findByText(/Check Sent documents for any earlier request/);
    expect(screen.getByLabelText("What do you need?")).toHaveValue(
      "Six months of statements",
    );
    expect(state.create).toHaveBeenCalledOnce();
  });
  it.each(["identity_popup_blocked", "identity_mismatch", "identity_cancelled", "identity_timeout", "native_identity_unavailable"])(
    "never posts after %s",
    async (message) => {
      state.reauthenticate.mockRejectedValueOnce(new Error(message));
      mount();
      await open();
      send();
      await screen.findByRole("alert");
      expect(state.create).not.toHaveBeenCalled();
    },
  );
  it("prevents dismissal during POST and reconciles exactly once on acknowledgement", async () => {
    let finish!: (value: unknown) => void;
    state.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reconcile = vi.fn();
    window.addEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    try {
      mount();
      await open();
      send();
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(screen.queryByRole("link", { name: "Sent documents" })).toBeNull();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.getByRole("dialog")).toBeVisible();
      await act(async () =>
        finish({ requestId, status: "pending", revision: 0 }),
      );
      expect(reconcile).toHaveBeenCalledOnce();
      expect(state.invalidate).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(CONSENT_ACTION_COMPLETE_EVENT, reconcile);
    }
  });
  it.each([false, true])("clears private draft and suppresses late verification after locking (native=%s)", async (native) => {
    state.native = native;
    let finish!: (value: string) => void;
    state.reauthenticate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const rendered = mount();
    await open();
    send();
    state.unlocked = false;
    state.epoch++;
    rendered.rerender(
      <DocumentRequestButton personRef={personRef} personName="A" />,
    );
    await act(async () => finish("late-proof"));
    expect(state.create).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    state.unlocked = true;
    rendered.rerender(
      <DocumentRequestButton personRef={personRef} personName="A" />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Request documents" }),
    );
    expect(screen.getByLabelText("What do you need?")).toHaveValue("");
  });
  it("allows a second intentional request after successful creation", async () => {
    mount();
    await open();
    send();
    fireEvent.click(await screen.findByRole("button", { name: "New request" }));
    expect(screen.getByLabelText("What do you need?")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("What do you need?"), {
      target: { value: "Statements again" },
    });
    send();
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(2));
    expect(state.create.mock.calls[1][2].clientRequestId).not.toBe(
      state.create.mock.calls[0][2].clientRequestId,
    );
  });
  it("validates paired dates on native before starting verification", async () => {
    state.native = true;
    mount();
    await open();
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-01-01" },
    });
    expect(
      screen.getByRole("button", { name: "Verify Google & send" }),
    ).toBeDisabled();
    expect(state.reauthenticate).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });
  it("suppresses proof after the native request component unmounts", async () => {
    state.native = true;
    let finish!: (token: string) => void;
    state.reauthenticate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const rendered = mount();
    await open();
    send();
    rendered.unmount();
    await act(async () => finish("late-native-proof"));
    expect(state.create).not.toHaveBeenCalled();
  });
  it("does not offer creation when feature admission is unavailable", async () => {
    state.overview.mockResolvedValueOnce({
      features: { drive_document_sharing: false },
    });
    mount();
    await waitFor(() => expect(state.overview).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "Request documents" }),
    ).toBeNull();
  });
});

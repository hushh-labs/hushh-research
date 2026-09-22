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
  uid: "owner-a",
  token: "vault-a",
  overview: vi.fn(),
  documents: vi.fn(),
  remove: vi.fn(),
  session: vi.fn(),
  pick: vi.fn(),
  native: false,
  nativeDrive: vi.fn(),
  nativeStart: vi.fn(),
  nativePending: vi.fn(),
  nativeFinalize: vi.fn(),
  nativeCallback: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => state.native },
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: state.uid, getIdToken: async () => "firebase" },
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: state.token }),
}));
vi.mock("@/lib/capacitor", () => ({
  HushhAuth: { connectDrive: state.nativeDrive },
}));
vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    status: { connected: true, google_email: "mail@example.invalid" },
  }),
}));
vi.mock("@/lib/services/gmail-receipts-service", () => ({
  GmailReceiptsService: {},
}));
vi.mock("@/lib/services/external-connector-service", () => ({
  ExternalConnectorService: {
    overview: state.overview,
    documents: state.documents,
    removeDocument: state.remove,
    pickerSession: state.session,
    startOAuthConnect: state.nativeStart,
    pendingNative: state.nativePending,
    finalizeNative: state.nativeFinalize,
    nativeDriveOAuthCallbackUri: state.nativeCallback,
  },
}));
vi.mock("@/lib/services/google-drive-picker-service", () => ({
  GoogleDrivePickerService: { choose: state.pick },
}));
import { ConnectorsPanel } from "@/components/agent/connectors-panel";
const overview = (label = "drive@example.invalid") => ({
  features: {
    connections_panel_v2: true,
    google_drive_connection: true,
    google_drive_picker: true,
  },
  connectors: [
    {
      connectorId: "google_drive",
      status: "connected",
      available: true,
      accountLabel: label,
    },
  ],
});
const doc = {
  documentId: "document-one",
  name: "Synthetic file",
  status: "queued",
};
const props = () => ({
  open: true,
  onBack: vi.fn(),
  onAvailableChange: vi.fn(),
  onExternalModalChange: vi.fn(),
});

describe("Connections owner and mutation fences", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.uid = "owner-a";
    state.token = "vault-a";
    state.native = false;
    state.overview.mockResolvedValue(overview());
    state.documents.mockResolvedValue([]);
    state.remove.mockResolvedValue(undefined);
    state.session.mockImplementation(async () => ({
      sessionId: "session",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      accessToken: "ephemeral",
    }));
    state.pick.mockResolvedValue([]);
    state.nativeDrive.mockReset();
    state.nativeStart.mockReset();
    state.nativePending.mockReset();
    state.nativeFinalize.mockReset();
    state.nativeCallback.mockReset();
    state.nativePending.mockResolvedValue(null);
    state.nativeFinalize.mockResolvedValue({
      connectorId: "google_drive",
      status: "connected",
    });
    state.nativeCallback.mockReturnValue(
      "https://api.example.invalid/api/connectors/oauth/native/callback",
    );
  });
  afterEach(cleanup);
  it("cannot resurrect a removed document from an earlier same-owner read", async () => {
    let stale!: (value: unknown) => void;
    state.documents
      .mockResolvedValueOnce([doc])
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            stale = done;
          }),
      )
      .mockResolvedValue([]);
    render(<ConnectorsPanel {...props()} />);
    await screen.findByText("Synthetic file");
    fireEvent.click(screen.getByRole("button", { name: "Retry Drive" }));
    await waitFor(() => expect(stale).toBeTypeOf("function"));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Synthetic file" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm", exact: true }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Synthetic file")).toBeNull(),
    );
    await act(async () => {
      stale([doc]);
    });
    expect(screen.queryByText("Synthetic file")).toBeNull();
    expect(state.remove).toHaveBeenCalledWith("vault-a", "document-one");
  });
  it("drops old owner results and does not display them for the next owner", async () => {
    let stale!: (value: unknown) => void;
    state.overview.mockImplementationOnce(
      () =>
        new Promise((done) => {
          stale = done;
        }),
    );
    const p = props();
    const view = render(<ConnectorsPanel {...p} />);
    state.uid = "owner-b";
    state.token = "vault-b";
    state.overview.mockResolvedValue(overview("new-owner@example.invalid"));
    view.rerender(<ConnectorsPanel {...p} />);
    await screen.findByText("new-owner@example.invalid");
    await act(async () => {
      stale(overview("old-owner@example.invalid"));
    });
    expect(screen.queryByText("old-owner@example.invalid")).toBeNull();
  });
  it("new connection gate does not disable selected-file management on existing grant", async () => {
    const result = overview();
    result.features.google_drive_connection = false;
    state.overview.mockResolvedValue(result);
    render(<ConnectorsPanel {...props()} />);
    expect(
      await screen.findByRole("button", { name: "Choose files" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Disconnect Drive" }),
    ).toBeEnabled();
  });
  it("an old Picker cannot release the new owner's modal protection", async () => {
    let oldPicker!: (value: unknown) => void;
    state.pick
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            oldPicker = done;
          }),
      )
      .mockImplementationOnce(() => new Promise(() => {}));
    const p = props();
    const view = render(<ConnectorsPanel {...p} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose files" }),
    );
    await waitFor(() => expect(oldPicker).toBeTypeOf("function"));
    state.uid = "owner-b";
    state.token = "vault-b";
    view.rerender(<ConnectorsPanel {...p} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose files" }),
    );
    await waitFor(() => expect(state.pick).toHaveBeenCalledTimes(2));
    const before = p.onExternalModalChange.mock.calls.length;
    await act(async () => {
      oldPicker([]);
    });
    expect(p.onExternalModalChange.mock.calls.length).toBe(before);
    expect(p.onExternalModalChange).toHaveBeenLastCalledWith(true);
  });
  it("keeps selection alive through same-owner Vault Owner token renewal", async () => {
    let finish!: (value: unknown) => void;
    state.pick.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const p = props();
    const view = render(<ConnectorsPanel {...p} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose files" }),
    );
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    const signal = state.pick.mock.calls[0][1] as AbortSignal;
    state.token = "vault-renewed";
    view.rerender(<ConnectorsPanel {...p} />);
    expect(signal.aborted).toBe(false);
    await act(async () => {
      finish([{ id: "file-one", name: "Selected name" }]);
    });
    await screen.findByRole("region", { name: "Confirm selected files" });
    expect(state.overview).toHaveBeenLastCalledWith("vault-renewed");
  });

  it("finalizes a ready native Drive return with a renewed Vault Owner token", async () => {
    state.native = true;
    state.overview.mockResolvedValue({
      ...overview(),
      connectors: [
        {
          connectorId: "google_drive",
          status: "not_connected",
          available: true,
          accountLabel: "Only files you choose",
        },
      ],
    });
    state.nativeStart.mockResolvedValue({
      attemptId: "attempt_123456789012",
      connectorId: "google_drive",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    let resolveBridge!: (value: unknown) => void;
    state.nativeDrive.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBridge = resolve;
        }),
    );
    const p = props();
    const view = render(<ConnectorsPanel {...p} />);
    const connect = await screen.findByRole("button", {
      name: "Connect Drive",
    });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await waitFor(() => expect(state.nativeDrive).toHaveBeenCalledTimes(1));

    state.token = "vault-renewed";
    state.nativePending.mockResolvedValue({
      attemptId: "attempt_123456789012",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    view.rerender(<ConnectorsPanel {...p} />);
    await act(async () => {
      resolveBridge({ attemptId: "attempt_123456789012", outcome: "ready" });
    });

    await waitFor(() =>
      expect(state.nativeFinalize).toHaveBeenCalledWith(
        expect.objectContaining({
          vaultOwnerToken: "vault-renewed",
          attemptId: "attempt_123456789012",
        }),
      ),
    );
  });

  it("reconciles a restart-safe native return and never exposes native Picker controls", async () => {
    state.native = true;
    state.nativePending.mockResolvedValue(null);
    const p = props();
    render(<ConnectorsPanel {...p} />);
    expect(await screen.findByText("drive@example.invalid")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Choose files" })).toBeNull();

    state.nativePending.mockResolvedValue({
      attemptId: "attempt_123456789012",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("hushh:native-connector-return", {
          detail: { attemptId: "attempt_123456789012", outcome: "ready" },
        }),
      );
    });
    await waitFor(() =>
      expect(state.nativeFinalize).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: "attempt_123456789012" }),
      ),
    );
  });

  it("keeps a cancelled native Drive attempt disconnected when no pending credential exists", async () => {
    state.native = true;
    state.overview.mockResolvedValue({
      ...overview(),
      connectors: [
        {
          connectorId: "google_drive",
          status: "not_connected",
          available: true,
          accountLabel: "Only files you choose",
        },
      ],
    });
    state.nativeStart.mockResolvedValue({
      attemptId: "attempt_123456789012",
      connectorId: "google_drive",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    state.nativeDrive.mockResolvedValue({
      attemptId: "attempt_123456789012",
      outcome: "cancelled",
    });
    render(<ConnectorsPanel {...props()} />);
    const connect = await screen.findByRole("button", {
      name: "Connect Drive",
    });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await screen.findByText(
      "Drive connection was cancelled. Your chat and draft stay here.",
    );
    await waitFor(() => expect(state.nativePending).toHaveBeenCalled());
    expect(state.nativeFinalize).not.toHaveBeenCalled();
  });
});

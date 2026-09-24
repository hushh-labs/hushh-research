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
  nativePicker: vi.fn(),
  nativeStart: vi.fn(),
  nativePending: vi.fn(),
  nativeFinalize: vi.fn(),
  nativeCallback: vi.fn(),
  nativePickerStart: vi.fn(),
  nativePickerPending: vi.fn(),
  nativePickerConfirm: vi.fn(),
  nativePickerCancel: vi.fn(),
  nativePickerCallback: vi.fn(),
  disconnectMail: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => state.native },
  };
});
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: state.uid, getIdToken: async () => "firebase" },
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: state.token }),
}));
vi.mock("@/lib/capacitor", () => ({
  HushhAuth: {
    connectDrive: state.nativeDrive,
    pickDriveFiles: state.nativePicker,
  },
}));
vi.mock("@/lib/profile/gmail-connector-store", () => ({
  useGmailConnectorStatus: () => ({
    status: { connected: true, google_email: "mail@example.invalid" },
    disconnectGmail: state.disconnectMail,
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
    startNativePicker: state.nativePickerStart,
    pendingNativePicker: state.nativePickerPending,
    confirmNativePicker: state.nativePickerConfirm,
    cancelNativePicker: state.nativePickerCancel,
    nativeDrivePickerCallbackUri: state.nativePickerCallback,
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
  onPrepareRecovery: vi.fn().mockResolvedValue("ready" as const),
  onClearRecovery: vi.fn().mockResolvedValue(undefined),
});

async function openDriveDetail() {
  await screen.findByRole("button", { name: "Google Drive", exact: true });
  fireEvent.click(screen.getByRole("button", { name: "Google Drive", exact: true }));
  await screen.findByRole("button", { name: "Back to connectors" });
}

function runAnimationFramesImmediately() {
  const request = window.requestAnimationFrame;
  const cancel = window.cancelAnimationFrame;
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 0;
  };
  window.cancelAnimationFrame = () => undefined;
  return () => {
    window.requestAnimationFrame = request;
    window.cancelAnimationFrame = cancel;
  };
}

describe("Connectors owner and mutation fences", () => {
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
    state.nativePicker.mockReset();
    state.nativeStart.mockReset();
    state.nativePending.mockReset();
    state.nativeFinalize.mockReset();
    state.nativeCallback.mockReset();
    state.nativePickerStart.mockReset();
    state.nativePickerPending.mockReset();
    state.nativePickerConfirm.mockReset();
    state.nativePickerCancel.mockReset();
    state.nativePickerCallback.mockReset();
    state.disconnectMail.mockResolvedValue({ connected: false });
    state.nativePending.mockResolvedValue(null);
    state.nativeFinalize.mockResolvedValue({
      connectorId: "google_drive",
      status: "connected",
    });
    state.nativeCallback.mockReturnValue(
      "https://api.example.invalid/api/connectors/oauth/native/callback",
    );
    state.nativePickerPending.mockResolvedValue(null);
    state.nativePickerConfirm.mockResolvedValue({ documents: [] });
    state.nativePickerCancel.mockResolvedValue(undefined);
    state.nativePickerCallback.mockReturnValue(
      "https://api.example.invalid/api/connectors/google_drive/picker/native/callback",
    );
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });
  it("does not carry a Mail disconnect confirmation into Drive details", async () => {
    render(<ConnectorsPanel {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Gmail", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Mail" }));
    expect(screen.getByRole("button", { name: "Confirm", exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to connectors" }));
    await openDriveDetail();
    expect(screen.queryByRole("button", { name: "Confirm", exact: true })).not.toBeInTheDocument();
    expect(state.disconnectMail).not.toHaveBeenCalled();
  });
  it.each([
    ["busy", "Finish the current chat action or allow popups before connecting Drive."],
    ["unavailable", "Your draft could not be saved safely. Allow popups or try again."],
  ])("keeps chat mounted when popup is blocked and recovery is %s", async (readiness, message) => {
    state.overview.mockResolvedValue({
      ...overview(),
      connectors: [{
        connectorId: "google_drive", status: "not_connected", available: true,
        accountLabel: "Only files you choose",
      }],
    });
    state.nativeStart.mockResolvedValue({
      attemptId: "attempt_123456789012",
      connectorId: "google_drive",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    vi.spyOn(window, "open").mockReturnValue(null);
    const p = props();
    p.onPrepareRecovery.mockResolvedValue(readiness);
    render(<ConnectorsPanel {...p} />);
    await openDriveDetail();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Drive" }));
    await screen.findByText(message);
    expect(p.onPrepareRecovery).toHaveBeenCalledWith({
      attemptId: "attempt_123456789012", reason: "web_full_page",
    });
    expect(p.onClearRecovery).not.toHaveBeenCalled();
  });
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
    await openDriveDetail();
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
    await screen.findByText(/new-owner@example\.invalid/);
    await act(async () => {
      stale(overview("old-owner@example.invalid"));
    });
    expect(screen.queryByText(/old-owner@example\.invalid/)).toBeNull();
  });
  it("new connection gate does not disable selected-file management on existing grant", async () => {
    const result = overview();
    result.features.google_drive_connection = false;
    state.overview.mockResolvedValue(result);
    render(<ConnectorsPanel {...props()} />);
    await openDriveDetail();
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
    await openDriveDetail();
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose files" }),
    );
    await waitFor(() => expect(oldPicker).toBeTypeOf("function"));
    state.uid = "owner-b";
    state.token = "vault-b";
    view.rerender(<ConnectorsPanel {...p} />);
    await openDriveDetail();
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
    await openDriveDetail();
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
    await openDriveDetail();
    const connect = await screen.findByRole("button", {
      name: "Connect Drive",
    });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await waitFor(() => expect(state.nativeDrive).toHaveBeenCalledTimes(1));
    expect(p.onPrepareRecovery).toHaveBeenCalledWith({
      attemptId: "attempt_123456789012", reason: "native_oauth",
    });

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

  it("reconciles a restart-safe native connection return and exposes explicit native file selection", async () => {
    state.native = true;
    state.nativePending.mockResolvedValue(null);
    const p = props();
    render(<ConnectorsPanel {...p} />);
    expect(await screen.findByText(/drive@example\.invalid/)).toBeVisible();
    await openDriveDetail();
    expect(screen.getByRole("button", { name: "Choose files" })).toBeEnabled();

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

  it("stages native Picker candidates after an opaque return and never adds them before confirmation", async () => {
    const restoreAnimationFrames = runAnimationFramesImmediately();
    try {
      state.native = true;
      state.overview.mockResolvedValue({
        ...overview(),
        features: {
          ...overview().features,
          drive_document_indexing: true,
        },
      });
      state.nativePickerPending.mockResolvedValue({
        attemptId: "picker_1234567890123",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        files: [
          {
            documentId: "drive_file_123456789012",
            name: "Six months of statements.pdf",
            mimeType: "application/pdf",
          },
        ],
      });
      const p = props();
      render(<ConnectorsPanel {...p} />);
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent("hushh:native-drive-picker-return", {
            detail: { attemptId: "picker_1234567890123", outcome: "ready" },
          }),
        );
      });
      await screen.findByRole("region", { name: "Confirm selected files" });
      expect(screen.getByText("Six months of statements.pdf")).toBeVisible();
      expect(state.nativePickerConfirm).not.toHaveBeenCalled();
      expect(state.documents).not.toHaveBeenCalledWith(
        expect.stringContaining("drive_file"),
      );

      fireEvent.click(
        screen.getByRole("checkbox", {
          name: /allow hushh to process these files/i,
        }),
      );
      const pendingCalls = state.nativePickerPending.mock.calls.length;
      await act(async () => {
        // A native browser bridge and appUrlOpen can report the same opaque
        // completion. The second recovery must not erase explicit processing
        // consent while the owner reviews the exact candidates.
        window.dispatchEvent(
          new CustomEvent("hushh:native-drive-picker-return", {
            detail: { attemptId: "picker_1234567890123", outcome: "ready" },
          }),
        );
      });
      await waitFor(() =>
        expect(state.nativePickerPending.mock.calls.length).toBeGreaterThan(
          pendingCalls,
        ),
      );
      expect(
        screen.getByRole("checkbox", {
          name: /allow hushh to process these files/i,
        }),
      ).toBeChecked();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Add selected files" }),
        ),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Add selected files" }),
      );
      await waitFor(() =>
        expect(state.nativePickerConfirm).toHaveBeenCalledWith(
          expect.objectContaining({
            vaultOwnerToken: "vault-a",
            attemptId: "picker_1234567890123",
            backgroundProcessing: true,
          }),
        ),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("region", { name: "Confirm selected files" }),
        ).toBeNull(),
      );
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Choose files" }),
        ),
      );
    } finally {
      restoreAnimationFrames();
    }
  });

  it("starts the native Picker through the opaque server callback and tolerates a bridge cancellation race", async () => {
    state.native = true;
    state.nativePickerStart.mockResolvedValue({
      attemptId: "picker_1234567890123",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    state.nativePicker.mockResolvedValue({
      attemptId: "picker_1234567890123",
      outcome: "cancelled",
    });
    render(<ConnectorsPanel {...props()} />);
    await openDriveDetail();
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose files" }),
    );
    await waitFor(() =>
      expect(state.nativePickerStart).toHaveBeenCalledWith(
        expect.objectContaining({
          vaultOwnerToken: "vault-a",
          redirectUri:
            "https://api.example.invalid/api/connectors/google_drive/picker/native/callback",
        }),
      ),
    );
    await waitFor(() => expect(state.nativePickerPending).toHaveBeenCalled());
    expect(state.nativePickerConfirm).not.toHaveBeenCalled();
  });

  it("cancels a staged native Picker selection without adding documents", async () => {
    state.native = true;
    state.nativePickerPending.mockResolvedValue({
      attemptId: "picker_1234567890123",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      files: [
        {
          documentId: "drive_file_123456789012",
          name: "Statement.pdf",
          mimeType: "application/pdf",
        },
      ],
    });
    render(<ConnectorsPanel {...props()} />);
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("hushh:native-drive-picker-return", {
          detail: { attemptId: "picker_1234567890123", outcome: "ready" },
        }),
      );
    });
    await screen.findByRole("region", { name: "Confirm selected files" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel selection" }));
    await waitFor(() =>
      expect(state.nativePickerCancel).toHaveBeenCalledWith(
        expect.objectContaining({ attemptId: "picker_1234567890123" }),
      ),
    );
    expect(state.nativePickerConfirm).not.toHaveBeenCalled();
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
    await openDriveDetail();
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

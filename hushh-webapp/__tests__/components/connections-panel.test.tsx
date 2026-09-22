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
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: state.uid, getIdToken: async () => "firebase" },
  }),
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: state.token }),
}));
vi.mock("@/lib/capacitor", () => ({ HushhAuth: {} }));
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
    state.overview.mockResolvedValue(overview());
    state.documents.mockResolvedValue([]);
    state.remove.mockResolvedValue(undefined);
    state.session.mockImplementation(async () => ({
      sessionId: "session",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      accessToken: "ephemeral",
    }));
    state.pick.mockResolvedValue([]);
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
});

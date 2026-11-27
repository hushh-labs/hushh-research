import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiJson: vi.fn(),
  permission: { state: "prompt", precise: null as boolean | null },
  service: {
    getPermissionState: vi.fn(),
    requestLocationPermission: vi.fn(),
    getState: vi.fn(),
    openAppSettings: vi.fn(async () => ({
      opened: false,
      sourcePlatform: "web",
    })),
  },
  bootstrapKey: vi.fn(async () => ({ keyId: "k-me" })),
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ userId: "u1" }) }));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultOwnerToken: "vot", vaultKey: "vk" }),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getAuthHeaders: (token?: string) =>
      token ? { Authorization: `Bearer ${token}` } : {},
  },
  getApiBaseUrl: () => "http://localhost:8000",
}));
vi.mock("@/lib/services/api-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/services/api-client")>();
  return { ...actual, apiJson: mocks.apiJson };
});
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: mocks.service,
}));
vi.mock("@/lib/one-location/location-bus", () => {
  let state = {
    permission: null as string | null,
    status: "idle",
    snapshot: null,
    error: null,
    snapshotOrigin: null,
  };
  const listeners = new Set<(next: typeof state) => void>();
  return {
    LocationBus: {
      subscribe: (listener: (next: typeof state) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getState: () => state,
      syncPermission: vi.fn(async () => {
        state = { ...state, permission: mocks.permission.state };
        for (const listener of listeners) listener(state);
        return mocks.permission.state;
      }),
      invalidate: vi.fn(),
    },
  };
});
vi.mock("@/lib/one-location/key-bootstrap", () => ({
  bootstrapCurrentUserLocationRecipientKey: mocks.bootstrapKey,
}));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: mocks.toast }));

import { LocationSetupFlow } from "@/components/location/setup/location-setup-flow";
import { LocationAccountSettingsResource } from "@/lib/location/account-settings";
import {
  LOCATION_SHARING_CONSENT_VERSION,
  LocationSetupProgressResource,
} from "@/lib/location/setup-progress";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";

type ProgressRow = Record<string, unknown>;

const STEPS = [
  "intro",
  "consent",
  "os_permission",
  "precision",
  "recipient_key",
  "done",
];

function progressRow(overrides: ProgressRow): ProgressRow {
  return {
    user_id: "u1",
    step: "intro",
    consent_version: null,
    consent_accepted_at: null,
    os_permission_state: "unknown",
    precision: null,
    recipient_key_registered_at: null,
    started_at: null,
    completed_at: null,
    steps: STEPS,
    ...overrides,
  };
}

/** Routes apiJson by path/method; PATCHes to setup-progress advance a fake server row. */
function installServer(
  initial: ProgressRow,
  settings: ProgressRow = { sharing_state: "unset", precision: "precise" },
) {
  let row = { ...initial };
  const patches: Array<Record<string, unknown>> = [];
  mocks.apiJson.mockImplementation(
    async (pathname: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (pathname === "/api/one/location/setup-progress") {
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          patches.push(body);
          switch (body.action) {
            case "start":
              row = {
                ...row,
                started_at: row.started_at ?? "2026-09-15T08:59:00Z",
              };
              break;
            case "accept_consent":
              row = {
                ...row,
                step: "consent",
                consent_version: body.consentVersion,
                consent_accepted_at: "2026-09-15T09:00:00Z",
              };
              break;
            case "record_os_permission":
              row = {
                ...row,
                step: "os_permission",
                os_permission_state: body.osPermissionState,
              };
              break;
            case "set_precision":
              // The setup service writes the preference through to account settings.
              row = { ...row, step: "precision", precision: body.precision };
              settings = { ...settings, precision: body.precision };
              break;
            case "confirm_recipient_key":
              row = {
                ...row,
                step: "recipient_key",
                recipient_key_registered_at: "2026-09-15T09:05:00Z",
              };
              break;
            case "complete":
              row = {
                ...row,
                step: "done",
                completed_at: "2026-09-15T09:06:00Z",
              };
              settings = { ...settings, sharing_state: "on" };
              break;
          }
        }
        return { progress: { ...row } };
      }
      if (pathname === "/api/one/location/account-settings") {
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          patches.push({ settings: body });
          settings = {
            ...settings,
            ...(body.precision ? { precision: body.precision } : {}),
          };
        }
        return { settings: { ...settings } };
      }
      if (pathname === "/api/one/location/state") {
        return {
          recipients: [],
          ownerGrants: [],
          receivedGrants: [],
          requests: [],
          referrals: [],
          publicInvites: [],
          publicInviteSubmissions: [],
          capabilityScopes: [],
        };
      }
      throw new Error(`Unexpected request ${method} ${pathname}`);
    },
  );
  return {
    patches,
    current: () => row,
    /** Simulate a change the voice tool made server-side. */
    set: (next: ProgressRow) => {
      row = { ...row, ...next };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.state = "prompt";
  mocks.permission.precise = null;
  mocks.service.getPermissionState.mockImplementation(async () => ({
    state: mocks.permission.state,
    precise: mocks.permission.precise,
    background: "unavailable",
  }));
  mocks.service.getState.mockResolvedValue({
    recipients: [
      {
        userId: "alice",
        displayName: "Alice Example",
        phoneVerified: true,
        keyId: "k",
        publicKeyJwk: { kty: "EC" },
        keyAlgorithm: "x",
        canReceiveLocation: true,
      },
    ],
    ownerGrants: [],
    receivedGrants: [],
    requests: [],
    referrals: [],
    publicInvites: [],
    publicInviteSubmissions: [],
    capabilityScopes: [],
  });
  LocationAccountSettingsResource.__resetForTests();
  LocationSetupProgressResource.__resetForTests();
  OneLocationStateResource.discardAll();
  useVoiceSessionStore.getState().reset();
  useVoiceSessionStore.getState().effects.clear();
});

afterEach(() => {
  useVoiceSessionStore.getState().effects.clear();
});

describe("LocationSetupFlow", () => {
  it("resumes at the persisted step after a reload (server is the source of truth)", async () => {
    installServer(
      progressRow({
        step: "os_permission",
        started_at: "2026-09-15T08:59:00Z",
        consent_accepted_at: "2026-09-15T09:00:00Z",
        os_permission_state: "granted",
      }),
    );
    const onReady = vi.fn();
    render(<LocationSetupFlow mode="setup" onSetupReadinessChange={onReady} />);
    // Jumps straight past intro/consent/permission to precision.
    expect(
      await screen.findByTestId("location-setup-precision"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("location-setup-intro"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("location-setup-flow").getAttribute("data-setup-step"),
    ).toBe("precision");
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(true));
    // Header contract: eyebrow + title, no back arrow.
    expect(
      screen.getByRole("heading", { level: 1, name: "Location setup" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /back/i }),
    ).not.toBeInTheDocument();
    // The honest precision sentence is on screen.
    expect(
      screen.getByTestId("location-setup-precision-note").textContent,
    ).toContain("Approximate is applied on this device before it's encrypted.");
  });

  it("shows the intro when setup has never started and starts it with the same PATCH the tool uses", async () => {
    const server = installServer(progressRow({}));
    render(<LocationSetupFlow mode="setup" />);
    expect(
      await screen.findByTestId("location-setup-intro"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("location-setup-start"));
    expect(
      await screen.findByTestId("location-setup-consent"),
    ).toBeInTheDocument();
    expect(server.patches[0]).toEqual({ action: "start" });
  });

  it("records consent with the on-screen version, then reaches the device permission step", async () => {
    const server = installServer(
      progressRow({ started_at: "2026-09-15T08:59:00Z" }),
    );
    render(<LocationSetupFlow mode="setup" />);
    expect(
      await screen.findByTestId("location-setup-consent"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(LOCATION_SHARING_CONSENT_VERSION),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("location-setup-consent-accept"));
    expect(
      await screen.findByTestId("location-setup-os-permission"),
    ).toBeInTheDocument();
    expect(server.patches[0]).toEqual({
      action: "accept_consent",
      consentVersion: LOCATION_SHARING_CONSENT_VERSION,
    });
    // Consent is now recorded, so the prompt button is live.
    await waitFor(() =>
      expect(
        screen.getByTestId("location-setup-os-request"),
      ).not.toBeDisabled(),
    );
  });

  it("disables the OS-permission button until the server holds consent_accepted_at", async () => {
    // A row on the permission screen without a recorded consent (fail closed).
    installServer(
      progressRow({
        step: "consent",
        started_at: "2026-09-15T08:59:00Z",
        consent_accepted_at: null,
      }),
    );
    render(<LocationSetupFlow mode="setup" />);
    const button = await screen.findByTestId("location-setup-os-request");
    expect(button).toBeDisabled();
    expect(
      screen.getByTestId("location-setup-os-consent-hint"),
    ).toBeInTheDocument();
    fireEvent.click(button);
    expect(mocks.service.requestLocationPermission).not.toHaveBeenCalled();
    // Device permission is its own row, never described as sharing.
    expect(
      screen.getByTestId("location-setup-os-permission-value").textContent,
    ).toBe("Not asked yet");
  });

  it("asks the device only after consent, records the answer, and moves to precision", async () => {
    const server = installServer(
      progressRow({
        step: "consent",
        started_at: "2026-09-15T08:59:00Z",
        consent_accepted_at: "2026-09-15T09:00:00Z",
      }),
    );
    mocks.service.requestLocationPermission.mockImplementation(async () => {
      mocks.permission.state = "granted";
      mocks.permission.precise = true;
      return { state: "granted", precise: true, background: "foreground-only" };
    });
    render(<LocationSetupFlow mode="setup" />);
    const button = await screen.findByTestId("location-setup-os-request");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(
      await screen.findByTestId("location-setup-precision"),
    ).toBeInTheDocument();
    expect(mocks.service.requestLocationPermission).toHaveBeenCalledTimes(1);
    expect(server.patches).toContainEqual({
      action: "record_os_permission",
      osPermissionState: "granted",
    });
  });

  it("keeps a denied device on the permission screen with the recovery guide", async () => {
    const server = installServer(
      progressRow({
        step: "consent",
        started_at: "2026-09-15T08:59:00Z",
        consent_accepted_at: "2026-09-15T09:00:00Z",
      }),
    );
    mocks.service.requestLocationPermission.mockImplementation(async () => {
      mocks.permission.state = "denied";
      return { state: "denied", precise: null, background: "unavailable" };
    });
    render(<LocationSetupFlow mode="setup" />);
    const button = await screen.findByTestId("location-setup-os-request");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(
      await screen.findByTestId("location-setup-recovery-guide"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("location-setup-os-permission"),
    ).toBeInTheDocument();
    expect(
      server.patches.some((patch) => patch.action === "record_os_permission"),
    ).toBe(false);
    fireEvent.click(screen.getByTestId("location-setup-os-continue-anyway"));
    expect(
      await screen.findByTestId("location-setup-precision"),
    ).toBeInTheDocument();
    expect(server.patches).toContainEqual({
      action: "record_os_permission",
      osPermissionState: "denied",
    });
  });

  it("saves precision, registers the device key, shows people by name, then finishes and turns sharing on", async () => {
    const server = installServer(
      progressRow({
        step: "os_permission",
        started_at: "2026-09-15T08:59:00Z",
        consent_accepted_at: "2026-09-15T09:00:00Z",
        os_permission_state: "granted",
      }),
    );
    mocks.permission.state = "granted";
    const onComplete = vi.fn(async () => undefined);
    render(<LocationSetupFlow mode="setup" onSetupComplete={onComplete} />);
    await screen.findByTestId("location-setup-precision");
    fireEvent.click(screen.getByTestId("location-setup-precision-approximate"));
    fireEvent.click(screen.getByTestId("location-setup-precision-continue"));

    // Key step runs by itself and advances.
    expect(
      await screen.findByTestId("location-setup-people"),
    ).toBeInTheDocument();
    expect(mocks.bootstrapKey).toHaveBeenCalledWith({
      userId: "u1",
      vaultOwnerToken: "vot",
      vaultKey: "vk",
    });
    expect(server.patches).toContainEqual({
      action: "set_precision",
      precision: "approximate",
    });
    expect(server.patches).toContainEqual({ action: "confirm_recipient_key" });

    // People are server names only; no id is rendered.
    expect(await screen.findByText("Alice Example")).toBeInTheDocument();
    expect(screen.queryByText("alice")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("location-setup-people-continue"));

    expect(
      await screen.findByTestId("location-setup-done"),
    ).toBeInTheDocument();
    // Before finishing, app sharing is never described as on.
    expect(
      screen.getByTestId("location-setup-done-row-app").textContent,
    ).toContain("Turns on when you finish");
    expect(
      screen.getByTestId("location-setup-done-row-device").textContent,
    ).toContain("Allowed");
    expect(
      screen.getByTestId("location-setup-done-row-precision").textContent,
    ).toContain("Approximate");

    fireEvent.click(screen.getByTestId("location-setup-finish"));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(server.patches).toContainEqual({ action: "complete" });
    expect(server.current().step).toBe("done");
  });

  it("follows a voice tool result: a recorded consent moves the screen without a tap", async () => {
    const server = installServer(
      progressRow({ started_at: "2026-09-15T08:59:00Z" }),
    );
    render(<LocationSetupFlow mode="setup" />);
    expect(
      await screen.findByTestId("location-setup-consent"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
    );
    // The tool ran server-side (tap-confirmed); its result carries the new row.
    server.set({
      step: "consent",
      consent_version: LOCATION_SHARING_CONSENT_VERSION,
      consent_accepted_at: "2026-09-15T09:00:00Z",
    });
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitToolResult("accept_location_setup_consent", {
          status: "accepted",
          current_step: "os_permission",
          consent_version: LOCATION_SHARING_CONSENT_VERSION,
          progress: progressRow({
            step: "consent",
            started_at: "2026-09-15T08:59:00Z",
            consent_version: LOCATION_SHARING_CONSENT_VERSION,
            consent_accepted_at: "2026-09-15T09:00:00Z",
          }),
          ui_refresh: ["location_setup"],
        });
    });
    expect(
      await screen.findByTestId("location-setup-os-permission"),
    ).toBeInTheDocument();
  });

  it("never renders success from transcript text: an unrelated tool result changes nothing", async () => {
    installServer(progressRow({ started_at: "2026-09-15T08:59:00Z" }));
    render(<LocationSetupFlow mode="setup" />);
    expect(
      await screen.findByTestId("location-setup-consent"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(useVoiceSessionStore.getState().effects.size).toBeGreaterThan(0),
    );
    await act(async () => {
      useVoiceSessionStore
        .getState()
        .emitToolResult("get_location_status", {
          status: "ok",
          sharing_state: "on",
        });
    });
    expect(screen.getByTestId("location-setup-consent")).toBeInTheDocument();
  });
});

describe("LocationSetupFlow header contract (source scan)", () => {
  const SOURCE = fs.readFileSync(
    path.resolve(__dirname, "../setup/location-setup-flow.tsx"),
    "utf8",
  );

  it("renders inside the shell with the Location eyebrow and no back control", () => {
    expect(SOURCE).not.toContain("fixed inset-0");
    expect(SOURCE).not.toMatch(/\bz-\[\d+\]/);
    expect(SOURCE).not.toContain("100dvh");
    expect(SOURCE).toContain('eyebrow="Location"');
    expect(SOURCE).toContain('title="Location setup"');
    expect(SOURCE).not.toContain("<h1");
    expect(SOURCE).not.toContain("ChevronLeft");
    expect(SOURCE).not.toContain("onBack=");
    expect(SOURCE).not.toContain("sessionStorage");
    expect(SOURCE).not.toContain("fetch(");
  });
});
